import { AppError } from "../../errors.js";

/** Un comprobante de la propuesta, ya normalizado (sirve igual para compras y ventas). */
export interface ComprobanteLeido {
  carSunat: string | null;
  fecEmision: string | null; // AAAA-MM-DD
  fecVcto: string | null;
  codTipoCdp: string | null;
  numSerieCdp: string | null;
  numCdp: string | null;
  codTipoDocContraparte: string | null;
  numDocContraparte: string | null;
  razonSocialContraparte: string | null;
  mtoBiGravada: number;
  mtoIgv: number;
  mtoBiNoGravada: number;
  mtoTotal: number;
  codMoneda: string | null;
  tipoCambio: number | null;
  estadoComprobante: string | null;
  /** La fila completa, por nombre de columna (solo lo que no viene vacío). */
  datos: Record<string, string>;
}

/** SUNAT entrega estos TXT a veces en UTF-8 y a veces en Windows-1252; se prueba UTF-8 estricto y si falla, Windows-1252. */
export function decodificarTexto(bytes: Uint8Array): string {
  const sinBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(sinBom);
  } catch {
    return new TextDecoder("windows-1252").decode(sinBom);
  }
}

/** "Nro CP o Doc. Nro Inicial (Rango)" -> "nro cp o doc nro inicial rango" (sin tildes, signos ni mayúsculas). */
export function normalizarEncabezado(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/�/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface TablaPipe {
  encabezados: string[];
  /** Nombres normalizados, en el mismo orden que `encabezados`. */
  claves: string[];
  filas: string[][];
}

export function leerTablaPipe(texto: string): TablaPipe {
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim() !== "");
  const cabecera = lineas[0];
  if (!cabecera) throw new AppError("El archivo de SUNAT está vacío.", 422, "archivo_vacio");
  const encabezados = cabecera.split("|").map((h) => h.trim());
  return {
    encabezados,
    claves: encabezados.map(normalizarEncabezado),
    filas: lineas.slice(1).map((l) => l.split("|")),
  };
}

/** "20/11/2025" -> "2025-11-20"; vacío o inválido -> null. */
export function parseFecha(v: string | undefined): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(v ?? "");
  if (!m) return null;
  return `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

export function parseNumero(v: string | undefined): number {
  const n = Number((v ?? "").trim().replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function parseNumeroOpc(v: string | undefined): number | null {
  const t = (v ?? "").trim();
  if (t === "") return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export const vacioANull = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** Acceso a una fila por nombre normalizado de columna. Si una columna aparece repetida se usa la primera. */
export class Fila {
  constructor(
    private readonly indice: Map<string, number>,
    private readonly valores: string[],
    private readonly tabla: TablaPipe,
  ) {}

  texto(clave: string): string | undefined {
    const i = this.indice.get(clave);
    return i === undefined ? undefined : this.valores[i];
  }

  numero(...claves: string[]): number {
    return claves.reduce((a, k) => a + parseNumero(this.texto(k)), 0);
  }

  /** Toda la fila con sus nombres originales de columna (sin los vacíos). */
  datos(): Record<string, string> {
    const out: Record<string, string> = {};
    this.tabla.encabezados.forEach((h, i) => {
      const v = (this.valores[i] ?? "").trim();
      if (h !== "" && v !== "") out[h] = v;
    });
    return out;
  }
}

export function construirIndice(tabla: TablaPipe): Map<string, number> {
  const indice = new Map<string, number>();
  tabla.claves.forEach((k, i) => {
    if (k !== "" && !indice.has(k)) indice.set(k, i);
  });
  return indice;
}

/** Falla con un mensaje claro si el archivo no trae las columnas mínimas (SUNAT cambió el formato, o no es el archivo esperado). */
export function exigirColumnas(indice: Map<string, number>, requeridas: string[], libro: string): void {
  const faltan = requeridas.filter((c) => !indice.has(c));
  if (faltan.length > 0) {
    throw new AppError(
      `El archivo de ${libro} no tiene el formato esperado: faltan las columnas ${faltan.join(", ")}.`,
      422,
      "formato_inesperado",
    );
  }
}
