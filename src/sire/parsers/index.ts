import { unzipSync } from "fflate";
import { AppError } from "../../errors.js";
import type { Libro } from "../../sunat/sire.js";
import { decodificarTexto, type ComprobanteLeido } from "./comun.js";
import { leerPropuestaRce } from "./rce.js";
import { leerPropuestaRvie } from "./rvie.js";

export type { ComprobanteLeido } from "./comun.js";

/** Máximo que se acepta descomprimir (un ZIP malicioso puede explotar de tamaño al abrirse). */
const MAX_DESCOMPRIMIDO = 200 * 1024 * 1024;

/** Saca el TXT de dentro del ZIP que entrega SUNAT. Si lo que llega no es un ZIP, se asume que ya es el texto. */
export function extraerTxt(bytes: Uint8Array): Uint8Array {
  const esZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!esZip) return bytes;
  let archivos: Record<string, Uint8Array>;
  try {
    archivos = unzipSync(bytes, { filter: (f) => f.originalSize <= MAX_DESCOMPRIMIDO });
  } catch {
    throw new AppError("El ZIP de SUNAT está dañado o es demasiado grande.", 422, "zip_invalido");
  }
  const nombre = Object.keys(archivos).find((n) => n.toLowerCase().endsWith(".txt"));
  const txt = nombre ? archivos[nombre] : undefined;
  if (!txt) throw new AppError("El ZIP de SUNAT no trae ningún archivo .txt.", 422, "zip_sin_txt");
  return txt;
}

/** Lee la propuesta (ZIP o TXT) de un libro y devuelve sus comprobantes normalizados. */
export function leerPropuesta(libro: Libro, bytes: Uint8Array): ComprobanteLeido[] {
  const texto = decodificarTexto(extraerTxt(bytes));
  return libro === "rce" ? leerPropuestaRce(texto) : leerPropuestaRvie(texto);
}
