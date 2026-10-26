import pino from "pino";

/** Campos que nunca deben aparecer en un registro (claves, tokens, secretos). */
const REDACT = [
  "password",
  "sol_pass",
  "clave_sol",
  "client_secret",
  "api_secret",
  "access_token",
  "req.headers.authorization",
  'req.headers["x-api-secret"]',
  'req.headers["x-api-key"]',
  "*.password",
  "*.sol_pass",
  "*.client_secret",
  "*.api_secret",
  "*.access_token",
];

export function createLogger(level: string = "info", pretty = false) {
  return pino({
    level,
    redact: { paths: REDACT, censor: "[oculto]" },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
