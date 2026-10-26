import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { ZodError, z } from "zod";
import type { Container } from "../container.js";
import { AppError } from "../errors.js";
import type { Fase } from "../sire/comprobantes.js";
import type { Tenant } from "../sire/tenants.js";
import type { Libro } from "../sunat/sire.js";
import { exito, falla } from "./envelope.js";
import { LimiteIntentos, limitarCuerpo, origenDe } from "./limite.js";
import { presentarComprobante, presentarPeriodos, presentarTicket } from "./presenters.js";

type Entorno = { Variables: { tenant: Tenant } };

const periodoSchema = z
  .string()
  .regex(/^\d{4}(0[1-9]|1[0-2])$/, "El período debe tener el formato AAAAMM (por ejemplo 202609).");
const libroSchema = z.enum(["rce", "rvie"]);
const faseSchema = z.enum(["propuesta", "preliminar", "registrado"]).default("propuesta");
const entero = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def);

const registroSchema = z.object({
  proposito: z.string().optional(),
  entorno: z.string().optional(),
  ruc: z.string().regex(/^\d{11}$/, "El RUC debe tener 11 dígitos."),
  razon_social: z.string().trim().min(2, "Falta la razón social."),
  direccion: z.string().optional(),
  ubigeo: z.string().optional(),
  departamento: z.string().optional(),
  provincia: z.string().optional(),
  distrito: z.string().optional(),
  sol_user: z.string().trim().min(1).optional(),
  sol_pass: z.string().min(1).optional(),
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().min(1).optional(),
});

const credencialesSchema = z.object({
  sol_user: z.string().trim().min(1).optional(),
  sol_pass: z.string().min(1).optional(),
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().min(1).optional(),
});

function igualesSeguro(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function jsonSeguro<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let cuerpo: unknown;
  try {
    cuerpo = await c.req.json();
  } catch {
    throw new AppError("El cuerpo de la petición debe ser JSON.", 400, "json_invalido");
  }
  return schema.parse(cuerpo);
}

