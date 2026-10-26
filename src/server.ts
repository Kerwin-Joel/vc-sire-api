import { mkdirSync } from "node:fs";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { crearContenedor } from "./container.js";
import { createPgDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { crearApp } from "./http/app.js";
import { createLogger } from "./logger.js";
import { LocalStorage } from "./storage.js";

const cfg = loadConfig();
const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV === "development");
const db = createPgDb(cfg.DATABASE_URL);

mkdirSync(cfg.STORAGE_DIR, { recursive: true });
const aplicadas = await migrate(db);
if (aplicadas.length) log.info({ aplicadas }, "migraciones aplicadas");

const contenedor = crearContenedor(cfg, db, log, new LocalStorage(cfg.STORAGE_DIR));
const app = crearApp(contenedor);

const servidor = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  log.info(
    { puerto: info.port, sunat_live: cfg.SUNAT_LIVE, escritura: cfg.SIRE_WRITES_ENABLED },
    cfg.SUNAT_LIVE ? "API del SIRE lista (consultas REALES a SUNAT activadas)" : "API del SIRE lista (SUNAT desactivado: no se enviará nada)",
  );
});

const apagar = async () => {
  log.info("apagando…");
  servidor.close();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", () => void apagar());
process.on("SIGINT", () => void apagar());
