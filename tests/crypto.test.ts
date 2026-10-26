import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateApiCredentials, hashApiSecret, parseEncryptionKey, verifyApiSecret } from "../src/crypto.js";

const clave = Buffer.alloc(32, 9);

describe("cifrado de secretos", () => {
  it("descifra lo que cifró", () => {
    expect(decryptSecret(encryptSecret("MiClaveSOL#1", clave), clave)).toBe("MiClaveSOL#1");
  });

  it("no guarda el texto en claro y cifrar dos veces da resultados distintos", () => {
    const a = encryptSecret("secreto", clave);
    const b = encryptSecret("secreto", clave);
    expect(a).not.toContain("secreto");
    expect(a).not.toBe(b);
  });

  it("detecta si el texto cifrado fue alterado", () => {
    const partes = encryptSecret("secreto", clave).split(":");
    partes[3] = Buffer.from("otra cosa").toString("base64");
    expect(() => decryptSecret(partes.join(":"), clave)).toThrow();
  });

  it("no descifra con otra clave", () => {
    expect(() => decryptSecret(encryptSecret("secreto", clave), Buffer.alloc(32, 1))).toThrow();
  });

  it("exige una clave de exactamente 32 bytes", () => {
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
    expect(parseEncryptionKey(Buffer.alloc(32).toString("base64"))).toHaveLength(32);
  });
});

describe("credenciales de la API", () => {
  it("genera un par nuevo cada vez y solo guarda el hash del secreto", () => {
    const a = generateApiCredentials("pepper-largo-de-prueba");
    const b = generateApiCredentials("pepper-largo-de-prueba");
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(a.apiSecretHash).not.toContain(a.apiSecret);
    expect(verifyApiSecret(a.apiSecret, a.apiSecretHash, "pepper-largo-de-prueba")).toBe(true);
  });

  it("rechaza un secreto equivocado o un pepper distinto", () => {
    const a = generateApiCredentials("pepper-largo-de-prueba");
    expect(verifyApiSecret("otro", a.apiSecretHash, "pepper-largo-de-prueba")).toBe(false);
    expect(verifyApiSecret(a.apiSecret, a.apiSecretHash, "otro-pepper-distinto-largo")).toBe(false);
    expect(hashApiSecret("x", "p".repeat(16))).toHaveLength(64);
  });
});
