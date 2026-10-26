import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITMO = "aes-256-gcm";
const PREFIJO = "v1";

/** Convierte la clave en base64 a 32 bytes; falla fuerte si no mide exactamente eso. */
export function parseEncryptionKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY debe ser de 32 bytes en base64 (genera una con: openssl rand -base64 32).");
  }
  return key;
}

/**
 * Cifra un secreto (Clave SOL, client_secret) con AES-256-GCM. El resultado `v1:iv:tag:datos` es texto y
 * lleva su propio vector de inicialización, así que cifrar lo mismo dos veces da resultados distintos.
 */
export function encryptSecret(plano: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITMO, key, iv);
  const datos = Buffer.concat([cipher.update(plano, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIJO, iv.toString("base64"), tag.toString("base64"), datos.toString("base64")].join(":");
}

export function decryptSecret(cifrado: string, key: Buffer): string {
  const [prefijo, iv, tag, datos] = cifrado.split(":");
  if (prefijo !== PREFIJO || !iv || !tag || !datos) throw new Error("Secreto cifrado con un formato desconocido.");
  const decipher = createDecipheriv(ALGORITMO, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(datos, "base64")), decipher.final()]).toString("utf8");
}

/** Hash del api_secret: HMAC-SHA256 con un "pepper" del servidor (así una base filtrada no sirve sin él). */
export function hashApiSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

export function verifyApiSecret(secret: string, hashGuardado: string, pepper: string): boolean {
  const a = Buffer.from(hashApiSecret(secret, pepper), "hex");
  const b = Buffer.from(hashGuardado, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Credenciales nuevas para una empresa. El `apiSecret` en claro se entrega UNA sola vez; en la base solo queda su hash. */
export function generateApiCredentials(pepper: string): { apiKey: string; apiSecret: string; apiSecretHash: string } {
  const apiKey = `vsk_${randomBytes(18).toString("hex")}`;
  const apiSecret = randomBytes(32).toString("base64url");
  return { apiKey, apiSecret, apiSecretHash: hashApiSecret(apiSecret, pepper) };
}
