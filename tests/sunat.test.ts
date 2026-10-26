import { describe, expect, it } from "vitest";
import { SunatError, SunatLiveDisabledError, WritesDisabledError } from "../src/errors.js";
import { createLogger } from "../src/logger.js";
import { clasificarEstado } from "../src/sire/tickets.js";
import { Guards, esHostSunat } from "../src/sunat/guard.js";
import { SunatHttp } from "../src/sunat/http.js";
import { SireClient, extraerPdf, interpretarTicket } from "../src/sunat/sire.js";
import { TokenService, type CredencialesSunat } from "../src/sunat/tokens.js";
import { PDF_MINIMO } from "../src/test/fixtures.js";
import { crearSunatFalso } from "../src/test/sunatFalso.js";

const cred: CredencialesSunat = {
  tenantId: 1,
  ruc: "20999999991",
  solUser: "USUARIO1",
  solPass: "Clave123",
  clientId: "cid-de-prueba",
  clientSecret: "csecret-de-prueba",
};
const falso = (extra = {}) =>
  crearSunatFalso({ ruc: cred.ruc, usuario: cred.solUser, clave: cred.solPass, clientId: cred.clientId, clientSecret: cred.clientSecret, ...extra });

const cfgBase = {
  SUNAT_AUTH_BASE: "https://api-seguridad.falso.test",
  SUNAT_API_BASE: "https://api-sire.falso.test",
  SUNAT_TIMEOUT_MS: 5_000,
  SUNAT_MIN_INTERVAL_MS: 0,
};
const log = createLogger("silent");
const sinEspera = async () => undefined;

function armar(sunat: ReturnType<typeof falso>, opts: { live?: boolean; writes?: boolean } = {}) {
  const guards = new Guards({ SUNAT_LIVE: opts.live ?? false, SIRE_WRITES_ENABLED: opts.writes ?? false });
  const tokens = new TokenService(cfgBase, guards, sunat.fetch);
  const http = new SunatHttp(cfgBase, tokens, guards, log, sunat.fetch, sinEspera);
  return { guards, tokens, http, sire: new SireClient(http) };
}

describe("interruptores de seguridad", () => {
  it("reconoce los dominios reales de SUNAT", () => {
    expect(esHostSunat("https://api-sire.sunat.gob.pe/v1/x")).toBe(true);
    expect(esHostSunat("https://api-seguridad.sunat.gob.pe/v1/x")).toBe(true);
    expect(esHostSunat("https://sunat.gob.pe/")).toBe(true);
    expect(esHostSunat("https://api-sire.falso.test/")).toBe(false);
    expect(esHostSunat("https://sunat.gob.pe.malo.com/")).toBe(false);
  });

  it("con SUNAT_LIVE=false NO sale ninguna petición hacia los dominios reales de SUNAT", async () => {
    const sunat = falso();
    const guards = new Guards({ SUNAT_LIVE: false, SIRE_WRITES_ENABLED: false });
    const cfgReal = { ...cfgBase, SUNAT_AUTH_BASE: "https://api-seguridad.sunat.gob.pe", SUNAT_API_BASE: "https://api-sire.sunat.gob.pe" };
    const tokens = new TokenService(cfgReal, guards, sunat.fetch);
    const http = new SunatHttp(cfgReal, tokens, guards, log, sunat.fetch, sinEspera);
    await expect(new SireClient(http).periodos(cred, "rce")).rejects.toBeInstanceOf(SunatLiveDisabledError);
    expect(sunat.huboLlamadas).toBe(false);
  });

  it("las operaciones de escritura se bloquean aunque SUNAT_LIVE esté activo", async () => {
    const sunat = falso();
    const { http } = armar(sunat, { live: true, writes: false });
    await expect(http.json(cred, { ruta: "/v1/lo-que-sea", escritura: true, metodo: "POST" })).rejects.toBeInstanceOf(WritesDisabledError);
    expect(sunat.llamadas.filter((l) => l.metodo === "POST" && !l.ruta.includes("oauth2")).length).toBe(0);
  });
});

