import type { ComprobanteFila } from "../sire/comprobantes.js";
import { clasificarEstado, type TicketFila } from "../sire/tickets.js";
import { COD_LIBRO, NOMBRE_LIBRO, type EjercicioSunat, type Libro } from "../sunat/sire.js";

/** Cómo se ve un ticket hacia afuera (los mismos nombres que usa el portal). */
export function presentarTicket(t: TicketFila) {
  const { finalizado, exitoso } = clasificarEstado(t.cod_estado, t.des_estado);
  return {
    num_ticket: t.num_ticket,
    per_tributario: t.per_tributario,
    libro: t.libro,
    cod_proceso: t.cod_proceso,
    des_proceso: t.des_proceso,
    estado: t.cod_estado,
    estado_descripcion: t.des_estado,
    estado_enum: !finalizado ? "EN_PROCESO" : exitoso ? "TERMINADO" : "CON_ERRORES",
    finalizado,
    exitoso,
    archivo_disponible: !!t.archivo_path,
    nom_archivo_reporte: t.nom_archivo_reporte,
    cnt_cp_informados: t.cnt_cp_informados,
    cnt_cp_error: t.cnt_cp_error,
    poll_attempts: t.poll_attempts,
    ultimo_error: t.ultimo_error,
    created_at: t.created_at,
    last_polled_at: t.last_polled_at,
    finished_at: t.finished_at,
  };
}

/** Un comprobante hacia afuera: compras llaman "proveedor" a la contraparte y ventas "adquiriente". */
export function presentarComprobante(c: ComprobanteFila, libro: Libro) {
  const base = {
    id: c.id,
    car_sunat: c.car_sunat,
    fec_emision: c.fec_emision,
    cod_tipo_cdp: c.cod_tipo_cdp,
    num_serie_cdp: c.num_serie_cdp,
    num_cdp: c.num_cdp,
    mto_bi_gravada: c.mto_bi_gravada,
    mto_igv: c.mto_igv,
    mto_bi_no_gravada: c.mto_bi_no_gravada,
    mto_total: c.mto_total,
    cod_moneda: c.cod_moneda,
  };
  return libro === "rce"
    ? { ...base, num_doc_proveedor: c.num_doc_contraparte, razon_social_proveedor: c.razon_social_contraparte }
    : { ...base, num_doc_adquiriente: c.num_doc_contraparte, razon_social_adquiriente: c.razon_social_contraparte };
}

export function presentarPeriodos(libro: Libro, ejercicios: EjercicioSunat[]) {
  return {
    libro: COD_LIBRO[libro],
    libro_desc: NOMBRE_LIBRO[libro],
    ejercicios: ejercicios.map((e) => ({
      anio: e.anio,
      des_estado: e.desEstado,
      periodos: e.periodos.map((p) => ({ per_tributario: p.perTributario, cod_estado: p.codEstado, des_estado: p.desEstado })),
    })),
  };
}
