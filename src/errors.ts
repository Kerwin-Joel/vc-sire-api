/** Error con un código HTTP y un mensaje que sí se puede mostrar a quien llama a la API. */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly codigo?: string,
    public readonly detalle?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Respuesta de error de SUNAT (`{cod, msg, errors[]}`), ya interpretada. */
export class SunatError extends AppError {
  constructor(
    message: string,
    status: number,
    /** Código interno estable (por ejemplo "credenciales_rechazadas"); es el que consulta el resto del sistema. */
    codigo: string = "sunat_error",
    /** Código que usó SUNAT en su respuesta, si lo dio. */
    public readonly sunatCod?: string,
    public readonly errores: { cod?: string; msg?: string }[] = [],
  ) {
    super(message, status, codigo, { sunat_cod: sunatCod, errores });
    this.name = "SunatError";
  }
}

/** Se intentó llamar a SUNAT de verdad con SUNAT_LIVE desactivado. */
export class SunatLiveDisabledError extends AppError {
  constructor() {
    super(
      "Las consultas reales a SUNAT están desactivadas en este servidor (SUNAT_LIVE=false). No se envió nada.",
      503,
      "sunat_live_desactivado",
    );
    this.name = "SunatLiveDisabledError";
  }
}

/** Se intentó una operación que escribe en SUNAT con SIRE_WRITES_ENABLED desactivado. */
export class WritesDisabledError extends AppError {
  constructor(operacion: string) {
    super(
      `Operación deshabilitada: «${operacion}» escribe en el SIRE real de SUNAT y esta API está en modo solo lectura.`,
      403,
      "escritura_deshabilitada",
    );
    this.name = "WritesDisabledError";
  }
}
