import type { MiddlewareHandler } from "hono";

/**
 * Freno simple contra intentos de adivinar claves: cuenta los intentos FALLIDOS por origen en una ventana
 * y, pasado el tope, responde 429 hasta que termine la ventana. Vive en memoria (una sola instancia); si algún día
 * hay varias réplicas, conviene moverlo a un almacén compartido.
 */
export class LimiteIntentos {
  private readonly intentos = new Map<string, { n: number; hasta: number }>();

  constructor(
    private readonly tope = 20,
    private readonly ventanaMs = 60_000,
    private readonly ahora: () => number = Date.now,
  ) {}

  bloqueado(origen: string): boolean {
    const r = this.intentos.get(origen);
    if (!r) return false;
    if (r.hasta <= this.ahora()) {
      this.intentos.delete(origen);
      return false;
    }
    return r.n >= this.tope;
  }

  registrarFallo(origen: string): void {
    const r = this.intentos.get(origen);
    if (!r || r.hasta <= this.ahora()) this.intentos.set(origen, { n: 1, hasta: this.ahora() + this.ventanaMs });
    else r.n++;
  }

  reiniciar(origen: string): void {
    this.intentos.delete(origen);
  }
}

/** Origen del que llega la petición (detrás de un proxy se usa el primer valor de X-Forwarded-For). */
export function origenDe(cabeceras: Headers): string {
  return cabeceras.get("x-forwarded-for")?.split(",")[0]?.trim() || cabeceras.get("x-real-ip") || "desconocido";
}

export const limitarCuerpo = (maxBytes: number): MiddlewareHandler => async (c, next) => {
  const largo = Number(c.req.header("content-length") ?? 0);
  if (largo > maxBytes) {
    return c.json({ estado: "error", mensaje: "La petición es demasiado grande." }, 413);
  }
  await next();
};
