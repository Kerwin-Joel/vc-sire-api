import type { Db, Row } from "../db/index.js";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { FileStorage } from "../storage.js";
import type { Libro, SireClient, TicketSunat } from "../sunat/sire.js";
import type { ComprobanteRepo } from "./comprobantes.js";
import type { JobQueue } from "./jobs.js";
import { leerPropuesta } from "./parsers/index.js";
import type { Tenant, TenantRepo } from "./tenants.js";

export interface TicketFila extends Row {
  id: number;
  tenant_id: number;
  libro: Libro;
  num_ticket: string;
  per_tributario: string;
  proposito: "propuesta" | "otro";
  cod_proceso: string | null;
  des_proceso: string | null;
  cod_estado: string | null;
  des_estado: string | null;
  nom_archivo_reporte: string | null;
  cod_tipo_archivo_reporte: string | null;
  cnt_filas_validadas: number | null;
  cnt_cp_informados: number | null;
  cnt_cp_error: number | null;
  archivo_path: string | null;
  poll_attempts: number;
  last_polled_at: string | null;
  finished_at: string | null;
  ultimo_error: string | null;
  respuesta_sunat: unknown;
  created_at: string;
}

const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * ¿El ticket ya terminó y cómo? Se decide por lo que SUNAT dice ("Terminado", "Procesado sin errores"…) y, si no dice
 * nada reconocible, por el código (06 y 04 = terminado bien; 03 = terminado con errores). RCE y RVIE no usan los
 * mismos códigos para todo, por eso la descripción manda.
 */
export function clasificarEstado(cod: string | null, des: string | null): { finalizado: boolean; exitoso: boolean } {
  const d = sinTildes(des ?? "");
  if (/sin errores|terminad|concluid/.test(d)) return { finalizado: true, exitoso: true };
  if (/con errores|rechaz|fallid|error/.test(d)) return { finalizado: true, exitoso: false };
  if (/cargad|validando|en proceso|solicitad|pendient|procesando/.test(d)) return { finalizado: false, exitoso: false };
  if (cod === "06" || cod === "04") return { finalizado: true, exitoso: true };
  if (cod === "03") return { finalizado: true, exitoso: false };
  return { finalizado: false, exitoso: false };
}

export interface Dependencias {
  db: Db;
  sire: SireClient;
  queue: JobQueue;
  tenants: TenantRepo;
  comprobantes: ComprobanteRepo;
  storage: FileStorage;
  log: Logger;
  maxSondeos: number;
  primerSondeoMs: number;
}

export interface FiltroTickets {
  periodo?: string;
  finalizado?: boolean;
  estado?: string;
  codProceso?: string;
  pagina: number;
  porPagina: number;
}

/** Todo lo que tiene que ver con los tickets de SUNAT: pedirlos, seguirlos, bajar su archivo y leerlo. */
export class TicketService {
  constructor(private readonly d: Dependencias) {}

  private libroDeTicket(t: TicketFila): Libro {
    return t.libro;
  }

  private async buscar(tenantId: number, numTicket: string): Promise<TicketFila> {
    const t = (await this.d.db.query<TicketFila>("select * from sire_tickets where tenant_id = $1 and num_ticket = $2", [tenantId, numTicket]))[0];
    if (!t) throw new AppError("No se encontró ese ticket.", 404, "ticket_no_encontrado");
    return t;
  }

  async porId(id: number): Promise<TicketFila> {
    const t = (await this.d.db.query<TicketFila>("select * from sire_tickets where id = $1", [id]))[0];
    if (!t) throw new AppError("No se encontró ese ticket.", 404, "ticket_no_encontrado");
    return t;
  }

  /**
   * Pide a SUNAT la propuesta de un período. SUNAT la prepara aparte y devuelve un número de ticket; un trabajo en
   * segundo plano sigue el ticket, baja el archivo y lo lee. (Es una LECTURA: no modifica nada en el SIRE.)
   */
  async solicitarPropuesta(tenant: Tenant, libro: Libro, periodo: string): Promise<TicketFila> {
    const cred = this.d.tenants.credenciales(tenant);
    const numTicket = await this.d.sire.exportarPropuesta(cred, libro, periodo);
    const t = await this.d.db.tx(async (tx) => {
      const fila = (
        await tx.query<TicketFila>(
          `insert into sire_tickets (tenant_id, libro, num_ticket, per_tributario, proposito, cod_estado, des_estado)
           values ($1, $2, $3, $4, 'propuesta', '01', 'Cargado (solicitado)')
           on conflict (tenant_id, num_ticket) do update set updated_at = now()
           returning *`,
          [tenant.id, libro, numTicket, periodo],
        )
      )[0]!;
      await this.d.queue.encolar({ tenantId: tenant.id, tipo: "poll_ticket", payload: { ticketId: fila.id }, enMs: this.d.primerSondeoMs }, tx);
      return fila;
    });
    return t;
  }

