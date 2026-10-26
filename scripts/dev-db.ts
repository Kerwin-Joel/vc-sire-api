import { mkdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

/**
 * Un Postgres local para desarrollar SIN Docker ni instalar nada: guarda los datos en ./data/pgdata y se conecta con
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres
 * Solo para desarrollo. En producción se usa un Postgres administrado.
 */
const puerto = Number(process.env.DEV_DB_PORT ?? 5433);
mkdirSync("./data", { recursive: true });
const db = new PGlite("./data/pgdata");
const servidor = new PGLiteSocketServer({ db, port: puerto, host: "127.0.0.1", maxConnections: 1 });
await servidor.start();
console.log(`Postgres de desarrollo listo en postgres://postgres:postgres@127.0.0.1:${puerto}/postgres (datos en ./data/pgdata)`);

const apagar = async () => {
  await servidor.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", () => void apagar());
process.on("SIGTERM", () => void apagar());
