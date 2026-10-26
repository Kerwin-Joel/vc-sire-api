import { loadConfig } from "../config.js";
import { crearContenedor } from "../container.js";
import { createLogger } from "../logger.js";
import { crearApp } from "../http/app.js";
import { MemoryStorage } from "../storage.js";
import { crearDbPrueba } from "./db.js";
import { crearSunatFalso, type OpcionesSunatFalso } from "./sunatFalso.js";

export const EMPRESA = {
  ruc: "20999999991",
  razon_social: "EMPRESA DE PRUEBA SAC",
  sol_user: "USUARIO1",
  sol_pass: "Clave123",
  client_id: "cid-de-prueba",
  client_secret: "csecret-de-prueba",
};

export interface OpcionesEntorno {
  env?: Record<string, string>;
  sunat?: Partial<OpcionesSunatFalso>;
}

/** Todo el sistema armado en memoria: base real (PGlite), SUNAT de mentira y la app lista para recibir peticiones. */
export async function crearEntorno(o: OpcionesEntorno = {}) {
  const cfg = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "memoria",
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    API_KEY_PEPPER: "pepper-de-pruebas-bien-largo",
    SUNAT_API_BASE: "https://api-sire.falso.test",
    SUNAT_AUTH_BASE: "https://api-seguridad.falso.test",
    SUNAT_LIVE: "false",
    SIRE_WRITES_ENABLED: "false",
    SUNAT_MIN_INTERVAL_MS: "0",
    TICKET_FIRST_POLL_MS: "0",
    TICKET_POLL_INTERVAL_MS: "0",
    LOG_LEVEL: "silent",
    ...o.env,
  } as NodeJS.ProcessEnv);

  const db = await crearDbPrueba();
  const storage = new MemoryStorage();
  const sunat = crearSunatFalso({
    ruc: EMPRESA.ruc,
    usuario: EMPRESA.sol_user,
    clave: EMPRESA.sol_pass,
    clientId: EMPRESA.client_id,
    clientSecret: EMPRESA.client_secret,
    ...o.sunat,
  });
  const k = crearContenedor(cfg, db, createLogger("silent"), storage, { fetchImpl: sunat.fetch, dormirFn: async () => undefined });
  const app = crearApp(k);

  const json = (cuerpo: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) });

  /** Registra la empresa de pruebas y devuelve las cabeceras que usa el portal. */
  async function registrar(extra: Record<string, unknown> = {}) {
    const res = await app.request("/api/v1/registro", { ...json({ proposito: "sire", ...EMPRESA, ...extra }) });
    const cuerpo = (await res.json()) as { datos: { api_key: string; api_secret: string; tenant_id: number } };
    return {
      status: res.status,
      cuerpo,
      cabeceras: { "x-api-key": cuerpo.datos?.api_key ?? "", "x-api-secret": cuerpo.datos?.api_secret ?? "" },
    };
  }

  /** Registra y activa SIRE (el token de SUNAT falso acepta las credenciales de EMPRESA). */
  async function empresaActiva() {
    const r = await registrar();
    const act = await app.request("/api/v1/sire/activar", { method: "POST", headers: r.cabeceras });
    return { ...r, activacion: act };
  }

  return { cfg, db, storage, sunat, k, app, json, registrar, empresaActiva };
}
