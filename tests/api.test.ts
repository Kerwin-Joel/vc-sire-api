import { beforeEach, describe, expect, it } from "vitest";
import { txtRce, txtRvie, zipDeTxt } from "../src/test/fixtures.js";
import { crearEntorno, EMPRESA } from "../src/test/entorno.js";

type Entorno = Awaited<ReturnType<typeof crearEntorno>>;
type Cuerpo = { estado: string; mensaje: string; datos: Record<string, any>; codigo_error?: string };

const ZIP_COMPRAS = zipDeTxt(
  txtRce([
    { fecha: "05/09/2026", tipo: "01", serie: "F001", numero: "123", ruc: "20111111112", razon: "PROVEEDOR UNO SAC", bi: "100.00", igv: "18.00", total: "118.00" },
    { fecha: "07/09/2026", tipo: "01", serie: "E001", numero: "9", ruc: "20222222223", razon: "SERVICIOS DOS EIRL", bi: "50.00", igv: "9.00", total: "59.00" },
    { fecha: "07/09/2026", tipo: "01", serie: "E001", numero: "9", ruc: "20222222223", razon: "SERVICIOS DOS EIRL", bi: "50.00", igv: "9.00", total: "59.00" },
  ]),
  "propuesta.txt",
  true,
);

const ZIP_VENTAS = zipDeTxt(
  txtRvie([
    { fecha: "20/09/2026", tipo: "03", serie: "EB01", numero: "1039", doc: "-", razon: "VARIOS", bi: "0.00", igv: "0.00", exonerado: "646.00", total: "646.00" },
    { fecha: "21/09/2026", tipo: "01", serie: "F001", numero: "5", doc: "20111111112", razon: "CLIENTE SAC", bi: "100.00", igv: "18.00", total: "118.00" },
  ]),
);

async function ir(e: Entorno, ruta: string, cabeceras: Record<string, string>, init: RequestInit = {}) {
  const res = await e.app.request(ruta, { ...init, headers: { ...cabeceras, ...(init.headers as Record<string, string>) } });
  return res;
}
const leer = async (r: Response) => (await r.json()) as Cuerpo;

describe("registro y autenticación", () => {
  let e: Entorno;
  beforeEach(async () => {
    e = await crearEntorno();
  });

  it("registra una empresa y entrega la api_key y el api_secret una sola vez", async () => {
    const r = await e.registrar();
    expect(r.status).toBe(201);
    expect(r.cuerpo.datos.api_key).toMatch(/^vsk_/);
    expect(r.cuerpo.datos.api_secret.length).toBeGreaterThan(30);
    const fila = (await e.db.query("select * from tenants"))[0] as Record<string, unknown>;
    expect(fila.sol_pass_enc).not.toContain(EMPRESA.sol_pass); // la Clave SOL se guarda cifrada
    expect(fila.client_secret_enc).not.toContain(EMPRESA.client_secret);
    expect(JSON.stringify(fila)).not.toContain(r.cuerpo.datos.api_secret); // el secreto de la API solo queda como hash
  });

  it("rechaza un RUC duplicado y datos inválidos", async () => {
    await e.registrar();
    expect((await e.registrar()).status).toBe(409);
    expect((await e.registrar({ ruc: "123" })).status).toBe(422);
  });

  it("si hay REGISTRATION_TOKEN, crear empresas lo exige", async () => {
    const protegido = await crearEntorno({ env: { REGISTRATION_TOKEN: "token-de-registro" } });
    const sin = await protegido.app.request("/api/v1/registro", protegido.json({ ...EMPRESA }));
    expect(sin.status).toBe(401);
    const con = await protegido.app.request("/api/v1/registro", {
      ...protegido.json({ ...EMPRESA }),
      headers: { "content-type": "application/json", authorization: "Bearer token-de-registro" },
    });
    expect(con.status).toBe(201);
  });

  it("las rutas del SIRE exigen credenciales válidas", async () => {
    const r = await e.registrar();
    expect((await e.app.request("/api/v1/sire/tickets")).status).toBe(401);
    expect((await ir(e, "/api/v1/sire/tickets", { ...r.cabeceras, "x-api-secret": "mal" })).status).toBe(401);
  });

  it("frena a quien prueba claves a lo loco (429)", async () => {
    await e.registrar();
    let ultimo = 0;
    for (let i = 0; i < 25; i++) {
      ultimo = (await e.app.request("/api/v1/sire/tickets", { headers: { "x-api-key": "vsk_x", "x-api-secret": "y", "x-forwarded-for": "9.9.9.9" } })).status;
    }
    expect(ultimo).toBe(429);
  });

  it("la salud responde sin credenciales y no revela secretos", async () => {
    expect((await e.app.request("/health")).status).toBe(200);
    const ready = await leer(await e.app.request("/ready"));
    expect(ready.datos).toMatchObject({ ok: true, sunat_live: false, escritura: false });
  });
});

