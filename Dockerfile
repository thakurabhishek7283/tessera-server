# syntax=docker/dockerfile:1

# ---- build: compile TypeScript and assemble a production node_modules ----
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Toolchain for better-sqlite3 (native, built from source when no prebuilt binary matches) and git
# for fetching the @tessera-kit/protocol dependency by tag.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc deps.json ./
COPY scripts ./scripts
# Clones and builds the tessera repo at the ref in deps.json into ./external (see package.json overrides).
RUN node scripts/fetch-deps.mjs --ci
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# The link: override only exists for local development, so after pruning dev dependencies the
# link is replaced with a real copy of the built @tessera-kit/protocol package.
RUN pnpm build \
 && pnpm prune --prod \
 && rm -rf node_modules/@tessera-kit/protocol \
 && mkdir -p node_modules/@tessera-kit/protocol \
 && cp -r external/tessera/packages/protocol/dist external/tessera/packages/protocol/package.json node_modules/@tessera-kit/protocol/

# ---- runtime: only what is needed to run, as an unprivileged user ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/tessera.db \
    UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# /data is the only writable location, so the image also runs with a read-only root filesystem.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
