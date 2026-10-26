# Servicios de SUNAT que usa esta API

Los números (5.16, 5.33…) son los de los manuales oficiales de SUNAT:
[RVIE v31](https://cpe.sunat.gob.pe/sites/default/files/2026-09/Manual%20del%20servicio%20API%20del%20Registro%20de%20Ventas%20e%20Informaci%C3%B3n%20Electr%C3%B3nica.%20v31_1.pdf)
y [RCE v28](https://cpe.sunat.gob.pe/sites/default/files/inline-files/Manual%20de%20servicios%20Web%20Api%20-%20SIRE_Compras%20v28.pdf).
Códigos de libro: **080000** = RCE (compras), **140000** = RVIE (ventas).

Todo lo implementado es **lectura**. Nunca se ha probado contra SUNAT real: las pruebas usan un SUNAT simulado que responde con
el formato de los manuales. Los puntos «por verificar» se confirman en la primera prueba real autorizada.

## Implementado (lectura)

| Función | RCE | RVIE | Ruta de SUNAT (`https://api-sire.sunat.gob.pe` salvo la autenticación) |
|---|---|---|---|
| Token (OAuth, `grant_type=password`) | 5.1 | 5.1 | `POST https://api-seguridad.sunat.gob.pe/v1/clientessol/{client_id}/oauth2/token/` |
| Períodos habilitados | 5.33 | 5.2 | `GET /v1/contribuyente/migeigv/libros/rvierce/padron/web/omisos/{codLibro}/periodos` |
| Pedir la propuesta (devuelve ticket) | 5.34 | 5.18 | RCE `.../libros/rce/propuesta/web/propuesta/{per}/exportacioncomprobantepropuesta?codTipoArchivo=0&codOrigenEnvio=2` · RVIE `.../libros/rvie/propuesta/web/propuesta/{per}/exportapropuesta?codTipoArchivo=0` |
| Estado de un ticket | 5.31 | 5.16 | `.../libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets?perIni&perFin&page&perPage&numTicket&codLibro&codOrigenEnvio=2` |
| Descargar el archivo del ticket | 5.32 | 5.17 | `.../masivo/archivoreporte?nomArchivoReporte&codTipoArchivoReporte&perTributario&codProceso&numTicket&codLibro` |
| Constancia de recepción (PDF) | 5.49 | 5.26 | RCE `.../registroslibros/constancia/constanciarecepcion?nomConstanciaRecepcion=` · RVIE `.../registroslibros/constancia/archivo?nomArchivo=` |
| Reporte de cumplimiento (PDF) | 5.58 | 5.34 | `.../libros/rvierce/cumplimiento/web/omisos/{per}/{codLibro}/consultaReporteCumplimiento/exportardocumento` |

### Por verificar en la primera prueba real

1. **Estados del ticket de compras (RCE).** El manual de compras no incluye la tabla de estados (el de ventas sí: 01 cargado, 02 validando,
   03 con errores, 04 sin errores, 05 en proceso, 06 terminado). La API decide por la **descripción** que entrega SUNAT
   (`clasificarEstado`). Confirmar con un ticket de compras real.
2. **Forma de la respuesta de períodos.** El manual la describe como lista de ejercicios con `lisPeriodos`; el lector acepta también
   la respuesta envuelta en `data`.
3. **Constancia de compras:** el manual dice «arreglo de bytes»; el de ventas, JSON con `archivoPdf` en base64. La API acepta ambos.
4. **Intervalo mínimo entre llamadas** (`SUNAT_MIN_INTERVAL_MS`, 400 ms): SUNAT responde 429 si se la abruma; ajustar con la experiencia real.
5. **Vigencia del token** (`expires_in`): se usa el que entrega SUNAT.

## Bloqueado a propósito (escritura)

Las rutas existen y devuelven 403 (`escritura_deshabilitada`) mientras `SIRE_WRITES_ENABLED=false`; con el interruptor activo
responden 501 (no implementado) y **no envían nada**. Cada una exige, antes de implementarse, el procedimiento de «Cómo agregar
una función» de `ARQUITECTURA.md` y una primera prueba real acompañada.

| Función | RCE | RVIE |
|---|---|---|
| Aceptar propuesta | 5.2 | 5.8 |
| Reemplazar propuesta (carga de TXT con TUS) | 5.3 | — |
| Registrar preliminar | 5.4 | 5.9 |
| Incluir / excluir comprobantes | 5.8 | 5.10 (exclusión **definitiva**) |
| Eliminar preliminar | 5.17 | 5.15 |
| Actualizar campos / tipo de cambio | 5.10 | 5.11–5.12 |

## Planificado (lectura, sin riesgo)

| Función | RCE | RVIE |
|---|---|---|
| Preliminares registrados (en qué etapa va el período) | 5.61 | 5.37 |
| Detalle de casillas FV0621 | 5.14 | 5.23 |
| Ajustes posteriores (consultar y descargar) | 5.59, 5.45–5.48 | 5.29–5.30 |
| Excluidos de la propuesta | 5.37 | 5.19 |
| Inconsistencias (por período y por comprobante) | 5.43–5.44, 5.52 | 5.24–5.25, 5.31 |
| Reportes estadísticos | 5.54–5.57 | 5.33 |
| Compras de no domiciliados | 5.5, 5.39 | — |

> No existe en la API pública un servicio de «historial de constancias» ni de «historial de registros»: lo que muestra el SIRE
> web en esas pestañas no sale de estos servicios.
