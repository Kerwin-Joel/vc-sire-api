import { PDF_MINIMO } from "./fixtures.js";

export interface OpcionesSunatFalso {
  ruc: string;
  usuario: string;
  clave: string;
  clientId: string;
  clientSecret: string;
  /** ZIP que entrega el servicio de descarga de archivos. */
  zip?: Uint8Array;
  /** Cuántas veces se consulta el ticket antes de que SUNAT lo dé por terminado. */
  consultasAntesDeTerminar?: number;
  /** Código y descripción final del ticket. */
  estadoFinal?: { cod: string; des: string };
  /** Si se indica, el siguiente request a esta ruta (substring) responde ese estado una vez. */
  fallaUnaVez?: { ruta: string; estado: number };
  /** Hace que el servicio de periodos responda 401 una vez (para probar la renovación del token). */
  vencerTokenUnaVez?: boolean;
}

export interface Llamada {
  metodo: string;
  url: string;
  ruta: string;
  query: Record<string, string>;
  autorizado: boolean;
}

/**
 * Un SUNAT de mentira, en memoria: responde con el MISMO formato que los manuales oficiales. Así se prueba todo el
 * flujo (token, propuesta, ticket, descarga, constancia…) sin salir a internet.
 */
export function crearSunatFalso(o: OpcionesSunatFalso) {
  const llamadas: Llamada[] = [];
  let consultasTicket = 0;
  let tokensEmitidos = 0;
  let venceUnaVez = !!o.vencerTokenUnaVez;
  let fallaPendiente = o.fallaUnaVez ? { ...o.fallaUnaVez } : null;
  const tokenValido = () => `token-${tokensEmitidos}`;

  const json = (cuerpo: unknown, status = 200) =>
    new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

  const fetchFalso: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    // Sirve igual si lo llama el código con (url, opciones) o si lo recibe un servidor HTTP como un Request completo.
    const pedido = typeof input === "object" && "headers" in input && "method" in input ? (input as Request) : null;
    const metodo = (init?.method ?? pedido?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers ?? pedido?.headers).get("authorization") ?? "";
    const query = Object.fromEntries(url.searchParams.entries());
    const llamada: Llamada = { metodo, url: url.toString(), ruta: url.pathname, query, autorizado: auth === `Bearer ${tokenValido()}` };
    llamadas.push(llamada);

    // ── Autenticación ──
    if (url.pathname.includes("/oauth2/token")) {
      const cuerpo =
        init?.body instanceof URLSearchParams ? init.body : new URLSearchParams(init?.body ? String(init.body) : pedido ? await pedido.text() : "");
      const ok =
        cuerpo.get("username") === `${o.ruc}${o.usuario}` &&
        cuerpo.get("password") === o.clave &&
        cuerpo.get("client_id") === o.clientId &&
        cuerpo.get("client_secret") === o.clientSecret &&
        url.pathname.includes(`/clientessol/${o.clientId}/`);
      if (!ok) return json({ error: "invalid_grant", error_description: "Usuario o clave incorrectos" }, 400);
      tokensEmitidos++;
      return json({ access_token: tokenValido(), token_type: "Bearer", expires_in: 3600 });
    }

    // ── Todo lo demás exige token ──
    if (!llamada.autorizado) return json({ cod: "401", msg: "Unauthorized" }, 401);

    if (fallaPendiente && url.pathname.includes(fallaPendiente.ruta)) {
      const { estado } = fallaPendiente;
      fallaPendiente = null;
      return json({ cod: String(estado), msg: "falla simulada" }, estado);
    }

    if (venceUnaVez && url.pathname.includes("/periodos")) {
      venceUnaVez = false;
      return json({ cod: "401", msg: "token vencido" }, 401);
    }

    if (url.pathname.includes("/padron/web/omisos/") && url.pathname.endsWith("/periodos")) {
      return json([
        {
          numEjercicio: "2026",
          desEstado: "Ejercicio abierto",
          lisPeriodos: [
            { perTributario: "202609", codEstado: "1", desEstado: "Habilitado" },
            { perTributario: "202608", codEstado: "1", desEstado: "Habilitado" },
          ],
        },
      ]);
    }

    if (url.pathname.endsWith("/exportacioncomprobantepropuesta") || url.pathname.endsWith("/exportapropuesta")) {
      return json({ numTicket: "20260900000001" });
    }

    if (url.pathname.endsWith("/consultaestadotickets")) {
      consultasTicket++;
      const terminado = consultasTicket > (o.consultasAntesDeTerminar ?? 1);
      const final = o.estadoFinal ?? { cod: "06", des: "Terminado" };
      const nombre = "20999999991-202609-propuesta.zip";
      return json({
        paginacion: { page: 1, perPage: 20, totalRegistros: 1 },
        registros: [
          {
            perTributario: query.perIni,
            numTicket: query.numTicket,
            codProceso: "10",
            desProceso: "Generar archivo exportar propuesta",
            codEstadoProceso: terminado ? final.cod : "05",
            desEstadoProceso: terminado ? final.des : "En proceso",
            nomArchivoImportacion: null,
            detalleTicket: terminado
              ? { numTicket: query.numTicket, nomArchivoReporte: nombre, cntFilasvalidada: 3, cntCPError: 0, cntCPInformados: 3 }
              : { numTicket: query.numTicket },
            archivoReporte: terminado ? [{ codTipoAchivoReporte: "01", nomArchivoReporte: nombre, nomArchivoContenido: "propuesta.txt" }] : [],
          },
        ],
      });
    }

    if (url.pathname.endsWith("/archivoreporte")) {
      return new Response(Buffer.from(o.zip ?? new Uint8Array()), { status: 200, headers: { "content-type": "application/zip" } });
    }

    if (url.pathname.includes("/constancia/")) {
      return json({ archivoPdf: Buffer.from(PDF_MINIMO).toString("base64") });
    }

    if (url.pathname.includes("/consultaReporteCumplimiento/")) {
      return json({ archivoPdf: Buffer.from(PDF_MINIMO).toString("base64"), nombreArchivoPdf: "reporte-cumplimiento.pdf" });
    }

    return json({ cod: "404", msg: `Ruta no simulada: ${url.pathname}` }, 404);
  };

  return {
    fetch: fetchFalso,
    llamadas,
    get tokensEmitidos() {
      return tokensEmitidos;
    },
    get consultasTicket() {
      return consultasTicket;
    },
    /** ¿Alguna petición salió hacia SUNAT (cualquiera)? */
    get huboLlamadas() {
      return llamadas.length > 0;
    },
  };
}
