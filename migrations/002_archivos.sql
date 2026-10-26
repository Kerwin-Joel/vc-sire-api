-- Archivos que entrega SUNAT (ZIP, PDF), guardados en la propia base.
-- Así la API y el worker pueden ser servicios distintos sin compartir un disco (en Render un disco va con un solo servicio).
-- Son archivos chicos (cientos de KB); si algún día pesan mucho, se pasa a almacenamiento de objetos (S3/R2) sin tocar el resto.
create table archivos (
  ruta text primary key,
  contenido bytea not null,
  bytes integer not null,
  created_at timestamptz not null default now()
);
