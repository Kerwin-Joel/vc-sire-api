/**
 * ENSAYO GENERAL antes de desplegar. Recorre el flujo real de punta a punta con piezas de verdad, salvo SUNAT:
 *   • el servidor COMPILADO (`node dist/server.js`), como correrá en producción;
 *   • Postgres por red (cliente `pg`), con los archivos de SUNAT guardados en la base;
 *   • el worker dentro del mismo proceso (RUN_WORKER_IN_API=true), como en Render;
 *   • un SUNAT simulado que atiende por HTTP en este mismo equipo.
 * No sale nada a internet ni a SUNAT. Uso:  npm run build && npm run ensayo
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { serve } from "@hono/node-server";
import { txtRce, zipDeTxt } from "../src/test/fixtures.js";
import { crearSunatFalso } from "../src/test/sunatFalso.js";

const EMPRESA = { ruc: "20999999991", usuario: "USUARIO1", clave: "Clave123", clientId: "cid-ensayo", clientSecret: "csecret-ensayo" };

const puertoLibre = () =>
  new Promise<number>((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

let fallos = 0;
const paso = (ok: boolean, texto: string, detalle = "") => {
  if (!ok) fallos++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${texto}${detalle ? `  → ${detalle}` : ""}`);
};
const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

const zip = zipDeTxt(
  txtRce([
    { fecha: "05/09/2026", tipo: "01", serie: "F001", numero: "123", ruc: "20111111112", razon: "PROVEEDOR UNO SAC", bi: "100.00", igv: "18.00", total: "118.00" },
    { fecha: "07/09/2026", tipo: "01", serie: "E001", numero: "9", ruc: "20222222223", razon: "SERVICIOS DOS EIRL", bi: "50.00", igv: "9.00", total: "59.00" },
  ]),
  "propuesta.txt",
  true,
);

console.log("\nEnsayo general de la API del SIRE\n");

// 1) Postgres por red
const pglite = new PGlite();
const puertoDb = await puertoLibre();
const dbServidor = new PGLiteSocketServer({ db: pglite, port: puertoDb, host: "127.0.0.1", maxConnections: 1 });
await dbServidor.start();

// 2) SUNAT simulado por HTTP
const sunat = crearSunatFalso({ ...EMPRESA, ruc: EMPRESA.ruc, usuario: EMPRESA.usuario, clave: EMPRESA.clave, zip, consultasAntesDeTerminar: 1 });
const puertoSunat = await puertoLibre();
const sunatServidor = serve({ fetch: (req) => sunat.fetch(req), port: puertoSunat, hostname: "127.0.0.1" });

// 3) La API compilada
const puertoApi = await puertoLibre();
const api = spawn(process.execPath, ["dist/server.js"], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(puertoApi),
    LOG_LEVEL: "warn",
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${puertoDb}/postgres`,
    DB_POOL_MAX: "1", // la base simulada del ensayo admite una sola conexión
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
    API_KEY_PEPPER: "pepper-del-ensayo-bien-largo",
    REGISTRATION_TOKEN: "token-del-ensayo",
    SUNAT_API_BASE: `http://127.0.0.1:${puertoSunat}`,
    SUNAT_AUTH_BASE: `http://127.0.0.1:${puertoSunat}`,
    SUNAT_LIVE: "false", // el servidor falso NO es un dominio de SUNAT, así que igual se permite
    SIRE_WRITES_ENABLED: "false",
    SUNAT_MIN_INTERVAL_MS: "0",
    TICKET_FIRST_POLL_MS: "200",
    TICKET_POLL_INTERVAL_MS: "300",
    WORKER_INTERVAL_MS: "200",
    STORAGE_DRIVER: "postgres",
    RUN_WORKER_IN_API: "true",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const base = `http://127.0.0.1:${puertoApi}`;
const llamar = async (ruta: string, init: RequestInit = {}) => {
  const r = await fetch(base + ruta, init);
  const tipo = r.headers.get("content-type") ?? "";
  return { status: r.status, tipo, json: tipo.includes("json") ? ((await r.json()) as Record<string, any>) : null, res: r };
};

try {
  // Esperar a que arranque (aplica migraciones al iniciar)
  let listo = false;
  for (let i = 0; i < 60 && !listo; i++) {
    listo = await fetch(base + "/health").then((r) => r.ok, () => false);
    if (!listo) await espera(250);
  }
  paso(listo, "El servidor compilado arrancó y aplicó las migraciones");
  if (!listo) throw new Error("La API no arrancó.");

  const ready = await llamar("/ready");
  paso(ready.json?.datos?.sunat_live === false && ready.json?.datos?.escritura === false, "Los dos interruptores de seguridad están apagados");

  const sinToken = await llamar("/api/v1/registro", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  paso(sinToken.status === 401, "Crear empresas sin el token de registro es rechazado", `HTTP ${sinToken.status}`);

  const reg = await llamar("/api/v1/registro", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer token-del-ensayo" },
    body: JSON.stringify({
      proposito: "sire",
      ruc: EMPRESA.ruc,
      razon_social: "EMPRESA DE ENSAYO SAC",
      sol_user: EMPRESA.usuario,
      sol_pass: EMPRESA.clave,
      client_id: EMPRESA.clientId,
      client_secret: EMPRESA.clientSecret,
    }),
  });
  paso(reg.status === 201 && !!reg.json?.datos?.api_key, "Registro de la empresa con el token", `HTTP ${reg.status}`);
  const cab = { "x-api-key": String(reg.json?.datos?.api_key), "x-api-secret": String(reg.json?.datos?.api_secret) };

  const act = await llamar("/api/v1/sire/activar", { method: "POST", headers: cab });
  paso(act.status === 200, "SUNAT acepta las credenciales y se activa el SIRE", `HTTP ${act.status}`);

  const per = await llamar("/api/v1/sire/periodos?libro=rce", { headers: cab });
  paso(per.json?.datos?.ejercicios?.[0]?.periodos?.length === 2, "Lista los períodos habilitados");

  const prop = await llamar("/api/v1/sire/rce/202609/propuesta?formato=txt", { headers: cab });
  const num = prop.json?.datos?.num_ticket as string | undefined;
  paso(!!num, "Pide la propuesta y recibe el número de ticket", num);

  let ticket: Record<string, any> | undefined;
  for (let i = 0; i < 60; i++) {
    ticket = (await llamar(`/api/v1/sire/tickets/${num}`, { headers: cab })).json?.datos;
    if (ticket?.finalizado && ticket?.archivo_disponible) break;
    await espera(250);
  }
  paso(!!ticket?.finalizado && !!ticket?.exitoso, "El worker (dentro de la API) sigue el ticket hasta que termina", String(ticket?.estado_descripcion));
  paso(!!ticket?.archivo_disponible, "Baja el archivo y lo guarda en Postgres");

  let lista: Record<string, any> | undefined;
  for (let i = 0; i < 40; i++) {
    lista = (await llamar("/api/v1/sire/rce/202609/comprobantes?fase=propuesta&per_page=200", { headers: cab })).json?.datos;
    if (lista?.totales?.total_comprobantes) break;
    await espera(250);
  }
  paso(lista?.totales?.total_comprobantes === 2 && lista?.totales?.suma_total === 177, "Lee la propuesta y entrega los comprobantes", JSON.stringify(lista?.totales));

  const arch = await llamar(`/api/v1/sire/tickets/${num}/archivo`, { headers: cab });
  const bytes = Buffer.from(await arch.res.arrayBuffer());
  paso(arch.status === 200 && bytes.equals(Buffer.from(zip)), "El archivo descargado es idéntico al que entregó SUNAT", `${bytes.length} bytes`);

  const w = await llamar("/api/v1/sire/rce/202609/aceptar-propuesta", { method: "POST", headers: cab });
  paso(w.status === 403 && w.json?.codigo_error === "escritura_deshabilitada", "Aceptar la propuesta está bloqueado (solo lectura)", `HTTP ${w.status}`);

  const sinCred = await llamar("/api/v1/sire/tickets", {});
  paso(sinCred.status === 401, "Sin credenciales de la API responde 401");
} catch (e) {
  fallos++;
  console.error("  ✗ El ensayo se interrumpió:", e instanceof Error ? e.message : e);
} finally {
  api.kill();
  sunatServidor.close();
  await dbServidor.stop();
  await pglite.close();
}

console.log(fallos === 0 ? "\nENSAYO APROBADO: todo funciona de punta a punta, sin tocar SUNAT.\n" : `\nENSAYO CON ${fallos} PROBLEMA(S).\n`);
process.exit(fallos === 0 ? 0 : 1);
