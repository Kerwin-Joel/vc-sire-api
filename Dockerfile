# API del SIRE — imagen de producción (la misma imagen sirve para la API y para el worker).
#   docker build -t vc-sire-api .
#   docker run --env-file .env -p 8080:8080 vc-sire-api            # API
#   docker run --env-file .env vc-sire-api node dist/worker.js      # worker

FROM node:24-alpine AS construir
# npm fijo: el mismo que genera el package-lock.json, para que `npm ci` sea reproducible.
RUN npm install -g npm@11.21.1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS produccion
ENV NODE_ENV=production
RUN npm install -g npm@11.21.1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=construir /app/dist ./dist
COPY migrations ./migrations

# Corre sin privilegios y con una carpeta propia para los archivos de SUNAT.
RUN mkdir -p /data/archivos && chown -R node:node /data /app
USER node
# Por defecto los archivos de SUNAT van a Postgres (STORAGE_DRIVER=postgres); /data solo se usa con STORAGE_DRIVER=local.
ENV STORAGE_DIR=/data/archivos

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8080}/health || exit 1

CMD ["node", "dist/server.js"]
