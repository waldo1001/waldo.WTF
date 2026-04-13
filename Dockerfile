# waldo.WTF — container image
#
# Multi-stage build:
#   - deps:    install production node_modules (compiles better-sqlite3 if no prebuilt)
#   - runtime: slim image with just node, node_modules, and source
#
# Target arch is set by `docker buildx build --platform linux/arm64` (Synology DS223).
# Works unchanged on linux/amd64 too.

# ---------- deps ----------
FROM node:22-bookworm-slim AS deps

# Build tools for better-sqlite3 when a prebuilt binary is missing for the target arch.
# node:22-bookworm-slim already has a usable libc; we just need python/make/g++.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

# tsx entrypoint is a dev dependency; we re-install it into a dedicated layer so
# the runtime image doesn't need the C toolchain from the deps stage.
WORKDIR /app

# Non-root user. UID 1001 is a common "node" convention on Debian-based images;
# node:bookworm-slim already ships a `node` user (UID 1000), which we reuse.
ENV NODE_ENV=production
ENV WALDO_BIND_HOST=0.0.0.0
ENV WALDO_DB_PATH=/data/db/lake.db
ENV WALDO_AUTH_DIR=/data/auth

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# tsx is a devDependency and was NOT copied above. Install it directly into
# node_modules for runtime use (tiny — zero native deps).
RUN npm install --no-save --omit=optional tsx@^4.19.0

# Create the volume mount points with ownership for the `node` user so
# bind-mounted host dirs with matching UID can read/write.
RUN mkdir -p /data/db /data/auth && chown -R node:node /app /data

USER node

VOLUME ["/data/db", "/data/auth"]

EXPOSE 8765

# Single entrypoint used for both the long-running server and the one-shot
# `--add-account` login flow (`docker compose run --rm waldo --add-account`).
ENTRYPOINT ["node_modules/.bin/tsx", "src/cli.ts"]
