import { loadConfig } from "../config.js";
import { createPgDb } from "./index.js";
import { migrate } from "./migrate.js";

const cfg = loadConfig();
const db = createPgDb(cfg.DATABASE_URL);
try {
  const aplicadas = await migrate(db);
  console.log(aplicadas.length ? `Migraciones aplicadas: ${aplicadas.join(", ")}` : "La base ya estaba al día.");
} finally {
  await db.close();
}