export function crearApp(k: Container): Hono<Entorno> {
  const app = new Hono<Entorno>();
  const limite = new LimiteIntentos();

  app.use("*", limitarCuerpo(1024 * 1024));

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      const primero = err.issues[0];
      return falla(c, primero?.message ?? "Datos inválidos.", 422, "datos_invalidos", err.issues.map((i) => ({ campo: i.path.join("."), mensaje: i.message })));
    }
    if (err instanceof AppError) {
      return falla(c, err.message, err.status as 400, err.codigo, err.detalle);
    }
    k.log.error({ err: err instanceof Error ? err.message : String(err), ruta: c.req.path }, "error no controlado");
    return falla(c, "Ocurrió un error inesperado en el servidor.", 500, "error_interno");
  });

  app.notFound((c) => falla(c, "Ruta no encontrada.", 404, "no_encontrado"));

  // ─── Salud (sin autenticación) ───────────────────────────────────────────────
  app.get("/health", (c) => exito(c, { ok: true }));
  app.get("/ready", async (c) => {
    await k.db.query("select 1");
    return exito(c, { ok: true, sunat_live: k.cfg.SUNAT_LIVE, escritura: k.guards.writesEnabled });
  });

  // ─── Alta de empresas ────────────────────────────────────────────────────────
  app.post("/api/v1/registro", async (c) => {
    if (k.cfg.REGISTRATION_TOKEN) {
      const enviado = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!igualesSeguro(enviado, k.cfg.REGISTRATION_TOKEN)) {
        return falla(c, "No autorizado para registrar empresas.", 401, "no_autorizado");
      }
    }
    const b = await jsonSeguro(c, registroSchema);
    const { tenant, apiKey, apiSecret } = await k.tenants.crear({
      ruc: b.ruc,
      razonSocial: b.razon_social,
      solUser: b.sol_user,
      solPass: b.sol_pass,
      clientId: b.client_id,
      clientSecret: b.client_secret,
      perfil: {
        entorno: b.entorno ?? null,
        direccion: b.direccion ?? null,
        ubigeo: b.ubigeo ?? null,
        departamento: b.departamento ?? null,
        provincia: b.provincia ?? null,
        distrito: b.distrito ?? null,
      },
    });
    await k.db.query("insert into audit_log (tenant_id, accion, detalle) values ($1, 'registro', $2::jsonb)", [tenant.id, JSON.stringify({ ruc: tenant.ruc })]);
    return exito(c, { tenant_id: tenant.id, ruc: tenant.ruc, api_key: apiKey, api_secret: apiSecret }, "Empresa registrada.", 201);
  });

  // ─── Todo lo demás exige api_key + api_secret ────────────────────────────────
  app.use("/api/v1/*", async (c, next) => {
    if (c.req.path === "/api/v1/registro") return next();
    const origen = origenDe(c.req.raw.headers);
    if (limite.bloqueado(origen)) return falla(c, "Demasiados intentos fallidos. Espera un minuto.", 429, "demasiados_intentos");

    const apiKey = c.req.header("x-api-key") ?? "";
    const apiSecret = c.req.header("x-api-secret") ?? "";
    const tenant = apiKey && apiSecret ? await k.tenants.autenticar(apiKey, apiSecret) : null;
    if (!tenant) {
      limite.registrarFallo(origen);
      return falla(c, "Credenciales de la API no válidas.", 401, "no_autenticado");
    }
    limite.reiniciar(origen);
    c.set("tenant", tenant);
    await next();
  });

  app.put("/api/v1/empresa", async (c) => {
    const t = c.get("tenant");
    const cambios = await jsonSeguro(c, credencialesSchema);
    const actualizado = await k.tenants.actualizarCredenciales(t.id, {
      solUser: cambios.sol_user,
      solPass: cambios.sol_pass,
      clientId: cambios.client_id,
      clientSecret: cambios.client_secret,
    });
    // Credenciales nuevas: se descarta el token y el "rechazo recordado", y SIRE vuelve a quedar sin verificar.
    k.tokens.invalidar(t.id);
    k.tokens.olvidarRechazo(t.id);
    await k.db.query("insert into audit_log (tenant_id, accion, detalle) values ($1, 'credenciales_actualizadas', $2::jsonb)", [
      t.id,
      JSON.stringify({ campos: Object.keys(cambios) }),
    ]);
    return exito(c, { ruc: actualizado.ruc, sire_enabled: actualizado.sire_enabled }, "Credenciales actualizadas.");
  });

  // ─── Activación del SIRE ─────────────────────────────────────────────────────
  app.post("/api/v1/sire/activar", async (c) => {
    const t = c.get("tenant");
    try {
      // Pedir el token ES la verificación: si SUNAT acepta las credenciales, queda activo.
      await k.tokens.obtener(k.tenants.credenciales(t));
    } catch (e) {
      if (e instanceof AppError) await k.tenants.marcarSire(t.id, false, e.message);
      throw e;
    }
    await k.tenants.marcarSire(t.id, true, null);
    await k.db.query("insert into audit_log (tenant_id, accion) values ($1, 'sire_activado')", [t.id]);
    return exito(c, { sire_enabled: true }, "SIRE activado: SUNAT aceptó las credenciales.");
  });

  app.post("/api/v1/sire/desactivar", async (c) => {
    const t = c.get("tenant");
    k.tokens.invalidar(t.id);
    await k.tenants.marcarSire(t.id, false, null);
    await k.db.query("insert into audit_log (tenant_id, accion) values ($1, 'sire_desactivado')", [t.id]);
    return exito(c, { sire_enabled: false }, "SIRE desactivado.");
  });

  // ─── De aquí en adelante, el SIRE tiene que estar activado ───────────────────
  app.use("/api/v1/sire/*", async (c, next) => {
    const t = c.get("tenant");
    if (!t.sire_enabled) {
      return falla(c, "SIRE no está activado para esta empresa. Actívalo primero verificando las credenciales.", 403, "sire_no_activado");
    }
    await next();
  });

  app.get("/api/v1/sire/periodos", async (c) => {
    const t = c.get("tenant");
    const libro = libroSchema.parse(c.req.query("libro") ?? "rce");
    const ejercicios = await k.sire.periodos(k.tenants.credenciales(t), libro);
    return exito(c, presentarPeriodos(libro, ejercicios));
  });

  // ─── Compras (RCE) y Ventas (RVIE) ───────────────────────────────────────────
  const libros: { libro: Libro; ruta: "rce" | "rvie"; coleccion: "comprobantes" | "ventas" }[] = [
    { libro: "rce", ruta: "rce", coleccion: "comprobantes" },
    { libro: "rvie", ruta: "rvie", coleccion: "ventas" },
  ];

  for (const { libro, ruta, coleccion } of libros) {
    const base = `/api/v1/sire/${ruta}`;

    // Constancia y reporte de cumplimiento: PDF directo de SUNAT (lectura).
    app.get(`${base}/constancia`, async (c) => {
      const t = c.get("tenant");
      const nombre = z.string().regex(/^[\w.\-]{1,200}$/, "Nombre de constancia no válido.").parse(c.req.query("nom_constancia") ?? "");
      const r = await k.sire.constancia(k.tenants.credenciales(t), libro, nombre);
      return new Response(Buffer.from(r.pdf), {
        headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${r.nombre ?? nombre}"`, "Cache-Control": "no-store" },
      });
    });

    app.get(`${base}/:periodo/reporte-cumplimiento`, async (c) => {
      const t = c.get("tenant");
      const periodo = periodoSchema.parse(c.req.param("periodo"));
      const r = await k.sire.reporteCumplimiento(k.tenants.credenciales(t), libro, periodo);
      const nombre = r.nombre ?? `reporte-cumplimiento-${periodo}.pdf`;
      return new Response(Buffer.from(r.pdf), {
        headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${nombre}"`, "Cache-Control": "no-store" },
      });
    });

    // Pide la propuesta a SUNAT (asíncrono: devuelve el ticket).
    app.get(`${base}/:periodo/propuesta`, async (c) => {
      const t = c.get("tenant");
      const periodo = periodoSchema.parse(c.req.param("periodo"));
      const ticket = await k.tickets.solicitarPropuesta(t, libro, periodo);
      return exito(c, { num_ticket: ticket.num_ticket, per_tributario: periodo, mensaje: "Propuesta solicitada. Siga el ticket." });
    });

    // Lo ya leído de la propuesta (no consulta a SUNAT).
    app.get(`${base}/:periodo/${coleccion}`, async (c) => {
      const t = c.get("tenant");
      const periodo = periodoSchema.parse(c.req.param("periodo"));
      const fase = faseSchema.parse(c.req.query("fase") || undefined) as Fase;
      const pagina = entero(1, 100_000).parse(c.req.query("page") || undefined);
      const porPagina = entero(50, 500).parse(c.req.query("per_page") || undefined);
      const [totales, lista] = await Promise.all([
        k.comprobantes.totales(t.id, libro, periodo, fase),
        k.comprobantes.listar(t.id, libro, periodo, fase, pagina, porPagina),
      ]);
      return exito(c, {
        totales,
        [coleccion]: { ...lista, data: lista.data.map((f) => presentarComprobante(f, libro)) },
      });
    });

    app.get(`${base}/:periodo/reconciliar`, async (c) => {
      const t = c.get("tenant");
      const periodo = periodoSchema.parse(c.req.param("periodo"));
      const a = await k.comprobantes.analizar(t.id, libro, periodo, "propuesta");
      return exito(c, {
        per_tributario: periodo,
        run_at: new Date().toISOString(),
        totales: {
          total_comprobantes: a.totales.total_comprobantes,
          total_incluidos: a.totales.total_comprobantes,
          total_excluidos: 0,
          suma_bi_gravada: a.totales.suma_bi_gravada,
          suma_igv: a.totales.suma_igv,
          suma_total: a.totales.suma_total,
        },
        alertas: { duplicados: a.duplicados, outliers_monto: a.atipicos, con_inconsistencia_sunat: a.conInconsistencia },
      });
    });

    // Operaciones que ESCRIBEN en SUNAT: bloqueadas mientras SIRE_WRITES_ENABLED sea false.
    for (const [accion, nombre] of [
      ["aceptar-propuesta", "aceptar la propuesta"],
      ["registrar-preliminar", "registrar el preliminar"],
    ] as const) {
      app.post(`${base}/:periodo/${accion}`, async (c) => {
        periodoSchema.parse(c.req.param("periodo"));
        k.guards.assertWrite(`${nombre} (${libro.toUpperCase()})`);
        throw new AppError(`«${nombre}» todavía no está implementado en esta API.`, 501, "no_implementado");
      });
    }
  }

  // ─── Tickets (iguales para compras y ventas) ─────────────────────────────────
  app.get("/api/v1/sire/tickets", async (c) => {
    const t = c.get("tenant");
    const q = c.req.query();
    const finalizado = q.finalizado === undefined ? undefined : q.finalizado === "1" || q.finalizado === "true";
    const lista = await k.tickets.listar(t.id, {
      periodo: q.per_tributario ? periodoSchema.parse(q.per_tributario) : undefined,
      estado: q.estado || undefined,
      codProceso: q.cod_proceso || undefined,
      finalizado,
      pagina: entero(1, 100_000).parse(q.page || undefined),
      porPagina: entero(20, 100).parse(q.por_pagina || q.per_page || undefined),
    });
    return exito(c, { ...lista, data: lista.data.map(presentarTicket) });
  });

  app.get("/api/v1/sire/tickets/:num", async (c) => {
    const t = c.get("tenant");
    return exito(c, presentarTicket(await k.tickets.obtener(t.id, c.req.param("num"))));
  });

  // Consulta a SUNAT el estado AHORA (útil para no esperar al seguimiento automático).
  app.post("/api/v1/sire/tickets/:num/refrescar", async (c) => {
    const t = c.get("tenant");
    return exito(c, presentarTicket(await k.tickets.refrescar(t, c.req.param("num"))));
  });

  app.get("/api/v1/sire/tickets/:num/archivo", async (c) => {
    const t = c.get("tenant");
    const { bytes, nombre } = await k.tickets.archivoGuardado(t.id, c.req.param("num"));
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": nombre.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/zip",
        "Content-Disposition": `attachment; filename="${nombre.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  return app;
}