describe("activación del SIRE", () => {
  it("activa cuando SUNAT acepta las credenciales", async () => {
    const e = await crearEntorno();
    const r = await e.empresaActiva();
    expect(r.activacion.status).toBe(200);
    const t = (await e.db.query("select sire_enabled from tenants"))[0] as { sire_enabled: boolean };
    expect(t.sire_enabled).toBe(true);
  });

  it("si SUNAT rechaza la clave, no activa y deja el motivo (y no reintenta)", async () => {
    const e = await crearEntorno();
    const r = await e.registrar({ sol_pass: "equivocada" });
    const a = await ir(e, "/api/v1/sire/activar", r.cabeceras, { method: "POST" });
    expect(a.status).toBe(401);
    const cuerpo = await leer(a);
    expect(cuerpo.mensaje).toMatch(/rechaz/i);
    const t = (await e.db.query("select sire_enabled, sire_last_error from tenants"))[0] as { sire_enabled: boolean; sire_last_error: string };
    expect(t.sire_enabled).toBe(false);
    expect(t.sire_last_error).toMatch(/rechaz/i);

    const antes = e.sunat.llamadas.length;
    await ir(e, "/api/v1/sire/activar", r.cabeceras, { method: "POST" });
    expect(e.sunat.llamadas.length).toBe(antes); // el segundo intento ni salió hacia SUNAT
  });

  it("corregir las credenciales permite volver a intentar al instante", async () => {
    const e = await crearEntorno();
    const r = await e.registrar({ sol_pass: "equivocada" });
    await ir(e, "/api/v1/sire/activar", r.cabeceras, { method: "POST" });
    const put = await ir(e, "/api/v1/empresa", r.cabeceras, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ sol_pass: EMPRESA.sol_pass }) });
    expect(put.status).toBe(200);
    const a = await ir(e, "/api/v1/sire/activar", r.cabeceras, { method: "POST" });
    expect(a.status).toBe(200);
  });

  it("sin activar, el resto del SIRE responde 403", async () => {
    const e = await crearEntorno();
    const r = await e.registrar();
    const res = await ir(e, "/api/v1/sire/periodos", r.cabeceras);
    expect(res.status).toBe(403);
    expect((await leer(res)).codigo_error).toBe("sire_no_activado");
  });

  it("con SUNAT_LIVE=false y los dominios reales, activar NO sale a internet", async () => {
    const e = await crearEntorno({ env: { SUNAT_API_BASE: "https://api-sire.sunat.gob.pe", SUNAT_AUTH_BASE: "https://api-seguridad.sunat.gob.pe" } });
    const r = await e.registrar();
    const a = await ir(e, "/api/v1/sire/activar", r.cabeceras, { method: "POST" });
    expect(a.status).toBe(503);
    expect((await leer(a)).codigo_error).toBe("sunat_live_desactivado");
    expect(e.sunat.huboLlamadas).toBe(false);
  });
});

