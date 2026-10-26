import pg from "pg";

export type Row = Record<string, unknown>;

/**
 * Acceso mínimo a Postgres. En producción lo implementa `pg`; en las pruebas, PGlite (un Postgres real en memoria),
 * así las mismas consultas SQL se prueban sin levantar ningún servidor.
 */
export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Ejecuta varias sentencias sin parámetros (migraciones). */
  exec(sql: string): Promise<void>;
  /** Todo lo que se haga dentro de `fn` ocurre en una sola transacción. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// bigint -> number (los ids son chicos) y date -> "AAAA-MM-DD" (sin corrimientos por zona horaria).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

class PgDb implements Db {
  constructor(
    private readonly runner: pg.Pool | pg.PoolClient,
    private readonly pool: pg.Pool,
    private readonly enTransaccion: boolean,
  ) {}

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.runner.query(sql, params as unknown[]);
    return res.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.runner.query(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.enTransaccion) return fn(this); // ya estamos dentro de una
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(new PgDb(client, this.pool, true));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (!this.enTransaccion) await this.pool.end();
  }
}

export function createPgDb(connectionString: string, opciones: { max?: number } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opciones.max ?? 10,
    idleTimeoutMillis: 30_000,
    // La mayoría de Postgres administrados (Supabase, Neon, Railway…) exigen SSL; se activa con ?sslmode=require.
  });
  return new PgDb(pool, pool, false);
}
