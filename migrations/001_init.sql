-- Esquema inicial de la API del SIRE.
-- Una "empresa" (tenant) es un contribuyente al que consultamos su SIRE con su propia Clave SOL.

create table tenants (
  id bigserial primary key,
  ruc text not null unique check (ruc ~ '^[0-9]{11}$'),
  razon_social text not null,
  -- Credencial de acceso a ESTA API (la que usa el portal): api_key en claro (identificador), el secreto solo en hash.
  api_key text not null unique,
  api_secret_hash text not null,
  environment text not null default 'prod' check (environment in ('beta', 'prod')),
  -- Credenciales de SUNAT. Lo sensible va cifrado (AES-256-GCM); nunca en texto plano.
  sol_user text,
  sol_pass_enc text,
  client_id text,
  client_secret_enc text,
  perfil jsonb not null default '{}'::jsonb,
  sire_enabled boolean not null default false,
  sire_activated_at timestamptz,
  sire_last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Cada paso del SIRE (descargar propuesta, aceptar, enviar…) genera un ticket en SUNAT.
create table sire_tickets (
  id bigserial primary key,
  tenant_id bigint not null references tenants (id) on delete cascade,
  libro text not null check (libro in ('rce', 'rvie')),
  num_ticket text not null,
  per_tributario text not null check (per_tributario ~ '^[0-9]{6}$'),
  -- Para qué se pidió: 'propuesta' (se descarga y se lee a comprobantes) u 'otro'.
  proposito text not null default 'otro' check (proposito in ('propuesta', 'otro')),
  cod_proceso text,
  des_proceso text,
  cod_estado text,
  des_estado text,
  nom_archivo_reporte text,
  cod_tipo_archivo_reporte text,
  cnt_filas_validadas integer,
  cnt_cp_informados integer,
  cnt_cp_error integer,
  archivo_path text,
  poll_attempts integer not null default 0,
  last_polled_at timestamptz,
  finished_at timestamptz,
  ultimo_error text,
  respuesta_sunat jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, num_ticket)
);
create index sire_tickets_tenant_creado on sire_tickets (tenant_id, created_at desc);
create index sire_tickets_tenant_periodo on sire_tickets (tenant_id, per_tributario);

-- Comprobantes leídos de las propuestas (compras = RCE, ventas = RVIE).
create table sire_comprobantes (
  id bigserial primary key,
  tenant_id bigint not null references tenants (id) on delete cascade,
  libro text not null check (libro in ('rce', 'rvie')),
  per_tributario text not null,
  fase text not null default 'propuesta' check (fase in ('propuesta', 'preliminar', 'registrado')),
  ticket_id bigint references sire_tickets (id) on delete set null,
  car_sunat text,
  fec_emision date,
  fec_vcto date,
  cod_tipo_cdp text,
  num_serie_cdp text,
  num_cdp text,
  -- Contraparte: proveedor en compras, adquiriente (cliente) en ventas.
  cod_tipo_doc_contraparte text,
  num_doc_contraparte text,
  razon_social_contraparte text,
  mto_bi_gravada numeric(16, 2) not null default 0,
  mto_igv numeric(16, 2) not null default 0,
  mto_bi_no_gravada numeric(16, 2) not null default 0,
  mto_total numeric(16, 2) not null default 0,
  cod_moneda text,
  tipo_cambio numeric(10, 3),
  estado_comprobante text,
  -- Fila completa tal como la entregó SUNAT (por nombre de columna), para no perder datos al normalizar.
  datos jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index sire_comprobantes_busqueda on sire_comprobantes (tenant_id, libro, per_tributario, fase);

-- Cola de trabajos en segundo plano (sondear tickets, descargar archivos, leerlos).
create table jobs (
  id bigserial primary key,
  tenant_id bigint references tenants (id) on delete cascade,
  tipo text not null,
  payload jsonb not null default '{}'::jsonb,
  estado text not null default 'queued' check (estado in ('queued', 'running', 'done', 'failed')),
  intentos integer not null default 0,
  max_intentos integer not null default 10,
  ejecutar_en timestamptz not null default now(),
  bloqueado_en timestamptz,
  ultimo_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_pendientes on jobs (ejecutar_en) where estado = 'queued';

-- Bitácora de lo que se hizo con una empresa. Es obligatoria para toda operación que ESCRIBA en SUNAT.
create table audit_log (
  id bigserial primary key,
  tenant_id bigint references tenants (id) on delete set null,
  accion text not null,
  detalle jsonb not null default '{}'::jsonb,
  creado_por text,
  created_at timestamptz not null default now()
);
create index audit_log_tenant on audit_log (tenant_id, created_at desc);