describe("flujo completo: propuesta de compras", () => {
  it("pide la propuesta, sigue el ticket, baja el archivo y deja los comprobantes consultables", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_COMPRAS, consultasAntesDeTerminar: 2 } });
    const { cabeceras } = await e.empresaActiva();

    const sol = await leer(await ir(e, "/api/v1/sire/rce/202609/propuesta?formato=txt", cabeceras));
    expect(sol.datos.num_ticket).toBe("20260900000001");

    // Antes de que el worker corra: el ticket está en proceso y no hay comprobantes.
    const t0 = await leer(await ir(e, "/api/v1/sire/tickets/20260900000001", cabeceras));
    expect(t0.datos).toMatchObject({ finalizado: false, archivo_disponible: false });
    const vacio = await leer(await ir(e, "/api/v1/sire/rce/202609/comprobantes?fase=propuesta&per_page=200", cabeceras));
    expect(vacio.datos.totales.total_comprobantes).toBe(0);

    const trabajos = await e.k.worker.procesarPendientes();
    expect(trabajos).toBeGreaterThanOrEqual(3);

    const t1 = await leer(await ir(e, "/api/v1/sire/tickets/20260900000001", cabeceras));
    expect(t1.datos).toMatchObject({ finalizado: true, exitoso: true, archivo_disponible: true, estado: "06", cnt_cp_informados: 3 });

    const lista = await leer(await ir(e, "/api/v1/sire/rce/202609/comprobantes?fase=propuesta&per_page=200", cabeceras));
    expect(lista.datos.totales).toEqual({ total_comprobantes: 3, suma_bi_gravada: 200, suma_igv: 36, suma_total: 236 });
    const primero = lista.datos.comprobantes.data[0];
    expect(primero).toMatchObject({
      num_serie_cdp: "F001",
      num_cdp: "123",
      num_doc_proveedor: "20111111112",
      razon_social_proveedor: "PROVEEDOR UNO SAC",
      mto_total: "118.00",
      fec_emision: "2026-09-05",
    });
    expect(lista.datos.comprobantes).toMatchObject({ current_page: 1, per_page: 200, total: 3 });
  });

  it("volver a pedir la propuesta reemplaza lo anterior (no duplica)", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_COMPRAS, consultasAntesDeTerminar: 0 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rce/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();
    await ir(e, "/api/v1/sire/rce/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();
    const lista = await leer(await ir(e, "/api/v1/sire/rce/202609/comprobantes", cabeceras));
    expect(lista.datos.totales.total_comprobantes).toBe(3);
  });

  it("detecta duplicados en la revisión de la propuesta", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_COMPRAS, consultasAntesDeTerminar: 0 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rce/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();
    const r = await leer(await ir(e, "/api/v1/sire/rce/202609/reconciliar", cabeceras));
    expect(r.datos.totales.total_comprobantes).toBe(3);
    expect(r.datos.alertas.duplicados).toEqual([{ serie: "E001", numero: "9", doc: "20222222223", veces: 2 }]);
  });

  it("el archivo guardado se puede descargar sin consultar a SUNAT", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_COMPRAS, consultasAntesDeTerminar: 0 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rce/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();
    const llamadasAntes = e.sunat.llamadas.length;
    const res = await ir(e, "/api/v1/sire/tickets/20260900000001/archivo", cabeceras);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(0x50); // "P" de PK
    expect(e.sunat.llamadas.length).toBe(llamadasAntes);
  });

  it("antes de bajar el archivo responde 409", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_COMPRAS } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rce/202609/propuesta", cabeceras);
    expect((await ir(e, "/api/v1/sire/tickets/20260900000001/archivo", cabeceras)).status).toBe(409);
  });
});

