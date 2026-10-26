import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Formato de respuesta (el mismo que ya entiende el portal):
 *   éxito: { estado: "exito", mensaje, datos }
 *   error: { estado: "error", mensaje, codigo_error?, errores? }
 */
export function exito(c: Context, datos: unknown = null, mensaje = "OK", status: ContentfulStatusCode = 200) {
  return c.json({ estado: "exito", mensaje, datos }, status);
}

export function falla(c: Context, mensaje: string, status: ContentfulStatusCode = 400, codigo?: string, errores?: unknown) {
  return c.json(
    {
      estado: "error",
      mensaje,
      ...(codigo ? { codigo_error: codigo } : {}),
      ...(errores ? { errores } : {}),
    },
    status,
  );
}
