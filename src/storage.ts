import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

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
