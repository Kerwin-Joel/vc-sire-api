import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { crearContenedor } from "./container.js";
import { createPgDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { crearApp } from "./http/app.js";
import { createLogger } from "./logger.js";
import { crearStorage } from "./storage.js";

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV === "development");
const db = createPgDb(cfg.DATABASE_URL, { max: cfg.DB_POOL_MAX });

if (cfg.STORAGE_DRIVER === "local") mkdirSync(cfg.STORAGE_DIR, { recursive: true });
const aplicadas = await migrate(db);
if (aplicadas.length) log.info({ aplicadas }, "migraciones aplicadas");

const contenedor = crearContenedor(cfg, db, log, crearStorage(cfg.STORAGE_DRIVER, db, cfg.STORAGE_DIR));
const app = crearApp(contenedor);

const servidor = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  log.info(
    { puerto: info.port, sunat_live: cfg.SUNAT_LIVE, escritura: cfg.SIRE_WRITES_ENABLED },
    cfg.SUNAT_LIVE ? "API del SIRE lista (consultas REALES a SUNAT activadas)" : "API del SIRE lista (SUNAT desactivado: no se enviará nada)",
  );
});

if (cfg.RUN_WORKER_IN_API) {
  contenedor.worker.iniciar();
  log.info("el worker corre dentro de la API (RUN_WORKER_IN_API=true)");
}

const apagar = async () => {
  log.info("apagando…");
  contenedor.worker.detener();
  servidor.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void apagar());
process.on("SIGINT", () => void apagar());
