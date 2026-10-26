import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LocalStorage, PgStorage, crearStorage } from "../src/storage.js";
import { crearDbPrueba } from "../src/test/db.js";

/** Todos los valores de byte posibles, para comprobar que nada se corrompe al guardar archivos binarios. */
const TODOS_LOS_BYTES = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));

describe("almacenamiento en Postgres", () => {
  it("guarda y lee archivos binarios sin alterarlos", async () => {
    const db = await crearDbPrueba();
    const s = new PgStorage(db);
    await s.guardar("tenant-1/202609/a.zip", TODOS_LOS_BYTES);
    expect(Buffer.from(await s.leer("tenant-1/202609/a.zip")).equals(Buffer.from(TODOS_LOS_BYTES))).toBe(true);
    expect(await s.existe("tenant-1/202609/a.zip")).toBe(true);
    expect(await s.existe("otra/ruta")).toBe(false);
  });

  it("guardar de nuevo en la misma ruta reemplaza el contenido", async () => {
    const db = await crearDbPrueba();
    const s = new PgStorage(db);
    await s.guardar("x", new Uint8Array([1, 2, 3]));
    await s.guardar("x", new Uint8Array([9]));
    expect(Array.from(await s.leer("x"))).toEqual([9]);
    expect(await db.query("select 1 from archivos")).toHaveLength(1);
  });

  it("leer algo que no existe da un error claro", async () => {
    const s = new PgStorage(await crearDbPrueba());
    await expect(s.leer("no-hay")).rejects.toThrow(/No existe/);
  });

  it("crearStorage elige según el driver", async () => {
    const db = await crearDbPrueba();
    expect(crearStorage("postgres", db, "./x")).toBeInstanceOf(PgStorage);
    expect(crearStorage("local", db, "./x")).toBeInstanceOf(LocalStorage);
  });
});

describe("almacenamiento en disco", () => {
  let carpeta: string | null = null;
  afterAll(async () => {
    if (carpeta) await rm(carpeta, { recursive: true, force: true });
  });

  it("guarda dentro de su carpeta y no deja salir con rutas como ../../", async () => {
    carpeta = await mkdtemp(join(tmpdir(), "sire-"));
    const s = new LocalStorage(carpeta);
    await s.guardar("tenant-1/a.bin", TODOS_LOS_BYTES);
    expect(Buffer.from(await s.leer("tenant-1/a.bin")).equals(Buffer.from(TODOS_LOS_BYTES))).toBe(true);
    await expect(s.guardar("../../afuera.txt", new Uint8Array([1]))).rejects.toThrow(/no permitida/);
    await expect(s.leer("../../etc/passwd")).rejects.toThrow(/no permitida/);
  });
});
