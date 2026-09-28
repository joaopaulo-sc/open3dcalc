# Fork ModelInk3D — imagem única: build web (modo servidor) + server/.
#
# NÃO buildar na VM de produção (1 GB RAM): o build do Vite estoura a memória.
# Builda na máquina de dev ou no CI e envia a imagem pronta (ver deploy/README.md).

# ---- build web -------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /build
# CI=1 pula o electron-rebuild do postinstall; o binário do Electron não é baixado.
ENV CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 HUSKY=0
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY . .
ENV VITE_CALC_SERVER=1
RUN npm run build:web

# ---- dependências do servidor ------------------------------------------------
FROM node:24-alpine AS server-deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime -----------------------------------------------------------------
FROM node:24-alpine
ENV NODE_ENV=production \
    CALC_DATA_DIR=/data \
    CALC_STATIC_DIR=/app/web \
    PORT=8080 \
    NODE_OPTIONS="--max-old-space-size=128 --disable-warning=ExperimentalWarning"
WORKDIR /app/server
COPY --from=server-deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY server/public ./public
COPY --from=web /build/dist-web /app/web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "src/index.ts"]
