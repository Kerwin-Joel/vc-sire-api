import type { Config } from "../config.js";
import { SunatError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { Guards } from "./guard.js";
import type { CredencialesSunat, TokenService } from "./tokens.js";

export interface PeticionSunat {
  /** Ruta que empieza con /v1/... */
  ruta: string;
  query?: Record<string, string | number | undefined | null>;
  /** "json" (por defecto) o "bytes" para descargas de archivos. */
  respuesta?: "json" | "bytes";
  /** Las lecturas se reintentan solas si SUNAT falla un momento; las escrituras NO. */
  escritura?: boolean;
  metodo?: "GET" | "POST";
}

export interface RespuestaBytes {
  bytes: Uint8Array;
  contentType: string;
}

const ESPERA_BASE_MS = 800;
const MAX_REINTENTOS_LECTURA = 3;

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cliente HTTP de los servicios del SIRE. Se ocupa de lo que se repite en todas las llamadas:
 * - el token (y renovarlo una vez si SUNAT responde 401);
 * - un intervalo mínimo entre llamadas de la misma empresa (SUNAT responde 429 si se la abruma);
 * - reintentos con espera creciente en errores de red, 429 y 5xx (solo en lecturas);
 * - convertir los errores de SUNAT en mensajes entendibles;
 * - los interruptores de seguridad (SUNAT_LIVE / SIRE_WRITES_ENABLED) justo antes de enviar.
 */
export class SunatHttp {
  private readonly ultimaLlamada = new Map<number, number>();
  private readonly cola = new Map<number, Promise<void>>();

  constructor(
    private readonly cfg: Pick<Config, "SUNAT_API_BASE" | "SUNAT_TIMEOUT_MS" | "SUNAT_MIN_INTERVAL_MS">,
    private readonly tokens: TokenService,
    private readonly guards: Guards,
    private readonly log: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly dormirFn: (ms: number) => Promise<void> = dormir,
  ) {}

  /** Respeta el intervalo mínimo entre llamadas de una misma empresa, aunque lleguen varias a la vez. */
  private esperarTurno(tenantId: number): Promise<void> {
    const anterior = this.cola.get(tenantId) ?? Promise.resolve();
    const turno = anterior.then(async () => {
      const desde = this.ultimaLlamada.get(tenantId) ?? 0;
      const falta = this.cfg.SUNAT_MIN_INTERVAL_MS - (Date.now() - desde);
      if (falta > 0) await this.dormirFn(falta);
      this.ultimaLlamada.set(tenantId, Date.now());
    });
    this.cola.set(tenantId, turno.catch(() => undefined));
    return turno;
  }

  private armarUrl(p: PeticionSunat): string {
    const url = new URL(this.cfg.SUNAT_API_BASE + p.ruta);
    for (const [k, v] of Object.entries(p.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async json<T = unknown>(c: CredencialesSunat, p: PeticionSunat): Promise<T> {
    const r = await this.ejecutar(c, { ...p, respuesta: "json" });
    return r as T;
  }

  async bytes(c: CredencialesSunat, p: PeticionSunat): Promise<RespuestaBytes> {
    return (await this.ejecutar(c, { ...p, respuesta: "bytes" })) as RespuestaBytes;
  }

  private async ejecutar(c: CredencialesSunat, p: PeticionSunat): Promise<unknown> {
    const url = this.armarUrl(p);
    this.guards.assertLive(url);
    if (p.escritura) this.guards.assertWrite(p.ruta);

    const maxIntentos = p.escritura ? 1 : MAX_REINTENTOS_LECTURA;
    let renovado = false;

    for (let intento = 1; ; intento++) {
      await this.esperarTurno(c.tenantId);
      const token = await this.tokens.obtener(c);

      let res: Response | null = null;
      let fallaRed = false;
      const control = new AbortController();
      const reloj = setTimeout(() => control.abort(), this.cfg.SUNAT_TIMEOUT_MS);
      try {
        res = await this.fetchImpl(url, {
          method: p.metodo ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: p.respuesta === "bytes" ? "application/octet-stream, application/json" : "application/json",
          },
          signal: control.signal,
        });
      } catch {
        fallaRed = true;
      } finally {
        clearTimeout(reloj);
      }

      if (res && res.status === 401 && !renovado) {
        // El token pudo vencer antes de lo esperado: se pide uno nuevo una sola vez.
        renovado = true;
        this.tokens.invalidar(c.tenantId);
        continue;
      }

      const reintentable = fallaRed || (res !== null && (res.status === 429 || res.status >= 500));
      if (reintentable) {
        if (intento < maxIntentos) {
          const espera = ESPERA_BASE_MS * 2 ** (intento - 1) + Math.floor(Math.random() * 250);
          this.log.warn({ tenant: c.tenantId, ruta: p.ruta, intento, estado: res?.status ?? "red" }, "SUNAT falló; se reintenta");
          await this.dormirFn(espera);
          continue;
        }
        if (fallaRed || !res) throw new SunatError("SUNAT no respondió. Inténtalo en unos minutos.", 502, "sunat_sin_respuesta");
        if (res.status === 429) throw new SunatError("SUNAT está limitando las consultas. Espera un momento e inténtalo de nuevo.", 429, "sunat_429");
        throw new SunatError("El SIRE de SUNAT no está disponible en este momento. Inténtalo en unos minutos.", 502, "sunat_no_disponible");
      }

      if (!res) throw new SunatError("SUNAT no respondió.", 502, "sunat_sin_respuesta");

      if (!res.ok) throw await this.interpretarError(res);

      if (p.respuesta === "bytes") {
        const contentType = res.headers.get("content-type") ?? "application/octet-stream";
        return { bytes: new Uint8Array(await res.arrayBuffer()), contentType } satisfies RespuestaBytes;
      }
      const texto = await res.text();
      if (!texto) return {};
      try {
        return JSON.parse(texto) as unknown;
      } catch {
        throw new SunatError("SUNAT respondió algo que no se pudo leer.", 502, "respuesta_ilegible");
      }
    }
  }

  /** SUNAT devuelve errores como `{cod, msg, errors:[{cod, msg}]}`. */
  private async interpretarError(res: Response): Promise<SunatError> {
    const texto = await res.text().catch(() => "");
    type CuerpoError = { cod?: string; msg?: string; errors?: { cod?: string; msg?: string }[] };
    let cuerpo = null as CuerpoError | null;
    try {
      cuerpo = JSON.parse(texto) as CuerpoError;
    } catch {
      cuerpo = null;
    }
    const primero = cuerpo?.errors?.[0];
    const mensaje = primero?.msg ?? cuerpo?.msg ?? `SUNAT respondió con error ${res.status}.`;
    const status = res.status === 401 || res.status === 403 ? res.status : res.status === 404 ? 404 : res.status >= 400 && res.status < 500 ? 422 : 502;
    return new SunatError(mensaje, status, "sunat_error", primero?.cod ?? cuerpo?.cod, cuerpo?.errors ?? []);
  }
}
