# Desplegar en Render

Un servicio (la API, con su worker dentro) y una base Postgres. Todo lo define [`render.yaml`](../render.yaml).

## 0. Antes de empezar

- [ ] `npm test` y `npm run build && npm run ensayo` pasan en tu equipo (el ensayo recorre el flujo completo con un SUNAT simulado).
- [ ] El código está en un repositorio de GitHub **privado** (Render lo lee desde ahí).
- [ ] Tienes a mano un gestor de contraseñas para guardar tres valores (paso 3).
- [ ] Aceptas el costo de los planes de pago. Los planes gratuitos no sirven: el servicio se duerme tras unos minutos sin tráfico
  (el worker dejaría de seguir los tickets) y la base gratuita vence. Confirma precios en el panel de Render.

## 1. Subir el código a GitHub

Crea un repositorio privado `vc-sire-api` y sube `C:\dev\vc-sire-api`. (`.env` y `data/` ya están en `.gitignore`: no se suben.)

## 2. Crear los servicios con el Blueprint

1. En Render: **New → Blueprint** y elige el repositorio.
2. Render lee `render.yaml`, muestra la base `vc-sire-db` y el servicio `vc-sire-api`. Revisa los planes y pulsa **Apply**.
3. Espera al primer despliegue (la API aplica las migraciones sola al arrancar).

## 3. Guardar los secretos (¡no te saltes este paso!)

En el servicio `vc-sire-api` → **Environment**, copia a tu gestor de contraseñas:

| Variable | Para qué sirve | Qué pasa si se pierde |
|---|---|---|
| `APP_ENCRYPTION_KEY` | Descifra las Claves SOL y `client_secret` guardados | **No se pueden recuperar**: hay que registrar de nuevo las credenciales de cada empresa |
| `API_KEY_PEPPER` | Verifica las `api_secret` de las empresas | Dejan de funcionar todas; hay que registrar de nuevo |
| `REGISTRATION_TOKEN` | Autoriza a crear empresas desde el portal | Se puede cambiar cuando quieras (y actualizarlo en el portal) |

## 4. Comprobar que está viva y apagada

Abre `https://vc-sire-api.onrender.com/ready` (la URL exacta aparece en el panel). Debe responder:

```json
{"estado":"exito","mensaje":"OK","datos":{"ok":true,"sunat_live":false,"escritura":false}}
```

`sunat_live:false` y `escritura:false` significan que **nada sale hacia SUNAT**.

## 5. Conectar el portal

En el portal (`.env.local` y las variables de Vercel):

```
SUNAT_API_URL=https://vc-sire-api.onrender.com
SUNAT_API_REGISTRATION_TOKEN=<el REGISTRATION_TOKEN del paso 3>
```

Detalles y diferencias con la API anterior: [`PORTAL-INTEGRACION.md`](PORTAL-INTEGRACION.md).

## 6. Primera prueba real con SUNAT

Se hace **juntos**, con calma y con una sola empresa. SUNAT no tiene ambiente de pruebas: lo que se consulta es real.

**Reglas**
- Solo lectura: `SIRE_WRITES_ENABLED` se queda en `false`. Nada se acepta, reemplaza ni envía.
- Antes de cada paso se anuncia qué petición sale a SUNAT y para qué empresa.
- **La Clave SOL la escribe la persona dueña de la empresa**, en el portal. No se comparte ni se pega en ningún chat.
- Conviene una empresa propia o de un cliente que lo autorice, con Clave SOL de **8 caracteres o menos**
  (SUNAT suele rechazar las más largas en el SIRE).
- Si SUNAT rechaza las credenciales, **se detiene todo**: cada intento fallido acerca el bloqueo de la Clave SOL. La API no reintenta sola.

**Pasos** (unas 6 a 8 peticiones en total)

| # | Qué se hace | Qué sale a SUNAT |
|---|---|---|
| 1 | En Render: `SUNAT_LIVE=true` y redesplegar | nada todavía |
| 2 | Portal → empresa → SIRE → conectar con SUNAT (registrar y activar) | 1 petición de token |
| 3 | Pedir los períodos habilitados | 1 consulta (lectura) |
| 4 | Pedir la propuesta de **un** período | 1 pedido de propuesta + consultas del ticket (cada 5–60 s) + 1 descarga |
| 5 | Revisar en el portal: comprobantes leídos contra lo que se ve en el SIRE web de SUNAT | nada |
| 6 | En Render: `SUNAT_LIVE=false` y redesplegar | nada |

**Qué se confirma** (los puntos «por verificar» de [`SUNAT-SERVICIOS.md`](SUNAT-SERVICIOS.md)): estados del ticket de compras,
forma de la respuesta de períodos, que las rutas respondan sin error y que los totales coincidan con los del SIRE web.

## 7. Operación

- **Logs**: panel de Render → servicio → Logs. Las claves y tokens nunca se escriben.
- **Cambiar el token de registro**: nuevo valor en Render y en el portal; las empresas ya creadas no se afectan.
- **Actualizar el código**: subir a GitHub y desplegar a mano desde Render (`autoDeploy: false`).
- **Respaldo**: usa un plan de Postgres con copias automáticas; la base guarda empresas, tickets, comprobantes y archivos.
- **Si la API crece**: separar el worker en un servicio propio (`type: worker`, comando `node dist/worker.js`, `RUN_WORKER_IN_API=false`
  en la API). Como los archivos viven en Postgres, no hace falta compartir discos.
