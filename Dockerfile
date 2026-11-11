ARG RUNTIME_IMAGE=ghcr.io/cheftaco/hive-node-runtime:26.13.1-1@sha256:7671ab0a702c273c37a84d089ba6fe821c6d85cbeab888e7e43522a057da5e6d
FROM node:24.22.3-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /build
RUN apt-get update -qq && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --ignore-scripts && npm --prefix tooling/release ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM ${RUNTIME_IMAGE}
USER root
ENV NODE_ENV=production HOST=0.0.0.0 HIVE_AUTO_MIGRATE=false HIVE_AUTO_UPGRADE=false HIVE_UPDATE_CHECK=false HIVE_HOME=/data
RUN mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /build/package.json /app/package.json
COPY --from=build --chown=node:node /build/node_modules /app/node_modules
COPY --from=build --chown=node:node /build/dist /app/dist
COPY LICENSE NOTICE /app/
# Exercise the copied native SQLite artifact against the final glibc runtime.
RUN node -e "const {DatabaseSync}=require('@photostructure/sqlite'); const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE proof (value TEXT)'); db.prepare('INSERT INTO proof VALUES (?)').run('synthetic'); if(db.prepare('SELECT value FROM proof').get().value !== 'synthetic') process.exit(1); db.close()"
COPY scripts/container-health.mjs /app/healthcheck.mjs
ENV HIVE_HEALTH_URL=https://localhost:4020/health/ready
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "/app/healthcheck.mjs"]
USER node
WORKDIR /app/.
VOLUME ["/data"]
EXPOSE 4020 9443
ENTRYPOINT ["node", "dist/src/index.js"]
