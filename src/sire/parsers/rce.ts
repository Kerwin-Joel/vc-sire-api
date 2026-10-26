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
 * Propuesta de COMPRAS (RCE). Archivo con encabezado, campos separados por "|".
 * - Base imponible = BI de las tres clases de operación (gravadas con derecho a crédito, mixtas y sin derecho).
 * - IGV = suma de los tres IGV.
 * - No gravado = "Valor Adq. NG".
 * La primera columna "RUC" es la de la propia empresa; el proveedor viene en "Nro Doc Identidad".
 */
export function leerPropuestaRce(texto: string): ComprobanteLeido[] {
  const tabla = leerTablaPipe(texto);
  const indice = construirIndice(tabla);
  exigirColumnas(indice, REQUERIDAS, "compras (RCE)");

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
      mtoBiGravada: f.numero("bi gravado dg", "bi gravado dgng", "bi gravado dng"),
      mtoIgv: f.numero("igv ipm dg", "igv ipm dgng", "igv ipm dng"),
      mtoBiNoGravada: f.numero("valor adq ng"),
      mtoTotal: f.numero("total cp"),
      codMoneda: vacioANull(f.texto("moneda")),
      tipoCambio: parseNumeroOpc(f.texto("tipo de cambio")),
      estadoComprobante: vacioANull(f.texto("est comp")),
      datos: f.datos(),
    } satisfies ComprobanteLeido;
  });
}
