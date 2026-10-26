import type { Db } from "../db/index.js";
import type { Libro } from "../sunat/sire.js";
import type { ComprobanteLeido } from "./parsers/index.js";

export type Fase = "propuesta" | "preliminar" | "registrado";

export interface Totales {
  total_comprobantes: number;
  suma_bi_gravada: number;
  suma_igv: number;
  suma_total: number;
}

export type ComprobanteFila = {
  id: number;
  car_sunat: string | null;
  fec_emision: string | null;
  cod_tipo_cdp: string | null;
  num_serie_cdp: string | null;
  num_cdp: string | null;
  cod_tipo_doc_contraparte: string | null;
  num_doc_contraparte: string | null;
  razon_social_contraparte: string | null;
  mto_bi_gravada: string;
  mto_igv: string;
  mto_bi_no_gravada: string;
  mto_total: string;
  cod_moneda: string | null;
  estado_comprobante: string | null;
};

const COLUMNAS = 22;
const FILAS_POR_LOTE = 400;

export class ComprobanteRepo {
  constructor(private readonly db: Db) {}

  /**
   * Reemplaza TODA la propuesta de un período por la que acaba de leerse (borrar + insertar, en una transacción:
   * o queda lo nuevo completo o queda lo anterior intacto).
   */
  async reemplazar(
    tenantId: number,
    libro: Libro,
    periodo: string,
    fase: Fase,
    ticketId: number | null,
    filas: ComprobanteLeido[],
  ): Promise<number> {
    await this.db.tx(async (tx) => {
      await tx.query("delete from sire_comprobantes where tenant_id = $1 and libro = $2 and per_tributario = $3 and fase = $4", [
        tenantId,
        libro,
        periodo,
        fase,
      ]);
      for (let i = 0; i < filas.length; i += FILAS_POR_LOTE) {
        const lote = filas.slice(i, i + FILAS_POR_LOTE);
        const params: unknown[] = [];
        const marcadores = lote.map((c) => {
          const base = params.length;
          params.push(
            tenantId,
            libro,
            periodo,
            fase,
            ticketId,
            c.carSunat,
            c.fecEmision,
            c.fecVcto,
            c.codTipoCdp,
            c.numSerieCdp,
            c.numCdp,
            c.codTipoDocContraparte,
            c.numDocContraparte,
            c.razonSocialContraparte,
            c.mtoBiGravada,
            c.mtoIgv,
            c.mtoBiNoGravada,
            c.mtoTotal,
            c.codMoneda,
            c.tipoCambio,
            c.estadoComprobante,
            JSON.stringify(c.datos),
          );
          return `(${Array.from({ length: COLUMNAS }, (_, k) => `$${base + k + 1}${k === COLUMNAS - 1 ? "::jsonb" : ""}`).join(", ")})`;
        });
        await tx.query(
          `insert into sire_comprobantes (tenant_id, libro, per_tributario, fase, ticket_id, car_sunat, fec_emision, fec_vcto,
             cod_tipo_cdp, num_serie_cdp, num_cdp, cod_tipo_doc_contraparte, num_doc_contraparte, razon_social_contraparte,
             mto_bi_gravada, mto_igv, mto_bi_no_gravada, mto_total, cod_moneda, tipo_cambio, estado_comprobante, datos)
           values ${marcadores.join(", ")}`,
          params,
        );
      }
    });
    return filas.length;
  }

  async totales(tenantId: number, libro: Libro, periodo: string, fase: Fase): Promise<Totales> {
    const r = (
      await this.db.query<{ n: number; bi: string; igv: string; total: string }>(
        `select count(*)::int as n, coalesce(sum(mto_bi_gravada), 0)::text as bi,
                coalesce(sum(mto_igv), 0)::text as igv, coalesce(sum(mto_total), 0)::text as total
         from sire_comprobantes where tenant_id = $1 and libro = $2 and per_tributario = $3 and fase = $4`,
        [tenantId, libro, periodo, fase],
      )
    )[0]!;
    return {
      total_comprobantes: Number(r.n),
      suma_bi_gravada: Number(r.bi),
      suma_igv: Number(r.igv),
      suma_total: Number(r.total),
    };
  }

  async listar(tenantId: number, libro: Libro, periodo: string, fase: Fase, pagina: number, porPagina: number) {
    const total = (await this.totales(tenantId, libro, periodo, fase)).total_comprobantes;
    const data = await this.db.query<ComprobanteFila>(
      `select id, car_sunat, fec_emision, cod_tipo_cdp, num_serie_cdp, num_cdp, cod_tipo_doc_contraparte,
              num_doc_contraparte, razon_social_contraparte, mto_bi_gravada::text, mto_igv::text,
              mto_bi_no_gravada::text, mto_total::text, cod_moneda, estado_comprobante
       from sire_comprobantes
       where tenant_id = $1 and libro = $2 and per_tributario = $3 and fase = $4
       order by fec_emision, num_serie_cdp, num_cdp, id
       limit $5 offset $6`,
      [tenantId, libro, periodo, fase, porPagina, (pagina - 1) * porPagina],
    );
    return { current_page: pagina, per_page: porPagina, total, data };
  }

  /**
   * Revisión rápida de la propuesta (sin salir a SUNAT): comprobantes repetidos y montos muy fuera de lo normal.
   * No decide nada por sí sola: son avisos para que alguien los mire.
   */
  async analizar(tenantId: number, libro: Libro, periodo: string, fase: Fase) {
    const totales = await this.totales(tenantId, libro, periodo, fase);
    const duplicados = await this.db.query<{ serie: string | null; numero: string | null; doc: string | null; veces: number }>(
      `select num_serie_cdp as serie, num_cdp as numero, num_doc_contraparte as doc, count(*)::int as veces
       from sire_comprobantes where tenant_id = $1 and libro = $2 and per_tributario = $3 and fase = $4
       group by num_serie_cdp, num_cdp, num_doc_contraparte having count(*) > 1`,
      [tenantId, libro, periodo, fase],
    );
    // "Fuera de lo normal": más de 3 desviaciones estándar sobre el promedio (solo si hay datos suficientes).
    const atipicos = await this.db.query<{ num_serie_cdp: string | null; num_cdp: string | null; mto_total: string }>(
      `with s as (
         select avg(mto_total) as media, stddev_pop(mto_total) as desv, count(*) as n
         from sire_comprobantes where tenant_id = $1 and libro = $2 and per_tributario = $3 and fase = $4
       )
       select c.num_serie_cdp, c.num_cdp, c.mto_total::text
       from sire_comprobantes c, s
       where c.tenant_id = $1 and c.libro = $2 and c.per_tributario = $3 and c.fase = $4
         and s.n >= 8 and s.desv > 0 and abs(c.mto_total - s.media) > 3 * s.desv
       order by c.mto_total desc limit 20`,
      [tenantId, libro, periodo, fase],
    );
    const conInconsistencia = (
      await this.db.query<{ n: number }>(
        `select count(*)::int as n from sire_comprobantes
         where tenant_id = $1 and libro = $2 and per_tributario = $3 and fase = $4
           and coalesce(datos ->> 'Incal', datos ->> 'Est. Comp.', '') not in ('', '0', '1')`,
        [tenantId, libro, periodo, fase],
      )
    )[0]!.n;
    return { totales, duplicados, atipicos, conInconsistencia: Number(conInconsistencia) };
  }
}
