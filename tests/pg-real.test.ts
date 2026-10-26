import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { JobQueue } from "../src/sire/jobs.js";
import { ComprobanteRepo } from "../src/sire/comprobantes.js";

/**
 * Prueba el adaptador REAL de producción (el cliente `pg` hablando el protocolo de Postgres por red), no solo PGlite
 * directo. Se levanta un Postgres en memoria expuesto por un puerto local.
 */
async function puertoLibre(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe("adaptador de Postgres de producción (pg)", () => {
  let servidor: PGLiteSocketServer;
  let pglite: PGlite;
  let db: Db;

  beforeAll(async () => {
    pglite = new PGlite();
    const puerto = await puertoLibre();
    servidor = new PGLiteSocketServer({ db: pglite, port: puerto, host: "127.0.0.1" });
    await servidor.start();
    db = createPgDb(`postgres://postgres:postgres@127.0.0.1:${puerto}/postgres`, { max: 1 });
  });

  afterAll(async () => {
    await db?.close();
    await servidor?.stop();
    await pglite?.close();
  });

  it("aplica las migraciones y no las repite", async () => {
    expect(await migrate(db)).toEqual(["001_init.sql"]);
    expect(await migrate(db)).toEqual([]);
  });

  it("devuelve bigint como número y date como texto AAAA-MM-DD", async () => {
    const [fila] = await db.query<{ n: number; d: string }>("select 42::bigint as n, '2026-09-05'::date as d");
    expect(fila).toEqual({ n: 42, d: "2026-09-05" });
  });

  it("una transacción que falla no deja nada a medias", async () => {
    await expect(
      db.tx(async (t) => {
        await t.query("insert into tenants (ruc, razon_social, api_key, api_secret_hash) values ('20111111111', 'A', 'k1', 'h')");
        throw new Error("falla a propósito");
      }),
    ).rejects.toThrow("falla a propósito");
    expect(await db.query("select 1 from tenants where ruc = '20111111111'")).toHaveLength(0);
  });

  it("una transacción correcta se guarda", async () => {
    await db.tx(async (t) => {
      await t.query("insert into tenants (ruc, razon_social, api_key, api_secret_hash) values ('20222222222', 'B', 'k2', 'h')");
    });
    expect(await db.query("select 1 from tenants where ruc = '20222222222'")).toHaveLength(1);
  });

  it("la cola de trabajos toma cada trabajo una sola vez y respeta la hora programada", async () => {
    const [{ id }] = (await db.query<{ id: number }>("select id from tenants where ruc = '20222222222'")) as [{ id: number }];
    const cola = new JobQueue(db);
    await cola.encolar({ tenantId: id, tipo: "poll_ticket", payload: { ticketId: 1 } });
    await cola.encolar({ tenantId: id, tipo: "poll_ticket", payload: { ticketId: 2 }, enMs: 60_000 });
    const a = await cola.reclamar();
    expect(a?.payload).toEqual({ ticketId: 1 });
    expect(a?.intentos).toBe(1);
    expect(await cola.reclamar()).toBeNull(); // el segundo está programado a futuro
    await cola.terminar(a!.id);
  });

  it("reemplaza una propuesta completa con inserciones por lotes", async () => {
    const [{ id }] = (await db.query<{ id: number }>("select id from tenants where ruc = '20222222222'")) as [{ id: number }];
    const repo = new ComprobanteRepo(db);
    const filas = Array.from({ length: 950 }, (_, i) => ({
      carSunat: null,
      fecEmision: "2026-09-05",
      fecVcto: null,
      codTipoCdp: "01",
      numSerieCdp: "F001",
      numCdp: String(i + 1),
      codTipoDocContraparte: "6",
      numDocContraparte: "20111111112",
      razonSocialContraparte: "PROVEEDOR",
      mtoBiGravada: 100,
      mtoIgv: 18,
      mtoBiNoGravada: 0,
      mtoTotal: 118,
      codMoneda: "PEN",
      tipoCambio: 1,
      estadoComprobante: null,
      datos: { a: "b" },
    }));
    expect(await repo.reemplazar(id, "rce", "202609", "propuesta", null, filas)).toBe(950);
    expect((await repo.totales(id, "rce", "202609", "propuesta")).suma_total).toBe(950 * 118);
    await repo.reemplazar(id, "rce", "202609", "propuesta", null, filas.slice(0, 10));
    expect((await repo.totales(id, "rce", "202609", "propuesta")).total_comprobantes).toBe(10);
  });
});