describe("archivos guardados en Postgres (como en producción)", () => {
  it("el flujo completo funciona y el archivo descargado es idéntico al que entregó SUNAT", async () => {
    const e = await crearEntorno({ pgStorage: true, sunat: { zip: ZIP_COMPRAS, consultasAntesDeTerminar: 1 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rce/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();

    const lista = await leer(await ir(e, "/api/v1/sire/rce/202609/comprobantes", cabeceras));
    expect(lista.datos.totales.total_comprobantes).toBe(3);

    const res = await ir(e, "/api/v1/sire/tickets/20260900000001/archivo", cabeceras);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(ZIP_COMPRAS))).toBe(true);
    const guardados = await e.db.query<{ bytes: number }>("select bytes from archivos");
    expect(guardados).toHaveLength(1);
    expect(guardados[0]!.bytes).toBe(ZIP_COMPRAS.length);
  });
});

describe("flujo completo: propuesta de ventas", () => {
  it("lee las ventas y las entrega con los nombres que espera el portal", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_VENTAS, consultasAntesDeTerminar: 0 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rvie/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();
    const lista = await leer(await ir(e, "/api/v1/sire/rvie/202609/ventas?fase=propuesta&per_page=200", cabeceras));
    expect(lista.datos.totales).toMatchObject({ total_comprobantes: 2, suma_total: 764 });
    expect(lista.datos.ventas.data[0]).toMatchObject({ num_serie_cdp: "EB01", num_doc_adquiriente: "-", razon_social_adquiriente: "VARIOS", mto_bi_no_gravada: "646.00" });
  });

  it("mantiene separadas las compras y las ventas de un mismo período", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_VENTAS, consultasAntesDeTerminar: 0 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rvie/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();
    const compras = await leer(await ir(e, "/api/v1/sire/rce/202609/comprobantes", cabeceras));
    expect(compras.datos.totales.total_comprobantes).toBe(0);
  });
});

describe("tickets", () => {
  it("lista con filtros y paginación", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_VENTAS, consultasAntesDeTerminar: 0 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rvie/202609/propuesta", cabeceras);
    const todos = await leer(await ir(e, "/api/v1/sire/tickets?page=1", cabeceras));
    expect(todos.datos).toMatchObject({ current_page: 1, total: 1, last_page: 1 });
    const enProceso = await leer(await ir(e, "/api/v1/sire/tickets?finalizado=0", cabeceras));
    expect(enProceso.datos.total).toBe(1);
    const terminados = await leer(await ir(e, "/api/v1/sire/tickets?finalizado=1", cabeceras));
    expect(terminados.datos.total).toBe(0);
    const otroPeriodo = await leer(await ir(e, "/api/v1/sire/tickets?per_tributario=202501", cabeceras));
    expect(otroPeriodo.datos.total).toBe(0);
    expect((await ir(e, "/api/v1/sire/tickets?per_tributario=2026", cabeceras)).status).toBe(422);
  });

  it("«refrescar» consulta a SUNAT y deja el ticket al día", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_VENTAS, consultasAntesDeTerminar: 0 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rvie/202609/propuesta", cabeceras);
    const r = await leer(await ir(e, "/api/v1/sire/tickets/20260900000001/refrescar", cabeceras, { method: "POST" }));
    expect(r.datos).toMatchObject({ finalizado: true, estado: "06", libro: "rvie" });
  });

  it("un ticket de otra empresa no se ve", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_VENTAS } });
    const a = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rvie/202609/propuesta", a.cabeceras);
    const otra = await e.registrar({ ruc: "20888888881" });
    await ir(e, "/api/v1/sire/activar", otra.cabeceras, { method: "POST" }).catch(() => undefined);
    await e.db.query("update tenants set sire_enabled = true where ruc = '20888888881'");
    expect((await ir(e, "/api/v1/sire/tickets/20260900000001", otra.cabeceras)).status).toBe(404);
    expect((await leer(await ir(e, "/api/v1/sire/tickets", otra.cabeceras))).datos.total).toBe(0);
  });

  it("un ticket que SUNAT termina con errores queda terminado pero no exitoso", async () => {
    const e = await crearEntorno({ sunat: { zip: ZIP_VENTAS, consultasAntesDeTerminar: 0, estadoFinal: { cod: "03", des: "Procesado con Errores" } } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rvie/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();
    const t = await leer(await ir(e, "/api/v1/sire/tickets/20260900000001", cabeceras));
    expect(t.datos).toMatchObject({ finalizado: true, exitoso: false, estado_enum: "CON_ERRORES" });
  });

  it("si el worker no puede leer el archivo, el ticket lo dice y no se reintenta eternamente", async () => {
    const e = await crearEntorno({ sunat: { zip: zipDeTxt("A|B|C\r\n1|2|3"), consultasAntesDeTerminar: 0 } });
    const { cabeceras } = await e.empresaActiva();
    await ir(e, "/api/v1/sire/rce/202609/propuesta", cabeceras);
    await e.k.worker.procesarPendientes();
    const t = await leer(await ir(e, "/api/v1/sire/tickets/20260900000001", cabeceras));
    expect(t.datos.ultimo_error).toMatch(/formato esperado/);
    const fallidos = await e.db.query("select estado from jobs where estado = 'failed'");
    expect(fallidos).toHaveLength(1);
    expect(await e.db.query("select 1 from jobs where estado = 'queued'")).toHaveLength(0);
  });
});

