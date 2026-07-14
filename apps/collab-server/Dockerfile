FROM node:22.17.0-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY apps/collab-server/package.json apps/collab-server/tsconfig.json ./apps/collab-server/
RUN --mount=type=cache,id=forgeboard-pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile --filter @forgeboard/collab-server...

COPY apps/collab-server ./apps/collab-server
RUN pnpm --filter @forgeboard/collab-server build
RUN pnpm deploy --filter @forgeboard/collab-server --prod /opt/forgeboard-collab

FROM node:22.17.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    FORGEBOARD_COLLAB_HOST=0.0.0.0 \
    FORGEBOARD_COLLAB_PORT=1234 \
    FORGEBOARD_COLLAB_DATABASE_PATH=/data/forgeboard-collab.sqlite

RUN groupadd --system --gid 10001 forgeboard \
  && useradd --system --uid 10001 --gid forgeboard --home-dir /opt/forgeboard-collab forgeboard \
  && mkdir -p /data \
  && chown forgeboard:forgeboard /data

WORKDIR /opt/forgeboard-collab
COPY --from=build --chown=forgeboard:forgeboard /opt/forgeboard-collab ./

USER forgeboard
VOLUME ["/data"]
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "fetch('http://127.0.0.1:1234/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/index.js"]