describe("token de SUNAT", () => {
  it("lo pide una vez y lo reutiliza", async () => {
    const sunat = falso();
    const { tokens } = armar(sunat);
    const a = await tokens.obtener(cred);
    const b = await tokens.obtener(cred);
    expect(a).toBe(b);
    expect(sunat.tokensEmitidos).toBe(1);
  });

  it("si llegan varias peticiones a la vez, hace una sola petición de token", async () => {
    const sunat = falso();
    const { tokens } = armar(sunat);
    await Promise.all([tokens.obtener(cred), tokens.obtener(cred), tokens.obtener(cred), tokens.obtener(cred)]);
    expect(sunat.tokensEmitidos).toBe(1);
  });

  it("si SUNAT rechaza las credenciales NO reintenta con las mismas (protege la Clave SOL)", async () => {
    const sunat = falso();
    const { tokens } = armar(sunat);
    const mala = { ...cred, solPass: "equivocada" };
    await expect(tokens.obtener(mala)).rejects.toMatchObject({ codigo: "credenciales_rechazadas" });
    const intentosAntes = sunat.llamadas.length;
    await expect(tokens.obtener(mala)).rejects.toMatchObject({ codigo: "credenciales_rechazadas" });
    await expect(tokens.obtener(mala)).rejects.toMatchObject({ codigo: "credenciales_rechazadas" });
    expect(sunat.llamadas.length).toBe(intentosAntes); // las dos siguientes ni salieron
  });

  it("permite intentar de nuevo apenas cambian las credenciales", async () => {
    const sunat = falso();
    const { tokens } = armar(sunat);
    await expect(tokens.obtener({ ...cred, solPass: "equivocada" })).rejects.toBeInstanceOf(SunatError);
    await expect(tokens.obtener(cred)).resolves.toMatch(/^token-/);
  });

  it("no filtra la clave en el mensaje de error", async () => {
    const sunat = falso();
    const { tokens } = armar(sunat);
    const e = (await tokens.obtener({ ...cred, solPass: "SuperSecreta999" }).catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain("SuperSecreta999");
  });
});

describe("llamadas a los servicios", () => {
  it("lee los períodos habilitados", async () => {
    const { sire } = armar(falso());
    const r = await sire.periodos(cred, "rce");
    expect(r[0]?.periodos.map((p) => p.perTributario)).toEqual(["202609", "202608"]);
  });

  it("renueva el token una vez si SUNAT responde 401", async () => {
    const sunat = falso({ vencerTokenUnaVez: true });
    const { sire } = armar(sunat);
    await expect(sire.periodos(cred, "rvie")).resolves.toHaveLength(1);
    expect(sunat.tokensEmitidos).toBe(2);
  });

  it("reintenta las lecturas cuando SUNAT falla un momento (503)", async () => {
    const sunat = falso({ fallaUnaVez: { ruta: "/periodos", estado: 503 } });
    const { sire } = armar(sunat);
    await expect(sire.periodos(cred, "rce")).resolves.toHaveLength(1);
    expect(sunat.llamadas.filter((l) => l.ruta.endsWith("/periodos")).length).toBe(2);
  });

  it("pide la propuesta de compras y de ventas por sus rutas oficiales", async () => {
    const sunat = falso();
    const { sire } = armar(sunat);
    expect(await sire.exportarPropuesta(cred, "rce", "202609")).toBe("20260900000001");
    expect(await sire.exportarPropuesta(cred, "rvie", "202609")).toBe("20260900000001");
    const rutas = sunat.llamadas.map((l) => l.ruta);
    expect(rutas).toContain("/v1/contribuyente/migeigv/libros/rce/propuesta/web/propuesta/202609/exportacioncomprobantepropuesta");
    expect(rutas).toContain("/v1/contribuyente/migeigv/libros/rvie/propuesta/web/propuesta/202609/exportapropuesta");
    const rce = sunat.llamadas.find((l) => l.ruta.endsWith("exportacioncomprobantepropuesta"))!;
    expect(rce.query).toMatchObject({ codTipoArchivo: "0", codOrigenEnvio: "2" });
  });

  it("consulta el ticket con el código de libro correcto", async () => {
    const sunat = falso({ consultasAntesDeTerminar: 0 });
    const { sire } = armar(sunat);
    const t = await sire.estadoTicket(cred, "rvie", "202609", "20260900000001");
    expect(t).toMatchObject({ codEstado: "06", desEstado: "Terminado", cntCpInformados: 3 });
    expect(sunat.llamadas.at(-1)!.query).toMatchObject({ codLibro: "140000", numTicket: "20260900000001", perIni: "202609", perFin: "202609" });
  });

  it("descarga la constancia y el reporte de cumplimiento (PDF dentro de JSON en base64)", async () => {
    const { sire } = armar(falso());
    const c = await sire.constancia(cred, "rce", "LE20999999991202609.pdf");
    expect(Buffer.from(c.pdf).subarray(0, 4).toString()).toBe("%PDF");
    const r = await sire.reporteCumplimiento(cred, "rvie", "202609");
    expect(r.nombre).toBe("reporte-cumplimiento.pdf");
    expect(Buffer.from(r.pdf).subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("interpretación de respuestas", () => {
  it("devuelve null si SUNAT no trae registros", () => {
    expect(interpretarTicket({ registros: [] })).toBeNull();
    expect(interpretarTicket(null)).toBeNull();
  });

  it("entiende el campo con la errata «codTipoAchivoReporte» y también el correcto", () => {
    const base = { registros: [{ numTicket: "1", archivoReporte: [{ nomArchivoReporte: "a.zip" }] }] };
    const a = interpretarTicket({ registros: [{ ...base.registros[0], archivoReporte: [{ codTipoAchivoReporte: "01", nomArchivoReporte: "a.zip" }] }] });
    const b = interpretarTicket({ registros: [{ ...base.registros[0], archivoReporte: [{ codTipoArchivoReporte: "02", nomArchivoReporte: "a.zip" }] }] });
    expect(a?.archivos[0]?.codTipo).toBe("01");
    expect(b?.archivos[0]?.codTipo).toBe("02");
  });

  it("acepta un PDF directo o dentro de JSON", () => {
    expect(extraerPdf(PDF_MINIMO, "application/pdf").pdf).toEqual(PDF_MINIMO);
    const json = new Uint8Array(Buffer.from(JSON.stringify({ archivoPdf: Buffer.from(PDF_MINIMO).toString("base64") })));
    expect(Buffer.from(extraerPdf(json, "application/json").pdf).subarray(0, 4).toString()).toBe("%PDF");
    expect(() => extraerPdf(new Uint8Array(Buffer.from("{}")), "application/json")).toThrow(/no entregó el PDF/);
  });
});

describe("estado de los tickets", () => {
  it("decide por la descripción de SUNAT", () => {
    expect(clasificarEstado("06", "Terminado")).toEqual({ finalizado: true, exitoso: true });
    expect(clasificarEstado("04", "Procesado sin errores (concluido)")).toEqual({ finalizado: true, exitoso: true });
    expect(clasificarEstado("03", "Procesado con Errores")).toEqual({ finalizado: true, exitoso: false });
    expect(clasificarEstado("05", "En proceso")).toEqual({ finalizado: false, exitoso: false });
    expect(clasificarEstado("02", "Validando Archivo (en proceso)")).toEqual({ finalizado: false, exitoso: false });
    expect(clasificarEstado("01", "Cargado (solicitado)")).toEqual({ finalizado: false, exitoso: false });
  });

  it("si no hay descripción reconocible, usa el código", () => {
    expect(clasificarEstado("06", null)).toEqual({ finalizado: true, exitoso: true });
    expect(clasificarEstado("03", "")).toEqual({ finalizado: true, exitoso: false });
    expect(clasificarEstado("99", "???")).toEqual({ finalizado: false, exitoso: false });
  });
});
