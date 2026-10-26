import { SunatError } from "../errors.js";
import type { SunatHttp } from "./http.js";
import type { CredencialesSunat } from "./tokens.js";

export type Libro = "rce" | "rvie";

export const COD_LIBRO: Record<Libro, string> = { rce: "080000", rvie: "140000" };
export const NOMBRE_LIBRO: Record<Libro, string> = { rce: "Registro de Compras Electrónico (RCE)", rvie: "Registro de Ventas e Ingresos Electrónico (RVIE)" };

const BASE = "/v1/contribuyente/migeigv/libros";
/** Origen de envío "2 = servicio web" que exige SUNAT en la consulta de tickets. */
const ORIGEN_SERVICIO_WEB = "2";

// ─── Tipos de lo que entrega SUNAT, ya ordenados ─────────────────────────────

export interface PeriodoSunat {
  perTributario: string;
  codEstado: string;
  desEstado: string;
}
export interface EjercicioSunat {
  anio: string;
  desEstado: string;
  periodos: PeriodoSunat[];
}

export interface ArchivoReporteSunat {
  codTipo: string | null;
  nombre: string;
  contenido: string | null;
}

export interface TicketSunat {
  numTicket: string;
  perTributario: string;
  codProceso: string;
  desProceso: string;
  codEstado: string;
  desEstado: string;
  nomArchivoImportacion: string | null;
  nomArchivoReporte: string | null;
  cntFilasValidadas: number | null;
  cntCpInformados: number | null;
  cntCpError: number | null;
  archivos: ArchivoReporteSunat[];
  /** Respuesta completa de SUNAT, por si hace falta revisarla después. */
  crudo: unknown;
}

// ─── Utilidades de lectura tolerante (SUNAT cambia nombres y anida distinto entre libros) ───

type Obj = Record<string, unknown>;
const esObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const texto = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const textoOpc = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const numeroOpc = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Algunas respuestas vienen envueltas en `data`; se desenvuelve si hace falta. */
const desenvolver = (v: unknown): unknown => (esObj(v) && "data" in v && !("registros" in v) && !("numTicket" in v) ? v.data : v);

export function interpretarTicket(crudo: unknown): TicketSunat | null {
  const raiz = desenvolver(crudo);
  const registros = esObj(raiz) && Array.isArray(raiz.registros) ? raiz.registros : Array.isArray(raiz) ? raiz : [];
  const r = registros[0];
  if (!esObj(r)) return null;

  const detalle = esObj(r.detalleTicket) ? r.detalleTicket : {};
  const archivos = (Array.isArray(r.archivoReporte) ? r.archivoReporte : [])
    .filter(esObj)
    .map<ArchivoReporteSunat>((a) => ({
      // SUNAT escribe "codTipoAchivoReporte" (con la errata); se aceptan ambas formas.
      codTipo: textoOpc(a.codTipoAchivoReporte ?? a.codTipoArchivoReporte),
      nombre: texto(a.nomArchivoReporte),
      contenido: textoOpc(a.nomArchivoContenido),
    }))
    .filter((a) => a.nombre !== "");

  return {
    numTicket: texto(r.numTicket),
    perTributario: texto(r.perTributario),
    codProceso: texto(r.codProceso),
    desProceso: texto(r.desProceso),
    codEstado: texto(r.codEstadoProceso),
    desEstado: texto(r.desEstadoProceso),
    nomArchivoImportacion: textoOpc(r.nomArchivoImportacion),
    nomArchivoReporte: textoOpc(detalle.nomArchivoReporte) ?? archivos[0]?.nombre ?? null,
    cntFilasValidadas: numeroOpc(detalle.cntFilasvalidada ?? detalle.cntFilasValidada),
    cntCpInformados: numeroOpc(detalle.cntCPInformados),
    cntCpError: numeroOpc(detalle.cntCPError),
    archivos,
    crudo,
  };
}

export function interpretarPeriodos(crudo: unknown): EjercicioSunat[] {
  const raiz = desenvolver(crudo);
  const lista = Array.isArray(raiz) ? raiz : esObj(raiz) ? [raiz] : [];
  return lista.filter(esObj).map<EjercicioSunat>((e) => ({
    anio: texto(e.numEjercicio),
    desEstado: texto(e.desEstado),
    periodos: (Array.isArray(e.lisPeriodos) ? e.lisPeriodos : []).filter(esObj).map<PeriodoSunat>((p) => ({
      perTributario: texto(p.perTributario),
      codEstado: texto(p.codEstado),
      desEstado: texto(p.desEstado),
    })),
  }));
}

function numTicketDe(crudo: unknown): string {
  const raiz = desenvolver(crudo);
  const n = esObj(raiz) ? raiz.numTicket : undefined;
  if (!n) throw new SunatError("SUNAT no devolvió el número de ticket de la solicitud.", 502, "sin_ticket");
  return String(n);
}

