# Arquitectura

## Vista general

```
 Portal (Next.js)                         API del SIRE                               SUNAT
 ───────────────        X-Api-Key         ┌──────────────────────┐  OAuth + REST    ┌────────────────┐
  panel del equipo ───► X-Api-Secret ───► │  API (Hono)          │ ───────────────► │ api-seguridad  │
                                          │  rutas /api/v1/...   │                  │ api-sire       │
                                          └─────────┬────────────┘                  └────────────────┘
                                                    │ escribe trabajos                      ▲
                                          ┌─────────▼────────────┐                         │
                                          │  Postgres            │ ◄── worker ─────────────┘
                                          │  empresas · tickets  │     (sigue tickets,
                                          │  comprobantes · cola │      baja y lee archivos)
                                          └──────────────────────┘
                                                    + archivos de SUNAT (ZIP/PDF) también en Postgres
```

- **API** y **worker** son dos procesos de la misma imagen. La API responde rápido; todo lo lento (esperar a SUNAT, bajar
  ZIP, leerlos) lo hace el worker.
- La **cola de trabajos vive en Postgres** (`jobs`, con `FOR UPDATE SKIP LOCKED`): no hace falta Redis.
- **PGlite** (Postgres real en memoria) permite probar todo el SQL sin servidores; el adaptador de producción (`pg`) se prueba
  aparte contra el mismo motor por red (`tests/pg-real.test.ts`).

## Flujo de una propuesta

1. `GET /api/v1/sire/rce/{periodo}/propuesta` → la API pide el archivo a SUNAT y guarda el **ticket** (`sire_tickets`) +
   un trabajo `poll_ticket`. Responde enseguida con el número de ticket.
2. El worker ejecuta `poll_ticket`: consulta el estado. Si sigue en proceso, se reprograma (espera creciente: 5 s → 1 min,
   hasta `TICKET_MAX_POLLS`). Si terminó, encola `download_ticket_file`.
3. `download_ticket_file`: baja el archivo, lo guarda y encola `parse_ticket_file`.
4. `parse_ticket_file`: descomprime, lee la propuesta por **nombre de columna** y **reemplaza** de una vez los comprobantes
   del período (en una transacción: o queda lo nuevo completo o lo anterior intacto).
5. `GET .../comprobantes` entrega lo leído, ya con los nombres que usa el portal.

Si algo falla y reintentar no ayuda (credenciales rechazadas, archivo con otro formato…), el trabajo falla de una vez y el
motivo queda en el ticket (`ultimo_error`).

## Decisiones y por qué

| Decisión | Motivo |
|---|---|
| TypeScript | Mismo lenguaje que el portal; una sola herramienta para todo el equipo |
| Escrita desde cero con los manuales públicos | La API de terceros es un producto comercial con licencia; no se reutiliza su código |
| Lectores de archivo por **nombre de columna** | SUNAT agrega columnas con el tiempo; leer por posición se rompe en silencio |
| Se guarda la fila completa (`datos` jsonb) | No perder información al normalizar; se pueden sacar campos nuevos sin volver a SUNAT |
| Estado del ticket decidido por la **descripción** de SUNAT | Los códigos de estado de RCE y RVIE no son idénticos y el manual de compras no los lista |
| Respuestas `{estado, mensaje, datos}` con los mismos nombres que usa el portal | Cambiar de API sin reescribir el portal (ver `PORTAL-INTEGRACION.md`) |
| Interruptores revisados en el punto más bajo (`SunatHttp`) | Ninguna ruta nueva puede olvidarse de revisarlos |

## Cómo agregar una función del SIRE (futuras features)

1. **Servicio de SUNAT** → un método nuevo en `src/sunat/sire.ts` (usa `SunatHttp`; si escribe en SUNAT, `escritura: true`).
   Documentarlo en `docs/SUNAT-SERVICIOS.md` con su número del manual.
2. **Dominio** → si hay que guardar algo, una migración nueva `migrations/00N_*.sql` y un repositorio en `src/sire/`.
3. **Trabajo en segundo plano** (si SUNAT responde con ticket) → un tipo nuevo en `TipoJob` y su manejador en `Worker.ejecutar`.
4. **Ruta** → en `src/http/app.ts`; las que escriben deben llamar a `guards.assertWrite(...)`.
5. **Prueba** → agregar el comportamiento al SUNAT simulado (`src/test/sunatFalso.ts`) y escribir la prueba.

Operaciones que escriben en SUNAT (aceptar, reemplazar, registrar, enviar) además deben dejar registro en `audit_log`,
mostrar una vista previa de qué cambiará antes de ejecutarse y probarse primero **juntos**, con una empresa elegida:
el SIRE no tiene ambiente de pruebas.

## Qué falta para escalar

- Varias réplicas de la API: el freno de intentos fallidos vive en memoria; moverlo a Postgres o Redis.
- Almacenamiento de archivos en la nube (hoy disco): implementar `FileStorage` con S3/R2 (la interfaz ya está aislada).
- Métricas (Prometheus/OpenTelemetry) y alertas sobre trabajos fallidos.
