# API del SIRE (vc-sire-api)

Servicio que conversa con el **SIRE de SUNAT** (Registro de Compras y Registro de Ventas) en nombre de cada empresa:
pide la propuesta de un período, sigue el ticket hasta que SUNAT la termina, baja el archivo, lo lee y deja los
comprobantes listos para consultar. Lo usa el portal de VC Soluciones; está pensada para crecer con más funciones del SIRE.

> **Hoy es de solo lectura.** Nada se acepta, reemplaza, registra ni envía en SUNAT. Además hay dos interruptores de seguridad
> (más abajo) que impiden siquiera salir a SUNAT mientras no se decida.

Escrita desde cero en TypeScript a partir de los **manuales públicos de SUNAT** (RVIE v31 y RCE v28). No contiene
código de terceros.

## Qué hace

| Función | Estado |
|---|---|
| Registrar empresas (RUC, usuario/Clave SOL, `client_id`/`client_secret`), con las claves **cifradas** | ✅ |
| Verificar credenciales con SUNAT (activar SIRE) sin arriesgar el bloqueo de la Clave SOL | ✅ |
| Períodos habilitados (compras y ventas) | ✅ |
| Pedir la propuesta de un período, seguir el ticket, bajar el archivo y leerlo | ✅ |
| Consultar comprobantes leídos (paginados) y una revisión rápida (duplicados, montos atípicos) | ✅ |
| Tickets: listar, ver, consultar a SUNAT ahora, descargar el archivo guardado | ✅ |
| Constancia de recepción y reporte de cumplimiento (PDF) | ✅ (probado contra un SUNAT simulado) |
| Aceptar propuesta / registrar preliminar / reemplazar / enviar | ⛔ bloqueado, ver `docs/SUNAT-SERVICIOS.md` |
| Ajustes posteriores, no domiciliados, casillas 621, preliminares registrados | 🗺️ planificado |

## Puesta en marcha (desarrollo, sin Docker)

Requisitos: Node 22 o superior.

```bash
npm install
cp .env.example .env          # y completa APP_ENCRYPTION_KEY y API_KEY_PEPPER (instrucciones dentro)
npm run dev:db                # Postgres local en el puerto 5433 (en otra terminal)
npm run dev                   # API en http://localhost:8080  (aplica las migraciones al arrancar)
npm run dev:worker            # proceso en segundo plano que sigue los tickets (en otra terminal)
npm test                      # 77 pruebas: no necesitan internet ni SUNAT
npm run build && npm run ensayo   # ensayo general: servidor compilado + Postgres por red + SUNAT simulado
```

Con Docker: `docker compose up --build` levanta Postgres, la API y el worker.

## Variables de entorno

Todas están explicadas en [`.env.example`](.env.example). Las que importan:

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres |
| `APP_ENCRYPTION_KEY` | Cifra la Clave SOL y el `client_secret` (32 bytes en base64). **Si se pierde, hay que volver a registrar las credenciales.** |
| `API_KEY_PEPPER` | Protege el hash del `api_secret` de cada empresa |
| `REGISTRATION_TOKEN` | Quien cree empresas debe enviarlo. **Obligatorio en producción** |
| `SUNAT_LIVE` | **Interruptor 1.** `false` = no sale ninguna petición a los dominios reales de SUNAT |
| `SIRE_WRITES_ENABLED` | **Interruptor 2.** `false` = ninguna operación que escriba en SUNAT puede ejecutarse |

## Seguridad

- **Credenciales de SUNAT cifradas** (AES-256-GCM); nunca salen en respuestas ni en los registros (logs). El portal tampoco las guarda.
- **El `api_secret` de cada empresa solo se muestra una vez**; en la base queda su hash (HMAC con un pepper).
- **Protección de la Clave SOL**: si SUNAT rechaza las credenciales, no se reintenta con las mismas durante 15 minutos
  (cada intento fallido acerca el bloqueo de la Clave SOL del cliente). Basta cambiar las credenciales para volver a intentar.
- **Dos interruptores** (`SUNAT_LIVE`, `SIRE_WRITES_ENABLED`) revisados justo antes de cada petición: ningún camino los esquiva.
- Frenos: máximo de intentos fallidos de autenticación por origen (429), intervalo mínimo entre llamadas a SUNAT por empresa,
  límite de tamaño de las peticiones, ZIP con tope de tamaño al descomprimir.
- Bitácora (`audit_log`) de altas, cambios de credenciales y activaciones.

## Estructura

```
src/
  config.ts, crypto.ts, errors.ts, logger.ts   piezas base
  db/                                          acceso a Postgres y migraciones
  sunat/                                       hablar con SUNAT: token, HTTP, servicios del SIRE, interruptores
  sire/                                        el dominio: empresas, tickets, comprobantes, cola, worker, lectores de archivos
  http/                                        la API (Hono): rutas, formato de respuestas, límites
  test/                                        SUNAT simulado, base en memoria, archivos de ejemplo
migrations/                                    SQL numerado
docs/                                          arquitectura, servicios de SUNAT, integración con el portal
```

Más detalle en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).

## Producción (Render)

Todo está preparado en [`render.yaml`](render.yaml) y explicado en [`docs/DESPLIEGUE-RENDER.md`](docs/DESPLIEGUE-RENDER.md):
una base Postgres y un servicio que corre la API con su worker dentro. Los archivos de SUNAT se guardan en Postgres (no hacen
falta discos). `SUNAT_LIVE` y `SIRE_WRITES_ENABLED` empiezan en `false`.

La **primera prueba real** contra SUNAT se hace ya desplegada, acompañada y de solo lectura: el protocolo está en el paso 6 de esa guía.

Con otro proveedor: la misma imagen (`Dockerfile`) sirve para la API y el worker (`node dist/worker.js` con `RUN_WORKER_IN_API=false`).
