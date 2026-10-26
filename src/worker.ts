import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { crearContenedor } from "./container.js";
import { createPgDb } from "./db/index.js";
import { createLogger } from "./logger.js";
import { crearStorage } from "./storage.js";

/**
 * Proceso en segundo plano: sigue los tickets de SUNAT, baja sus archivos y los lee.
 * Se ejecuta aparte de la API (`npm run start:worker`) para que una descarga lenta no frene las respuestas.
 */
const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV === "development");
const db = createPgDb(cfg.DATABASE_URL, { max: cfg.DB_POOL_MAX });

if (cfg.STORAGE_DRIVER === "local") mkdirSync(cfg.STORAGE_DIR, { recursive: true });
const { worker } = crearContenedor(cfg, db, log, crearStorage(cfg.STORAGE_DRIVER, db, cfg.STORAGE_DIR));

worker.iniciar();
log.info({ sunat_live: cfg.SUNAT_LIVE }, "worker del SIRE iniciado");

const apagar = async () => {
  log.info("apagando worker…");
  worker.detener();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void apagar());
process.on("SIGINT", () => void apagar());
