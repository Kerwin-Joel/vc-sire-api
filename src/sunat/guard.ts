import type { Config } from "../config.js";
import { SunatLiveDisabledError, WritesDisabledError } from "../errors.js";

/** ¿La URL apunta a los servidores reales de SUNAT? */
export function esHostSunat(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "sunat.gob.pe" || host.endsWith(".sunat.gob.pe");
  } catch {
    return false;
  }
}

/**
 * Los dos interruptores de seguridad de la API.
 * - `assertLive`: nada sale hacia SUNAT de verdad si SUNAT_LIVE=false.
 * - `assertWrite`: ninguna operación que escriba en el SIRE corre si SIRE_WRITES_ENABLED=false.
 * Se revisan en el punto más bajo (justo antes de cada petición) para que ningún camino los esquive.
 */
export class Guards {
  constructor(private readonly cfg: Pick<Config, "SUNAT_LIVE" | "SIRE_WRITES_ENABLED">) {}

  assertLive(url: string): void {
    if (esHostSunat(url) && !this.cfg.SUNAT_LIVE) throw new SunatLiveDisabledError();
  }

  assertWrite(operacion: string): void {
    if (!this.cfg.SIRE_WRITES_ENABLED) throw new WritesDisabledError(operacion);
  }

  get writesEnabled(): boolean {
    return this.cfg.SIRE_WRITES_ENABLED;
  }
}
