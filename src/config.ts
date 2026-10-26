import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Conexión a Postgres. */
  DATABASE_URL: z.string().min(1),
  /** Máximo de conexiones abiertas a Postgres (los planes chicos permiten pocas; la API y el worker suman). */
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** 32 bytes en base64 para cifrar la Clave SOL y el client_secret (AES-256-GCM). Generar con `openssl rand -base64 32`. */
  APP_ENCRYPTION_KEY: z.string().min(1),
  /** Texto largo y secreto para derivar el hash del api_secret de cada empresa. */
  API_KEY_PEPPER: z.string().min(16),

  /** Si se define, crear empresas (POST /api/v1/registro) exige `Authorization: Bearer <token>`. Obligatorio en producción. */
  REGISTRATION_TOKEN: z.string().optional(),

  /** Servicios de SUNAT. Se pueden apuntar a un servidor falso en pruebas. */
  SUNAT_API_BASE: z.string().url().default("https://api-sire.sunat.gob.pe"),
  SUNAT_AUTH_BASE: z.string().url().default("https://api-seguridad.sunat.gob.pe"),
  /**
   * INTERRUPTOR DE SEGURIDAD: mientras sea false, NINGUNA petición sale hacia los dominios reales de SUNAT
   * (el SIRE no tiene ambiente de pruebas). Se activa a propósito, empresa por empresa si se quiere.
   */
  SUNAT_LIVE: bool,
  /**
   * Segundo interruptor: las operaciones que ESCRIBEN en SUNAT (aceptar, reemplazar, registrar, enviar) quedan
   * bloqueadas mientras sea false, aunque SUNAT_LIVE esté activo.
   */
  SIRE_WRITES_ENABLED: bool,
  SUNAT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  SUNAT_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(400),

  /** Dónde se guardan los archivos que entrega SUNAT: "postgres" (por defecto, sin discos) o "local" (carpeta STORAGE_DIR). */
  STORAGE_DRIVER: z.enum(["postgres", "local"]).default("postgres"),
  STORAGE_DIR: z.string().default("./data/archivos"),
  /** Si es true, la API también corre el worker dentro del mismo proceso (un solo servicio; ideal para empezar). */
  RUN_WORKER_IN_API: bool,

  /** Cola de trabajos. */
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  TICKET_MAX_POLLS: z.coerce.number().int().positive().default(40),
  /** Cuánto esperar antes de la primera consulta de un ticket recién pedido. */
  TICKET_FIRST_POLL_MS: z.coerce.number().int().nonnegative().default(3_000),
  /** Si se define, se consulta el ticket siempre con esta espera (en pruebas: 0). Si no, la espera crece sola. */
  TICKET_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().optional(),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuración inválida:\n${detalle}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production" && !cfg.REGISTRATION_TOKEN) {
    throw new Error("Configuración inválida: en producción hay que definir REGISTRATION_TOKEN (si no, cualquiera podría registrar empresas).");
  }
  return cfg;
}
