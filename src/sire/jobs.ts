import type { Db } from "../db/index.js";

export type TipoJob = "poll_ticket" | "download_ticket_file" | "parse_ticket_file";

export type Job = {
  id: number;
  tenant_id: number | null;
  tipo: TipoJob;
  payload: Record<string, unknown>;
  intentos: number;
  max_intentos: number;
};

export interface NuevoJob {
  tenantId: number;
  tipo: TipoJob;
  payload: Record<string, unknown>;
  /** En cuántos milisegundos debe ejecutarse (por defecto, ya). */
  enMs?: number;
  maxIntentos?: number;
}

/** Un trabajo "colgado" (el proceso murió a la mitad) se vuelve a poner en cola pasado este tiempo. */
const RECUPERAR_TRAS_MS = 10 * 60_000;

/** Cola de trabajos en Postgres: sin Redis, y con `FOR UPDATE SKIP LOCKED` varios workers no se pisan. */
export class JobQueue {
  constructor(private readonly db: Db) {}

  async encolar(j: NuevoJob, db: Db = this.db): Promise<number> {
    const filas = await db.query<{ id: number }>(
      `insert into jobs (tenant_id, tipo, payload, max_intentos, ejecutar_en)
       values ($1, $2, $3::jsonb, $4, now() + ($5::int * interval '1 millisecond'))
       returning id`,
      [j.tenantId, j.tipo, JSON.stringify(j.payload), j.maxIntentos ?? 10, j.enMs ?? 0],
    );
    return filas[0]!.id;
  }

  /** Toma el siguiente trabajo listo, o null si no hay. */
  async reclamar(): Promise<Job | null> {
    const filas = await this.db.query<Job>(
      `update jobs set estado = 'running', bloqueado_en = now(), intentos = intentos + 1
       where id = (
         select id from jobs
         where estado = 'queued' and ejecutar_en <= now()
         order by ejecutar_en, id
         limit 1
         for update skip locked
       )
       returning id, tenant_id, tipo, payload, intentos, max_intentos`,
    );
    return filas[0] ?? null;
  }

  async terminar(id: number): Promise<void> {
    await this.db.query(`update jobs set estado = 'done', finished_at = now(), bloqueado_en = null where id = $1`, [id]);
  }

  /**
   * El trabajo falló. Si todavía le quedan intentos se vuelve a poner en cola con espera creciente
   * (15 s, 30 s, 1 min… hasta 15 min); si no, queda como fallido con su motivo.
   */
  async fallar(job: Job, motivo: string, definitivo = false): Promise<void> {
    if (definitivo || job.intentos >= job.max_intentos) {
      await this.db.query(
        `update jobs set estado = 'failed', ultimo_error = $2, finished_at = now(), bloqueado_en = null where id = $1`,
        [job.id, motivo.slice(0, 2000)],
      );
      return;
    }
    const esperaMs = Math.min(15_000 * 2 ** (job.intentos - 1), 15 * 60_000);
    await this.db.query(
      `update jobs set estado = 'queued', ultimo_error = $2, bloqueado_en = null,
         ejecutar_en = now() + ($3::int * interval '1 millisecond')
       where id = $1`,
      [job.id, motivo.slice(0, 2000), esperaMs],
    );
  }

  /** Reprograma el MISMO trabajo para más tarde sin gastar un intento (por ejemplo, el ticket sigue "en proceso"). */
  async reprogramar(job: Job, enMs: number): Promise<void> {
    await this.db.query(
      `update jobs set estado = 'queued', intentos = greatest(intentos - 1, 0), bloqueado_en = null,
         ejecutar_en = now() + ($2::int * interval '1 millisecond')
       where id = $1`,
      [job.id, enMs],
    );
  }

  async recuperarColgados(): Promise<number> {
    const filas = await this.db.query(
      `update jobs set estado = 'queued', bloqueado_en = null
       where estado = 'running' and bloqueado_en < now() - ($1::int * interval '1 millisecond')
       returning id`,
      [RECUPERAR_TRAS_MS],
    );
    return filas.length;
  }
}
