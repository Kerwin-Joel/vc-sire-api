import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Job, JobQueue } from "./jobs.js";
import type { TicketService } from "./tickets.js";

/** Errores que reintentar no arregla (credenciales malas, archivo con otro formato…): el trabajo falla de una vez. */
const SIN_REINTENTO = new Set([
  "credenciales_rechazadas",
  "faltan_credenciales",
  "sunat_live_desactivado",
  "escritura_deshabilitada",
  "formato_inesperado",
  "zip_invalido",
  "zip_sin_txt",
  "archivo_vacio",
  "tenant_no_encontrado",
]);

/** Cuánto esperar antes de volver a preguntar por un ticket que sigue en proceso. SUNAT suele tardar de segundos a pocos minutos. */
export function esperaSondeoMs(intentos: number): number {
  if (intentos <= 3) return 5_000;
  if (intentos <= 8) return 10_000;
  if (intentos <= 20) return 30_000;
  return 60_000;
}

export interface WorkerOpciones {
  queue: JobQueue;
  tickets: TicketService;
  log: Logger;
  maxSondeos: number;
  intervaloMs: number;
  /** Si se indica, se usa siempre esta espera entre consultas de un ticket (pruebas). */
  esperaFijaMs?: number;
}

export class Worker {
  private activo = false;
  private temporizador: NodeJS.Timeout | null = null;

  constructor(private readonly o: WorkerOpciones) {}

  /** Ejecuta un trabajo si hay uno listo. Devuelve true si hizo algo. */
  async procesarUno(): Promise<boolean> {
    const job = await this.o.queue.reclamar();
    if (!job) return false;
    try {
      await this.ejecutar(job);
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      const definitivo = e instanceof AppError && !!e.codigo && SIN_REINTENTO.has(e.codigo);
      this.o.log.warn({ job: job.id, tipo: job.tipo, motivo, definitivo }, "trabajo falló");
      const ticketId = Number((job.payload as { ticketId?: number }).ticketId);
      if (Number.isFinite(ticketId)) await this.o.tickets.marcarError(ticketId, motivo).catch(() => undefined);
      await this.o.queue.fallar(job, motivo, definitivo);
    }
    return true;
  }

  /** Ejecuta trabajos hasta que no quede ninguno listo (o se llegue al tope). Útil en pruebas. */
  async procesarPendientes(tope = 200): Promise<number> {
    let n = 0;
    while (n < tope && (await this.procesarUno())) n++;
    return n;
  }

  private async ejecutar(job: Job): Promise<void> {
    const ticketId = Number((job.payload as { ticketId?: number }).ticketId);
    switch (job.tipo) {
      case "poll_ticket": {
        const { final, ticket } = await this.o.tickets.sondear(ticketId);
        if (final) {
          await this.o.queue.terminar(job.id);
          return;
        }
        if (ticket.poll_attempts >= this.o.maxSondeos) {
          const msg = `SUNAT no terminó el ticket después de ${ticket.poll_attempts} consultas.`;
          await this.o.tickets.marcarError(ticketId, msg);
          await this.o.queue.fallar(job, msg, true);
          return;
        }
        await this.o.queue.reprogramar(job, this.o.esperaFijaMs ?? esperaSondeoMs(ticket.poll_attempts));
        return;
      }
      case "download_ticket_file":
        await this.o.tickets.descargar(ticketId);
        await this.o.queue.terminar(job.id);
        return;
      case "parse_ticket_file": {
        const n = await this.o.tickets.leerPropuestaDescargada(ticketId);
        this.o.log.info({ ticketId, comprobantes: n }, "propuesta leída");
        await this.o.queue.terminar(job.id);
        return;
      }
      default:
        throw new AppError(`Tipo de trabajo desconocido: ${String(job.tipo)}`, 500, "tipo_desconocido");
    }
  }

  iniciar(): void {
    if (this.activo) return;
    this.activo = true;
    const vuelta = async () => {
      if (!this.activo) return;
      let hizo = false;
      try {
        await this.o.queue.recuperarColgados();
        hizo = await this.procesarUno();
      } catch (e) {
        this.o.log.error({ err: e instanceof Error ? e.message : String(e) }, "error en el ciclo del worker");
      }
      // Si acaba de trabajar, vuelve enseguida (puede haber más); si no, espera.
      this.temporizador = setTimeout(() => void vuelta(), hizo ? 0 : this.o.intervaloMs);
    };
    void vuelta();
  }

  detener(): void {
    this.activo = false;
    if (this.temporizador) clearTimeout(this.temporizador);
  }
}
