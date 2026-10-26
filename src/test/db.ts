import { PGlite } from "@electric-sql/pglite";
import type { Db, Row } from "../db/index.js";
import { migrate } from "../db/migrate.js";

type Ejecutor = Pick<PGlite, "query" | "exec">;

class PgliteDb implements Db {
  constructor(
    private readonly e: Ejecutor,
    private readonly pg: PGlite,
    private readonly enTransaccion: boolean,
  ) {}

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.e.query<T>(sql, params as unknown[]);
    return r.rows;
  }

  async exec(sql: string): Promise<void> {
    await this.e.exec(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.enTransaccion) return fn(this);
    return this.pg.transaction((t) => fn(new PgliteDb(t as unknown as Ejecutor, this.pg, true)));
  }

  async close(): Promise<void> {
    if (!this.enTransaccion) await this.pg.close();
  }
}

/** Un Postgres real en memoria con todas las migraciones aplicadas. Solo para pruebas. */
export async function crearDbPrueba(): Promise<Db> {
  const pg = new PGlite({
    // Igual que en producción: bigint -> number y date -> "AAAA-MM-DD".
    parsers: { 20: (v: string) => Number(v), 1082: (v: string) => v },
  });
  const db = new PgliteDb(pg, pg, false);
  await migrate(db);
  return db;
}
