import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { decodificarTexto, normalizarEncabezado, parseFecha, parseNumero } from "../src/sire/parsers/comun.js";
import { extraerTxt, leerPropuesta } from "../src/sire/parsers/index.js";
import { txtRce, txtRvie, zipDeTxt } from "../src/test/fixtures.js";

describe("utilidades de lectura", () => {
  it("normaliza los encabezados sin tildes ni signos", () => {
    expect(normalizarEncabezado("Nro CP o Doc. Nro Inicial (Rango)")).toBe("nro cp o doc nro inicial rango");
    expect(normalizarEncabezado("Fecha de emisión")).toBe("fecha de emision");
    expect(normalizarEncabezado("Apellidos Nombres/ Razón  Social")).toBe("apellidos nombres razon social");
    expect(normalizarEncabezado("IGV / IPM DG")).toBe("igv ipm dg");
  });

  it("lee fechas dd/mm/aaaa y números", () => {
    expect(parseFecha("05/09/2026")).toBe("2026-09-05");
    expect(parseFecha("")).toBeNull();
    expect(parseFecha("2026-09-05")).toBeNull();
    expect(parseNumero("1,234.50")).toBe(1234.5);
    expect(parseNumero("")).toBe(0);
    expect(parseNumero("-12.30")).toBe(-12.3);
  });

  it("decodifica UTF-8 y, si no lo es, Windows-1252 (los archivos de SUNAT vienen de las dos formas)", () => {
    expect(decodificarTexto(new Uint8Array(Buffer.from("Razón social", "utf8")))).toBe("Razón social");
    expect(decodificarTexto(new Uint8Array(Buffer.from("Razón social", "latin1")))).toBe("Razón social");
    const conBom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from("RUC", "utf8")]);
    expect(decodificarTexto(conBom)).toBe("RUC");
  });
});

describe("propuesta de compras (RCE)", () => {
  const filas = [
    { fecha: "05/09/2026", tipo: "01", serie: "F001", numero: "123", ruc: "20111111112", razon: "PROVEEDOR UNO SAC", bi: "100.00", igv: "18.00", total: "118.00" },
    { fecha: "07/09/2026", tipo: "01", serie: "E001", numero: "9", ruc: "20222222223", razon: "SERVICIOS DOS EIRL", bi: "50.00", igv: "9.00", noGravado: "10.00", total: "69.00" },
  ];

  it("lee los comprobantes por nombre de columna", () => {
    const r = leerPropuesta("rce", zipDeTxt(txtRce(filas), "p.txt", true)); // en Windows-1252, con la "ó" de "Razón"
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({
      fecEmision: "2026-09-05",
      codTipoCdp: "01",
      numSerieCdp: "F001",
      numCdp: "123",
      numDocContraparte: "20111111112",
      razonSocialContraparte: "PROVEEDOR UNO SAC",
      mtoBiGravada: 100,
      mtoIgv: 18,
      mtoTotal: 118,
      codMoneda: "PEN",
    });
    expect(r[1]).toMatchObject({ mtoBiNoGravada: 10, mtoTotal: 69 });
  });

  it("suma las tres clases de base imponible y de IGV", () => {
    const base = txtRce([filas[0]!]).split("\r\n");
    const cols = base[0]!.split("|");
    const fila = base[1]!.split("|");
    fila[cols.indexOf("BI Gravado DGNG")] = "20.00";
    fila[cols.indexOf("IGV / IPM DGNG")] = "3.60";
    fila[cols.indexOf("BI Gravado DNG")] = "5.00";
    fila[cols.indexOf("IGV / IPM DNG")] = "0.90";
    const [c] = leerPropuesta("rce", new Uint8Array(Buffer.from([base[0], fila.join("|")].join("\r\n"), "utf8")));
    expect(c!.mtoBiGravada).toBe(125);
    expect(c!.mtoIgv).toBe(22.5);
  });

  it("guarda la fila completa por nombre de columna, sin los vacíos", () => {
    const [c] = leerPropuesta("rce", zipDeTxt(txtRce([filas[0]!])));
    expect(c!.datos["Tipo CP/Doc."]).toBe("01");
    expect(c!.datos["ISC"]).toBeUndefined();
  });
});

describe("propuesta de ventas (RVIE)", () => {
  it("lee los comprobantes y suma exonerado e inafecto como no gravado", () => {
    const r = leerPropuesta(
      "rvie",
      zipDeTxt(
        txtRvie([
          { fecha: "20/09/2026", tipo: "03", serie: "EB01", numero: "1039", doc: "-", razon: "VARIOS", bi: "0.00", igv: "0.00", exonerado: "646.00", total: "646.00" },
          { fecha: "21/09/2026", tipo: "01", serie: "F001", numero: "5", doc: "20111111112", razon: "CLIENTE SAC", bi: "100.00", igv: "18.00", total: "118.00" },
        ]),
      ),
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ numSerieCdp: "EB01", numCdp: "1039", mtoBiNoGravada: 646, mtoTotal: 646, codTipoDocContraparte: "0" });
    expect(r[1]).toMatchObject({ mtoBiGravada: 100, mtoIgv: 18, mtoTotal: 118, numDocContraparte: "20111111112" });
  });
});

describe("archivos con problemas", () => {
  it("avisa con claridad si faltan columnas", () => {
    expect(() => leerPropuesta("rce", new Uint8Array(Buffer.from("A|B|C\r\n1|2|3")))).toThrow(/faltan las columnas/);
  });

  it("avisa si el archivo está vacío", () => {
    expect(() => leerPropuesta("rvie", new Uint8Array())).toThrow(/vacío/);
  });

  it("acepta un TXT suelto (sin ZIP)", () => {
    const txt = new Uint8Array(Buffer.from(txtRce([{ fecha: "01/09/2026", tipo: "01", serie: "F001", numero: "1", ruc: "20111111112", razon: "X", bi: "1.00", igv: "0.18", total: "1.18" }])));
    expect(leerPropuesta("rce", txt)).toHaveLength(1);
  });

  it("rechaza un ZIP sin ningún .txt y un ZIP dañado", () => {
    expect(() => extraerTxt(zipSync({ "datos.csv": new Uint8Array([1, 2, 3]) }))).toThrow(/ningún archivo \.txt/);
    expect(() => extraerTxt(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6]))).toThrow(/dañado/);
  });
});
