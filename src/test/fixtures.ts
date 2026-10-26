import { zipSync } from "fflate";

/** Archivos que imitan lo que entrega SUNAT (formato real, datos inventados). */

export const ENCABEZADO_RCE = [
  "RUC",
  "Apellidos y Nombres o Razón social",
  "Periodo",
  "CAR SUNAT",
  "Fecha de emisión",
  "Fecha Vcto/Pago",
  "Tipo CP/Doc.",
  "Serie del CDP",
  "Año",
  "Nro CP o Doc. Nro Inicial (Rango)",
  "Nro Final (Rango)",
  "Tipo Doc Identidad",
  "Nro Doc Identidad",
  "Apellidos Nombres/ Razón  Social",
  "BI Gravado DG",
  "IGV / IPM DG",
  "BI Gravado DGNG",
  "IGV / IPM DGNG",
  "BI Gravado DNG",
  "IGV / IPM DNG",
  "Valor Adq. NG",
  "ISC",
  "ICBPER",
  "Otros Trib/ Cargos",
  "Total CP",
  "Moneda",
  "Tipo de Cambio",
  "Est. Comp.",
  "Incal",
  "CLU1",
  "CLU2",
];

export const ENCABEZADO_RVIE = [
  "Ruc",
  "Razon Social",
  "Periodo",
  "CAR SUNAT",
  "Fecha de emisión",
  "Fecha Vcto/Pago",
  "Tipo CP/Doc.",
  "Serie del CDP",
  "Nro CP o Doc. Nro Inicial (Rango)",
  "Nro Final (Rango)",
  "Tipo Doc Identidad",
  "Nro Doc Identidad",
  "Apellidos Nombres/ Razón Social",
  "Valor Facturado Exportación",
  "BI Gravada",
  "Dscto BI",
  "IGV / IPM",
  "Dscto IGV / IPM",
  "Mto Exonerado",
  "Mto Inafecto",
  "ISC",
  "BI Grav IVAP",
  "IVAP",
  "ICBPER",
  "Otros Tributos",
  "Total CP",
  "Moneda",
  "Tipo Cambio",
  "Est. Comp",
  "CLU",
];

/** Arma una línea del TXT: lo que no se indique queda vacío, como en los archivos de SUNAT. */
function linea(encabezado: string[], valores: Record<string, string>): string {
  return encabezado.map((h) => valores[h] ?? "").join("|");
}

export interface FilaRce {
  car?: string;
  fecha: string;
  tipo: string;
  serie: string;
  numero: string;
  ruc: string;
  razon: string;
  bi: string;
  igv: string;
  noGravado?: string;
  total: string;
}

export function txtRce(filas: FilaRce[], rucEmpresa = "20999999991"): string {
  const lineas = filas.map((f) =>
    linea(ENCABEZADO_RCE, {
      RUC: rucEmpresa,
      "Apellidos y Nombres o Razón social": "EMPRESA DE PRUEBA SAC",
      Periodo: "202609",
      "CAR SUNAT": f.car ?? `${rucEmpresa}${f.tipo}${f.serie}${f.numero}`,
      "Fecha de emisión": f.fecha,
      "Tipo CP/Doc.": f.tipo,
      "Serie del CDP": f.serie,
      "Nro CP o Doc. Nro Inicial (Rango)": f.numero,
      "Tipo Doc Identidad": "6",
      "Nro Doc Identidad": f.ruc,
      "Apellidos Nombres/ Razón  Social": f.razon,
      "BI Gravado DG": f.bi,
      "IGV / IPM DG": f.igv,
      "Valor Adq. NG": f.noGravado ?? "0.00",
      "Total CP": f.total,
      Moneda: "PEN",
      "Tipo de Cambio": "1.000",
      "Est. Comp.": "1",
    }),
  );
  return [ENCABEZADO_RCE.join("|"), ...lineas].join("\r\n");
}

export interface FilaRvie {
  fecha: string;
  tipo: string;
  serie: string;
  numero: string;
  doc: string;
  razon: string;
  bi: string;
  igv: string;
  exonerado?: string;
  total: string;
}

export function txtRvie(filas: FilaRvie[], rucEmpresa = "20999999991"): string {
  const lineas = filas.map((f) =>
    linea(ENCABEZADO_RVIE, {
      Ruc: rucEmpresa,
      "Razon Social": "EMPRESA DE PRUEBA SAC",
      Periodo: "202609",
      "CAR SUNAT": `${rucEmpresa}${f.tipo}${f.serie}${f.numero}`,
      "Fecha de emisión": f.fecha,
      "Tipo CP/Doc.": f.tipo,
      "Serie del CDP": f.serie,
      "Nro CP o Doc. Nro Inicial (Rango)": f.numero,
      "Tipo Doc Identidad": f.doc.length === 11 ? "6" : f.doc === "-" ? "0" : "1",
      "Nro Doc Identidad": f.doc,
      "Apellidos Nombres/ Razón Social": f.razon,
      "BI Gravada": f.bi,
      "IGV / IPM": f.igv,
      "Mto Exonerado": f.exonerado ?? "0.00",
      "Total CP": f.total,
      Moneda: "PEN",
      "Tipo Cambio": "1.000",
    }),
  );
  return [ENCABEZADO_RVIE.join("|"), ...lineas].join("\r\n");
}

/** Mete un TXT dentro de un ZIP, como lo entrega SUNAT. `latin1` imita los archivos que no vienen en UTF-8. */
export function zipDeTxt(texto: string, nombre = "propuesta.txt", latin1 = false): Uint8Array {
  const bytes = latin1 ? new Uint8Array(Buffer.from(texto, "latin1")) : new Uint8Array(Buffer.from(texto, "utf8"));
  return zipSync({ [nombre]: bytes });
}

/** Un PDF mínimo (lo justo para que empiece con %PDF). */
export const PDF_MINIMO = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"));
