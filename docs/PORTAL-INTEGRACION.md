# Conectar el portal a esta API

La API usa **las mismas rutas, cabeceras y formato de respuesta** que el portal ya conoce, así que el cambio es de configuración
y de un detalle en el alta de empresas.

## Lo que el portal ya usa y esta API cumple

| Portal llama | Estado |
|---|---|
| `POST /api/v1/registro` (alta de empresa) | ✅ responde `{estado, datos:{tenant_id, ruc, api_key, api_secret}}` |
| `PUT /api/v1/empresa` (cambiar credenciales) | ✅ |
| `POST /api/v1/sire/activar` · `/desactivar` | ✅ |
| `GET /api/v1/sire/periodos?libro=rce\|rvie` | ✅ misma forma (`ejercicios[].periodos[]`) |
| `GET /api/v1/sire/rce\|rvie/{periodo}/propuesta?formato=txt` | ✅ devuelve `num_ticket` |
| `GET /api/v1/sire/rce/{p}/comprobantes?fase&per_page` · `rvie/{p}/ventas` | ✅ `totales` + `comprobantes`/`ventas` paginado |
| `GET /api/v1/sire/rce/{p}/reconciliar` | ✅ (revisión de duplicados y atípicos; sin cruce externo) |
| `POST .../aceptar-propuesta` · `registrar-preliminar` | ⛔ 403 mientras sea solo lectura |
| `GET /api/v1/sire/tickets` · `/{n}` · `POST /{n}/refrescar` · `GET /{n}/archivo` | ✅ |

Además la API ofrece lo que el portal aún no usa: constancia de recepción y reporte de cumplimiento en PDF
(`GET /api/v1/sire/{rce|rvie}/constancia?nom_constancia=` y `.../{periodo}/reporte-cumplimiento`).

## Pasos para el cambio

1. **Desplegar** la API y su worker (ver `README.md`) y anotar su URL.
2. **Variables del portal** (`.env.local` y Vercel):
   - `SUNAT_API_URL` → la URL de la API nueva.
   - `SUNAT_API_REGISTRATION_TOKEN` → el mismo valor que `REGISTRATION_TOKEN` de la API.
3. **Alta de empresas**: en `registrarSireEmpresa` (`src/app/panel/clientes/[id]/sireIntegrationActions.ts`), agregar a la petición a
   `/api/v1/registro` la cabecera `Authorization: Bearer ${process.env.SUNAT_API_REGISTRATION_TOKEN}`. Es el único cambio de código.
4. **Empresas ya registradas**: sus `api_key`/`api_secret` en `sire_integrations` son de la API anterior y no sirven. Hay que volver a
   registrarlas (pantalla «Conexión con SUNAT»). La Clave SOL no se guarda en el portal fuera de la bóveda, así que hay que tenerla a mano
   (o leerla de la bóveda con «Ver contraseña»). Los comprobantes ya traídos y guardados en el historial no se pierden.
5. **Primera prueba real** (con `SUNAT_LIVE=true` en un entorno controlado, una empresa de prueba y la persona responsable presente).
   Verificar los puntos «por verificar» de `SUNAT-SERVICIOS.md`.
6. Cuando todo funcione, dar de baja la API anterior.

## Diferencias a tener en cuenta

- Los tickets traen además `libro` (`rce`/`rvie`), `estado_enum` (`EN_PROCESO`, `TERMINADO`, `CON_ERRORES`) y `ultimo_error`
  (el motivo si el seguimiento falló).
- Pedir una propuesta ya no consulta a SUNAT varias veces seguidas: la API sigue el ticket sola en segundo plano; el portal solo
  tiene que preguntar el estado (`GET /tickets/{n}`), que lee de la base y no cuesta una consulta a SUNAT.
- Cada empresa tiene un solo ticket por número; volver a pedir la propuesta crea un ticket nuevo y **reemplaza** los comprobantes del período.
