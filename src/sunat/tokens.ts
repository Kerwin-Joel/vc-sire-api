import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import { SunatError } from "../errors.js";
import type { Guards } from "./guard.js";

/** Credenciales de SUNAT de una empresa, ya descifradas (viven solo en memoria, el tiempo de la petición). */
export interface CredencialesSunat {
  tenantId: number;
  ruc: string;
  solUser: string;
  solPass: string;
  clientId: string;
  clientSecret: string;
}

interface TokenGuardado {
  token: string;
  venceEn: number;
}

interface Rechazo {
  /** Huella de las credenciales que fallaron: si cambian, se permite volver a intentar al instante. */
  huella: string;
  hasta: number;
  mensaje: string;
}

const SCOPE = "https://api-sire.sunat.gob.pe";
/** Tras un rechazo de credenciales no se vuelve a intentar con las mismas durante este tiempo: SUNAT bloquea la Clave SOL. */
const ENFRIAMIENTO_MS = 15 * 60_000;
/** Se renueva el token un poco antes de que venza. */
const MARGEN_MS = 60_000;

const huellaDe = (c: CredencialesSunat) =>
  createHash("sha256").update([c.ruc, c.solUser, c.solPass, c.clientId, c.clientSecret].join("\u0000")).digest("hex");

/**
 * Obtiene y guarda en memoria los tokens OAuth de SUNAT (uno por empresa).
 * - Una sola petición de token a la vez por empresa (si llegan 5 a la vez, las 5 esperan la misma).
 * - Si SUNAT rechaza las credenciales NO se reintenta (cada intento fallido acerca el bloqueo de la Clave SOL):
 *   se recuerda el rechazo y se responde igual hasta que las credenciales cambien o pasen 15 minutos.
 */
export class TokenService {
  private readonly tokens = new Map<number, TokenGuardado>();
  private readonly enVuelo = new Map<number, Promise<string>>();
  private readonly rechazos = new Map<number, Rechazo>();

  constructor(
    private readonly cfg: Pick<Config, "SUNAT_AUTH_BASE" | "SUNAT_TIMEOUT_MS">,
    private readonly guards: Guards,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly ahora: () => number = Date.now,
  ) {}

  invalidar(tenantId: number): void {
    this.tokens.delete(tenantId);
  }

  olvidarRechazo(tenantId: number): void {
    this.rechazos.delete(tenantId);
  }

  async obtener(c: CredencialesSunat): Promise<string> {
    const guardado = this.tokens.get(c.tenantId);
    if (guardado && guardado.venceEn - MARGEN_MS > this.ahora()) return guardado.token;

    const rechazo = this.rechazos.get(c.tenantId);
    if (rechazo && rechazo.huella === huellaDe(c) && rechazo.hasta > this.ahora()) {
      throw new SunatError(
        `${rechazo.mensaje} Para no arriesgar el bloqueo de la Clave SOL no se vuelve a intentar con las mismas credenciales; corrígelas e inténtalo de nuevo.`,
        401,
        "credenciales_rechazadas",
      );
    }

    const pendiente = this.enVuelo.get(c.tenantId);
    if (pendiente) return pendiente;

    const promesa = this.pedir(c).finally(() => this.enVuelo.delete(c.tenantId));
    this.enVuelo.set(c.tenantId, promesa);
    return promesa;
  }

  private async pedir(c: CredencialesSunat): Promise<string> {
    const url = `${this.cfg.SUNAT_AUTH_BASE}/v1/clientessol/${encodeURIComponent(c.clientId)}/oauth2/token/`;
    this.guards.assertLive(url);

    const cuerpo = new URLSearchParams({
      grant_type: "password",
      scope: SCOPE,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      username: `${c.ruc}${c.solUser}`,
      password: c.solPass,
    });

    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), this.cfg.SUNAT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: cuerpo,
        signal: control.signal,
      });
    } catch {
      throw new SunatError("No se pudo contactar el servicio de autenticación de SUNAT. Inténtalo en unos minutos.", 502, "sunat_sin_respuesta");
    } finally {
      clearTimeout(reloj);
    }

    const texto = await res.text();
    type RespuestaToken = { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    let json = null as RespuestaToken | null;
    try {
      json = JSON.parse(texto) as RespuestaToken;
    } catch {
      json = null;
    }

    if (!res.ok || !json?.access_token) {
      if (res.status >= 500) {
        throw new SunatError("El servicio de autenticación de SUNAT no está disponible. Inténtalo en unos minutos.", 502, "sunat_no_disponible");
      }
      const detalle = json?.error_description ?? json?.error ?? `Error ${res.status}`;
      const mensaje = `SUNAT rechazó las credenciales (${detalle}). Revisa el usuario y la Clave SOL, y el client_id / client_secret.`;
      this.rechazos.set(c.tenantId, { huella: huellaDe(c), hasta: this.ahora() + ENFRIAMIENTO_MS, mensaje });
      throw new SunatError(mensaje, 401, "credenciales_rechazadas");
    }

    this.rechazos.delete(c.tenantId);
    const venceEn = this.ahora() + (json.expires_in ?? 3600) * 1000;
    this.tokens.set(c.tenantId, { token: json.access_token, venceEn });
    return json.access_token;
  }
}