describe("solo lectura", () => {
  it("aceptar la propuesta y registrar el preliminar están bloqueados y no tocan SUNAT", async () => {
    const e = await crearEntorno();
    const { cabeceras } = await e.empresaActiva();
    const antes = e.sunat.llamadas.length;
    for (const ruta of ["rce", "rvie"]) {
      for (const accion of ["aceptar-propuesta", "registrar-preliminar"]) {
        const r = await ir(e, `/api/v1/sire/${ruta}/202609/${accion}`, cabeceras, { method: "POST" });
        expect(r.status).toBe(403);
        expect((await leer(r)).codigo_error).toBe("escritura_deshabilitada");
      }
    }
    expect(e.sunat.llamadas.length).toBe(antes);
  });

  it("aunque se habiliten las escrituras, hoy responden «no implementado» (nada se envía)", async () => {
    const e = await crearEntorno({ env: { SIRE_WRITES_ENABLED: "true" } });
    const { cabeceras } = await e.empresaActiva();
    const antes = e.sunat.llamadas.length;
    const r = await ir(e, "/api/v1/sire/rce/202609/aceptar-propuesta", cabeceras, { method: "POST" });
    expect(r.status).toBe(501);
    expect(e.sunat.llamadas.length).toBe(antes);
  });
});

describe("períodos, constancia y reporte de cumplimiento", () => {
  it("entrega los períodos con la forma que usa el portal", async () => {
    const e = await crearEntorno();
    const { cabeceras } = await e.empresaActiva();
    const r = await leer(await ir(e, "/api/v1/sire/periodos?libro=rce", cabeceras));
    expect(r.datos.ejercicios[0]).toMatchObject({ anio: "2026", periodos: [{ per_tributario: "202609", cod_estado: "1", des_estado: "Habilitado" }, { per_tributario: "202608" }] });
    expect((await ir(e, "/api/v1/sire/periodos?libro=otro", cabeceras)).status).toBe(422);
  });

  it("entrega la constancia y el reporte de cumplimiento como PDF", async () => {
    const e = await crearEntorno();
    const { cabeceras } = await e.empresaActiva();
    const c = await ir(e, "/api/v1/sire/rce/constancia?nom_constancia=LE20999999991202609.pdf", cabeceras);
    expect(c.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await c.arrayBuffer()).subarray(0, 4).toString()).toBe("%PDF");
    const rc = await ir(e, "/api/v1/sire/rvie/202609/reporte-cumplimiento", cabeceras);
    expect(rc.headers.get("content-disposition")).toContain("reporte-cumplimiento.pdf");
    expect((await ir(e, "/api/v1/sire/rce/constancia?nom_constancia=../../etc/passwd", cabeceras)).status).toBe(422);
  });

  it("rechaza períodos mal escritos", async () => {
    const e = await crearEntorno();
    const { cabeceras } = await e.empresaActiva();
    expect((await ir(e, "/api/v1/sire/rce/2026-09/propuesta", cabeceras)).status).toBe(422);
    expect((await ir(e, "/api/v1/sire/rce/202613/comprobantes", cabeceras)).status).toBe(422);
  });
});
