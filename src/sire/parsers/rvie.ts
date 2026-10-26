import {
  Fila,
  construirIndice,
  exigirColumnas,
  leerTablaPipe,
  parseFecha,
  parseNumeroOpc,
  vacioANull,
  type ComprobanteLeido,
} from "./comun.js";

const REQUERIDAS = ["fecha de emision", "tipo cp doc", "serie del cdp", "nro cp o doc nro inicial rango", "total cp"];

/**
 * Propuesta de VENTAS (RVIE). Archivo con encabezado, campos separados por "|".
 * - Base imponible = "BI Gravada" y IGV = "IGV / IPM" (los descuentos quedan en `datos`, no se restan: SUNAT ya los
 *   informa en esas columnas).
 * - No gravado = "Mto Exonerado" + "Mto Inafecto".
 * La primera columna "Ruc" es la de la propia empresa; el cliente viene en "Nro Doc Identidad".
 */
export function leerPropuestaRvie(texto: string): ComprobanteLeido[] {
  const tabla = leerTablaPipe(texto);
  const indice = construirIndice(tabla);
  exigirColumnas(indice, REQUERIDAS, "ventas (RVIE)");

  return tabla.filas.map((valores) => {
    const f = new Fila(indice, valores, tabla);
    return {
      carSunat: vacioANull(f.texto("car sunat")),
      fecEmision: parseFecha(f.texto("fecha de emision")),
      fecVcto: parseFecha(f.texto("fecha vcto pago")),
      codTipoCdp: vacioANull(f.texto("tipo cp doc")),
      numSerieCdp: vacioANull(f.texto("serie del cdp")),
      numCdp: vacioANull(f.texto("nro cp o doc nro inicial rango")),
      codTipoDocContraparte: vacioANull(f.texto("tipo doc identidad")),
      numDocContraparte: vacioANull(f.texto("nro doc identidad")),
      razonSocialContraparte: vacioANull(f.texto("apellidos nombres razon social")),
      mtoBiGravada: f.numero("bi gravada"),
      mtoIgv: f.numero("igv ipm"),
      mtoBiNoGravada: f.numero("mto exonerado", "mto inafecto"),
      mtoTotal: f.numero("total cp"),
      codMoneda: vacioANull(f.texto("moneda")),
      tipoCambio: parseNumeroOpc(f.texto("tipo cambio")),
      estadoComprobante: vacioANull(f.texto("est comp")),
      datos: f.datos(),
    } satisfies ComprobanteLeido;
  });
}