  async listar(tenantId: number, f: FiltroTickets) {
    const donde = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];
    const agregar = (cond: string, v: unknown) => {
      params.push(v);
      donde.push(cond.replace("?", `$${params.length}`));
    };
    if (f.periodo) agregar("per_tributario = ?", f.periodo);
    if (f.estado) agregar("cod_estado = ?", f.estado);
    if (f.codProceso) agregar("cod_proceso = ?", f.codProceso);
    if (f.finalizado === true) donde.push("finished_at is not null");
    if (f.finalizado === false) donde.push("finished_at is null");

    const where = donde.join(" and ");
    const total = Number((await this.d.db.query<{ n: number }>(`select count(*)::int as n from sire_tickets where ${where}`, params))[0]!.n);
    const data = await this.d.db.query<TicketFila>(
      `select * from sire_tickets where ${where} order by created_at desc, id desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, f.porPagina, (f.pagina - 1) * f.porPagina],
    );
    return { current_page: f.pagina, per_page: f.porPagina, last_page: Math.max(1, Math.ceil(total / f.porPagina)), total, data };
  }

  async obtener(tenantId: number, numTicket: string): Promise<TicketFila> {
    return this.buscar(tenantId, numTicket);
  }

  /** Aplica a la base lo que SUNAT dijo del ticket; si ya terminó, marca la hora de cierre. */
  private async aplicarEstado(t: TicketFila, s: TicketSunat): Promise<TicketFila> {
    const { finalizado } = clasificarEstado(s.codEstado, s.desEstado);
    const archivo = s.archivos[0] ?? null;
    const filas = await this.d.db.query<TicketFila>(
      `update sire_tickets set
         cod_proceso = $2, des_proceso = $3, cod_estado = $4, des_estado = $5,
         nom_archivo_reporte = coalesce($6, nom_archivo_reporte),
         cod_tipo_archivo_reporte = coalesce($7, cod_tipo_archivo_reporte),
         cnt_filas_validadas = $8, cnt_cp_informados = $9, cnt_cp_error = $10,
         respuesta_sunat = $11::jsonb,
         poll_attempts = poll_attempts + 1, last_polled_at = now(),
         finished_at = case when $12 then coalesce(finished_at, now()) else finished_at end,
         ultimo_error = null, updated_at = now()
       where id = $1 returning *`,
      [
        t.id,
        s.codProceso || t.cod_proceso,
        s.desProceso || t.des_proceso,
        s.codEstado,
        s.desEstado,
        s.nomArchivoReporte,
        archivo?.codTipo ?? null,
        s.cntFilasValidadas,
        s.cntCpInformados,
        s.cntCpError,
        JSON.stringify(s.crudo ?? null),
        finalizado,
      ],
    );
    return filas[0]!;
  }

  /** Consulta a SUNAT el estado del ticket y lo guarda. Devuelve el ticket actualizado. */
  async refrescar(tenant: Tenant, numTicket: string): Promise<TicketFila> {
    const t = await this.buscar(tenant.id, numTicket);
    if (t.finished_at && (t.archivo_path || !t.nom_archivo_reporte)) return t; // ya terminó y no falta nada: no se molesta a SUNAT
    const estado = await this.d.sire.estadoTicket(this.d.tenants.credenciales(tenant), this.libroDeTicket(t), t.per_tributario, t.num_ticket);
    if (!estado) throw new AppError("SUNAT no reconoce ese ticket (todavía).", 404, "ticket_desconocido_sunat");
    const actualizado = await this.aplicarEstado(t, estado);
    if (clasificarEstado(estado.codEstado, estado.desEstado).finalizado) await this.encolarDescargaSiCorresponde(actualizado);
    return actualizado;
  }

  /** Paso del trabajo en segundo plano: consulta y devuelve si el ticket ya terminó. */
  async sondear(ticketId: number): Promise<{ final: boolean; ticket: TicketFila }> {
    const t = await this.porId(ticketId);
    const tenant = await this.d.tenants.porId(t.tenant_id);
    if (!tenant) throw new AppError("La empresa del ticket ya no existe.", 404, "tenant_no_encontrado");
    const estado = await this.d.sire.estadoTicket(this.d.tenants.credenciales(tenant), t.libro, t.per_tributario, t.num_ticket);
    if (!estado) return { final: false, ticket: t };
    const actualizado = await this.aplicarEstado(t, estado);
    const { finalizado } = clasificarEstado(estado.codEstado, estado.desEstado);
    if (finalizado) await this.encolarDescargaSiCorresponde(actualizado);
    return { final: finalizado, ticket: actualizado };
  }

  private async encolarDescargaSiCorresponde(t: TicketFila): Promise<void> {
    // Un ticket "con errores" también deja un archivo (el reporte de errores) que conviene guardar.
    if (!t.nom_archivo_reporte || t.archivo_path) return;
    await this.d.queue.encolar({ tenantId: t.tenant_id, tipo: "download_ticket_file", payload: { ticketId: t.id } });
  }

  /** Baja el archivo que SUNAT dejó para el ticket y lo guarda. */
  async descargar(ticketId: number): Promise<TicketFila> {
    const t = await this.porId(ticketId);
    if (t.archivo_path) return t;
    const tenant = await this.d.tenants.porId(t.tenant_id);
    if (!tenant) throw new AppError("La empresa del ticket ya no existe.", 404, "tenant_no_encontrado");
    const s = await this.d.sire.estadoTicket(this.d.tenants.credenciales(tenant), t.libro, t.per_tributario, t.num_ticket);
    const archivo = s?.archivos[0];
    if (!s || !archivo) throw new AppError("SUNAT no indicó ningún archivo para este ticket.", 404, "sin_archivo");

    const r = await this.d.sire.descargarArchivoReporte(this.d.tenants.credenciales(tenant), t.libro, s, archivo);
    const seguro = archivo.nombre.replace(/[^A-Za-z0-9._-]/g, "_");
    const ruta = `tenant-${t.tenant_id}/${t.per_tributario}/${t.num_ticket}-${seguro}`;
    await this.d.storage.guardar(ruta, r.bytes);
    const filas = await this.d.db.query<TicketFila>(
      "update sire_tickets set archivo_path = $2, updated_at = now() where id = $1 returning *",
      [t.id, ruta],
    );
    const actualizado = filas[0]!;
    if (actualizado.proposito === "propuesta") {
      await this.d.queue.encolar({ tenantId: t.tenant_id, tipo: "parse_ticket_file", payload: { ticketId: t.id } });
    }
    return actualizado;
  }

  /** Lee el archivo de una propuesta ya descargada y deja sus comprobantes listos para consultar. */
  async leerPropuestaDescargada(ticketId: number): Promise<number> {
    const t = await this.porId(ticketId);
    if (!t.archivo_path) throw new AppError("El ticket todavía no tiene archivo descargado.", 409, "sin_archivo");
    const bytes = await this.d.storage.leer(t.archivo_path);
    const filas = leerPropuesta(t.libro, bytes);
    return this.d.comprobantes.reemplazar(t.tenant_id, t.libro, t.per_tributario, "propuesta", t.id, filas);
  }

  async marcarError(ticketId: number, mensaje: string): Promise<void> {
    await this.d.db.query("update sire_tickets set ultimo_error = $2, updated_at = now() where id = $1", [ticketId, mensaje.slice(0, 1000)]);
  }

  /** Para la descarga desde el portal: el archivo ya guardado (no consulta a SUNAT). */
  async archivoGuardado(tenantId: number, numTicket: string): Promise<{ bytes: Uint8Array; nombre: string }> {
    const t = await this.buscar(tenantId, numTicket);
    if (!t.archivo_path) {
      throw new AppError(`El archivo aún no está disponible. Revisa el estado del ticket ${numTicket}.`, 409, "archivo_no_disponible");
    }
    if (!(await this.d.storage.existe(t.archivo_path))) throw new AppError("El archivo guardado ya no se encuentra.", 404, "archivo_perdido");
    return { bytes: await this.d.storage.leer(t.archivo_path), nombre: t.nom_archivo_reporte ?? `ticket-${numTicket}.zip` };
  }
}
