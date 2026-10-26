import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./index.js";

/**
 * Aplica, en orden, los archivos de `migrations/*.sql` que aún no se hayan aplicado.
 * Cada archivo corre completo dentro de una transacción; si falla, no queda a medias.
 */
export async function migrate(db: Db, dir = join(process.cwd(), "migrations")): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    nombre text primary key,
    aplicada_en timestamptz not null default now()
  )`);
  const hechas = new Set((await db.query<{ nombre: string }>("select nombre from schema_migrations")).map((r) => r.nombre));
  const archivos = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  const aplicadas: string[] = [];
  for (const archivo of archivos) {
    if (hechas.has(archivo)) continue;
    const sql = await readFile(join(dir, archivo), "utf8");
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query("insert into schema_migrations (nombre) values ($1)", [archivo]);
    });
    aplicadas.push(archivo);
  }
  return aplicadas;
}
