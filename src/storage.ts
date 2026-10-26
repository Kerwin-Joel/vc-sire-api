import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { Db } from "./db/index.js";

/** Dónde se guardan los archivos que entrega SUNAT. Hoy en disco; se puede reemplazar por S3/R2 sin tocar el resto. */
export interface FileStorage {
  guardar(ruta: string, bytes: Uint8Array): Promise<void>;
  leer(ruta: string): Promise<Uint8Array>;
  existe(ruta: string): Promise<boolean>;
}

export class LocalStorage implements FileStorage {
  private readonly raiz: string;

  constructor(directorio: string) {
    this.raiz = resolve(directorio);
  }

  /** Impide que una ruta como "../../etc/passwd" salga de la carpeta de archivos. */
  private seguro(ruta: string): string {
    const completa = resolve(join(this.raiz, normalize(ruta)));
    if (completa !== this.raiz && !completa.startsWith(this.raiz + sep)) {
      throw new Error("Ruta de archivo no permitida.");
    }
    return completa;
  }

  async guardar(ruta: string, bytes: Uint8Array): Promise<void> {
    const destino = this.seguro(ruta);
    await mkdir(dirname(destino), { recursive: true });
    await writeFile(destino, bytes);
  }

  async leer(ruta: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.seguro(ruta)));
  }

  async existe(ruta: string): Promise<boolean> {
    try {
      await stat(this.seguro(ruta));
      return true;
    } catch {
      return false;
    }
  }
}

/** Almacenamiento en memoria, para pruebas. */
export class MemoryStorage implements FileStorage {
  readonly archivos = new Map<string, Uint8Array>();
  async guardar(ruta: string, bytes: Uint8Array) {
    this.archivos.set(ruta, bytes);
  }
  async leer(ruta: string) {
    const b = this.archivos.get(ruta);
    if (!b) throw new Error("No existe el archivo.");
    return b;
  }
  async existe(ruta: string) {
    return this.archivos.has(ruta);
  }
}

/**
 * Guarda los archivos en la tabla `archivos` de Postgres. Es la opción por defecto: no necesita discos compartidos,
 * así la API y el worker pueden correr como servicios separados (por ejemplo, en Render).
 */
export class PgStorage implements FileStorage {
  constructor(private readonly db: Db) {}

  async guardar(ruta: string, bytes: Uint8Array): Promise<void> {
    await this.db.query(
      `insert into archivos (ruta, contenido, bytes) values ($1, $2, $3)
       on conflict (ruta) do update set contenido = excluded.contenido, bytes = excluded.bytes, created_at = now()`,
      [ruta, Buffer.from(bytes), bytes.length],
    );
  }

  async leer(ruta: string): Promise<Uint8Array> {
    const filas = await this.db.query<{ contenido: Uint8Array }>("select contenido from archivos where ruta = $1", [ruta]);
    const fila = filas[0];
    if (!fila) throw new Error("No existe el archivo.");
    return new Uint8Array(fila.contenido);
  }

  async existe(ruta: string): Promise<boolean> {
    return (await this.db.query("select 1 from archivos where ruta = $1", [ruta])).length > 0;
  }
}

/** Elige dónde guardar los archivos según STORAGE_DRIVER. */
export function crearStorage(driver: "postgres" | "local", db: Db, directorio: string): FileStorage {
  return driver === "local" ? new LocalStorage(directorio) : new PgStorage(db);
}
