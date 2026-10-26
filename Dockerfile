# API del SIRE — imagen de producción (la misma imagen sirve para la API y para el worker).
#   docker build -t vc-sire-api .
#   docker run --env-file .env -p 8080:8080 vc-sire-api            # API
#   docker run --env-file .env vc-sire-api node dist/worker.js      # worker

FROM node:22-alpine AS construir
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS produccion
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=construir /app/dist ./dist
COPY migrations ./migrations

# Corre sin privilegios y con una carpeta propia para los archivos de SUNAT.
RUN mkdir -p /data/archivos && chown -R node:node /data /app
USER node
ENV STORAGE_DIR=/data/archivos
VOLUME ["/data"]

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-8080}/health || exit 1

CMD ["node", "dist/server.js"]
