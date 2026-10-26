import type { Db, Row } from "../db/index.js";
import { decryptSecret, encryptSecret, generateApiCredentials, verifyApiSecret } from "../crypto.js";
import { AppError } from "../errors.js";
import type { CredencialesSunat } from "../sunat/tokens.js";

export interface Tenant extends Row {
  id: number;
  ruc: string;
  razon_social: string;
  api_key: string;
  api_secret_hash: string;
  environment: "beta" | "prod";
  sol_user: string | null;
  sol_pass_enc: string | null;
  client_id: string | null;
  client_secret_enc: string | null;
  perfil: Record<string, unknown>;
  sire_enabled: boolean;
  sire_activated_at: string | null;
  sire_last_error: string | null;
}

export interface NuevaEmpresa {
  ruc: string;
  razonSocial: string;
  environment?: "beta" | "prod";
  solUser?: string;
  solPass?: string;
  clientId?: string;
  clientSecret?: string;
  perfil?: Record<string, unknown>;
}

export interface CambioCredenciales {
  solUser?: string;
  solPass?: string;
  clientId?: string;
  clientSecret?: string;
}

/** Empresas (contribuyentes) y sus credenciales. Las contraseñas solo entran y salen cifradas. */
export class TenantRepo {
  constructor(
    private readonly db: Db,
    private readonly claveCifrado: Buffer,
    private readonly pepper: string,
  ) {}

  async crear(e: NuevaEmpresa): Promise<{ tenant: Tenant; apiKey: string; apiSecret: string }> {
    const existente = await this.db.query("select id from tenants where ruc = $1", [e.ruc]);
    if (existente.length > 0) {
      throw new AppError("Ya existe una empresa registrada con ese RUC.", 409, "ruc_duplicado");
    }
    const cred = generateApiCredentials(this.pepper);
    const filas = await this.db.query<Tenant>(
      `insert into tenants (ruc, razon_social, api_key, api_secret_hash, environment, sol_user, sol_pass_enc, client_id, client_secret_enc, perfil)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       returning *`,
      [
        e.ruc,
        e.razonSocial,
        cred.apiKey,
        cred.apiSecretHash,
        e.environment ?? "prod",
        e.solUser ?? null,
        e.solPass ? encryptSecret(e.solPass, this.claveCifrado) : null,
        e.clientId ?? null,
        e.clientSecret ? encryptSecret(e.clientSecret, this.claveCifrado) : null,
        JSON.stringify(e.perfil ?? {}),
      ],
    );
    return { tenant: filas[0]!, apiKey: cred.apiKey, apiSecret: cred.apiSecret };
  }

  /** Valida el par api_key + api_secret que manda el portal. Devuelve la empresa o null. */
  async autenticar(apiKey: string, apiSecret: string): Promise<Tenant | null> {
    const filas = await this.db.query<Tenant>("select * from tenants where api_key = $1", [apiKey]);
    const t = filas[0];
    if (!t) return null;
    return verifyApiSecret(apiSecret, t.api_secret_hash, this.pepper) ? t : null;
  }

  async porId(id: number): Promise<Tenant | null> {
    return (await this.db.query<Tenant>("select * from tenants where id = $1", [id]))[0] ?? null;
  }

  /** Cambia solo lo que venga; cualquier cambio de credenciales desactiva SIRE hasta volver a verificarlas. */
  async actualizarCredenciales(id: number, c: CambioCredenciales): Promise<Tenant> {
    const sets: string[] = [];
    const valores: unknown[] = [id];
    const poner = (col: string, v: unknown) => {
      valores.push(v);
      sets.push(`${col} = $${valores.length}`);
    };
    if (c.solUser) poner("sol_user", c.solUser);
    if (c.solPass) poner("sol_pass_enc", encryptSecret(c.solPass, this.claveCifrado));
    if (c.clientId) poner("client_id", c.clientId);
    if (c.clientSecret) poner("client_secret_enc", encryptSecret(c.clientSecret, this.claveCifrado));
    if (sets.length === 0) throw new AppError("No se indicó ningún dato para cambiar.", 422, "sin_cambios");

    const filas = await this.db.query<Tenant>(
      `update tenants set ${sets.join(", ")}, sire_enabled = false, sire_last_error = null, updated_at = now()
       where id = $1 returning *`,
      valores,
    );
    return filas[0]!;
  }

  async marcarSire(id: number, activo: boolean, error: string | null): Promise<void> {
    await this.db.query(
      `update tenants set sire_enabled = $2, sire_last_error = $3,
         sire_activated_at = case when $2 then now() else sire_activated_at end, updated_at = now()
       where id = $1`,
      [id, activo, error],
    );
  }

  /** Credenciales descifradas, listas para pedir el token. Falla con un mensaje claro si falta algo. */
  credenciales(t: Tenant): CredencialesSunat {
    if (!t.sol_user || !t.sol_pass_enc || !t.client_id || !t.client_secret_enc) {
      throw new AppError(
        "Faltan credenciales de SUNAT para esta empresa (usuario y clave SOL, client_id y client_secret).",
        422,
        "faltan_credenciales",
      );
    }
    return {
      tenantId: t.id,
      ruc: t.ruc,
      solUser: t.sol_user,
      solPass: decryptSecret(t.sol_pass_enc, this.claveCifrado),
      clientId: t.client_id,
      clientSecret: decryptSecret(t.client_secret_enc, this.claveCifrado),
    };
  }
}