/** Lo que SUNAT entrega para un PDF: o JSON con el PDF en base64, o los bytes directos. */
export function extraerPdf(bytes: Uint8Array, contentType: string): { pdf: Uint8Array; nombre: string | null } {
  const esJson = contentType.includes("json") || bytes[0] === 0x7b; // "{"
  if (!esJson) return { pdf: bytes, nombre: null };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new SunatError("SUNAT entregó un documento que no se pudo leer.", 502, "respuesta_ilegible");
  }
  const raiz = desenvolver(json);
  const b64 = esObj(raiz) ? (raiz.archivoPdf ?? raiz.archivoPDF) : undefined;
  if (typeof b64 !== "string" || b64 === "") throw new SunatError("SUNAT no entregó el PDF solicitado.", 404, "sin_pdf");
  return { pdf: new Uint8Array(Buffer.from(b64, "base64")), nombre: esObj(raiz) ? textoOpc(raiz.nombreArchivoPdf) : null };
}

// ─── Cliente ──────────────────────────────────────────────────────────────────

/**
 * Los servicios de SUNAT que usa esta API, todos de LECTURA. Los números (5.16, 5.33…) son los de los manuales
 * oficiales (RVIE v31 y RCE v28); ver docs/SUNAT-SERVICIOS.md.
 */
export class SireClient {
  constructor(private readonly http: SunatHttp) {}

  /** 5.2 (RVIE) / 5.33 (RCE): años y meses habilitados. */
  async periodos(c: CredencialesSunat, libro: Libro): Promise<EjercicioSunat[]> {
    const crudo = await this.http.json(c, { ruta: `${BASE}/rvierce/padron/web/omisos/${COD_LIBRO[libro]}/periodos` });
    return interpretarPeriodos(crudo);
  }

  /** 5.34 (RCE) / 5.18 (RVIE): pide a SUNAT el archivo de la propuesta. Es asíncrono: devuelve un número de ticket. */
  async exportarPropuesta(c: CredencialesSunat, libro: Libro, periodo: string): Promise<string> {
    const crudo =
      libro === "rce"
        ? await this.http.json(c, {
            ruta: `${BASE}/rce/propuesta/web/propuesta/${periodo}/exportacioncomprobantepropuesta`,
            query: { codTipoArchivo: 0, codOrigenEnvio: ORIGEN_SERVICIO_WEB },
          })
        : await this.http.json(c, {
            ruta: `${BASE}/rvie/propuesta/web/propuesta/${periodo}/exportapropuesta`,
            query: { codTipoArchivo: 0 },
          });
    return numTicketDe(crudo);
  }

  /** 5.31 (RCE) / 5.16 (RVIE): estado de un ticket. */
  async estadoTicket(c: CredencialesSunat, libro: Libro, periodo: string, numTicket: string): Promise<TicketSunat | null> {
    const crudo = await this.http.json(c, {
      ruta: `${BASE}/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets`,
      query: {
        perIni: periodo,
        perFin: periodo,
        page: 1,
        perPage: 20,
        numTicket,
        codLibro: COD_LIBRO[libro],
        codOrigenEnvio: ORIGEN_SERVICIO_WEB,
      },
    });
    return interpretarTicket(crudo);
  }

  /** 5.32 (RCE) / 5.17 (RVIE): descarga el archivo (normalmente un ZIP) que SUNAT dejó para un ticket terminado. */
  async descargarArchivoReporte(c: CredencialesSunat, libro: Libro, t: TicketSunat, archivo: ArchivoReporteSunat) {
    return this.http.bytes(c, {
      ruta: `${BASE}/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte`,
      query: {
        nomArchivoReporte: archivo.nombre,
        codTipoArchivoReporte: archivo.codTipo ?? "",
        perTributario: t.perTributario,
        codProceso: t.codProceso,
        numTicket: t.numTicket,
        codLibro: COD_LIBRO[libro],
      },
    });
  }

  /** 5.49 (RCE) / 5.26 (RVIE): constancia de recepción en PDF, dado el nombre del archivo que dejó SUNAT al generar el registro. */
  async constancia(c: CredencialesSunat, libro: Libro, nombre: string): Promise<{ pdf: Uint8Array; nombre: string | null }> {
    const r = await this.http.bytes(c, {
      ruta:
        libro === "rce"
          ? `${BASE}/rvierce/gestionlibro/web/registroslibros/constancia/constanciarecepcion`
          : `${BASE}/rvierce/gestionlibro/web/registroslibros/constancia/archivo`,
      query: libro === "rce" ? { nomConstanciaRecepcion: nombre } : { nomArchivo: nombre },
    });
    return extraerPdf(r.bytes, r.contentType);
  }

  /** 5.58 (RCE) / 5.34 (RVIE): reporte de cumplimiento del período en PDF. */
  async reporteCumplimiento(c: CredencialesSunat, libro: Libro, periodo: string): Promise<{ pdf: Uint8Array; nombre: string | null }> {
    const r = await this.http.bytes(c, {
      ruta: `${BASE}/rvierce/cumplimiento/web/omisos/${periodo}/${COD_LIBRO[libro]}/consultaReporteCumplimiento/exportardocumento`,
    });
    return extraerPdf(r.bytes, r.contentType);
  }
}
