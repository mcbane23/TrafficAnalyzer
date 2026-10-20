# syntax=docker/dockerfile:1

# ---- Build stage --------------------------------------------------------
# Compiles the Express/TS server (tsc -> dist/) and the Vue/Vite frontend
# (-> dist/web/), matching the paths src/server/index.ts and
# src/web/vite.config.ts already expect relative to each other.
# Node 22 to satisfy package.json's `engines` (>=22.12, required by Vite).
# Full (non-slim) image for the build stage only: better-sqlite3 ships a
# binding.gyp, so npm compiles it from source on install (node-gyp), which
# needs the Python + C/C++ toolchain the slim image lacks. The runtime stage
# copies the already-compiled node_modules instead of installing again.
FROM node:22-bookworm AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
 && npm prune --omit=dev

# ---- Runtime stage -------------------------------------------------------
# Debian-based (not alpine): @ffprobe-installer/ffprobe and
# @ffmpeg-installer/ffmpeg only ship glibc binaries for linux, which
# musl-based alpine images can't run.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
# Production-only dependencies, pruned and natively compiled in the build stage.
COPY --from=build /app/node_modules ./node_modules

# Compiled server + frontend bundle.
COPY --from=build /app/dist ./dist
# Camera registry data, read/written by CameraRegistryStore at runtime -
# mount this as a volume (see docker-compose.yml) to persist edits made by
# `npm run cameras:revalidate`. Also holds traffic-history.db, the SQLite
# file TrafficHistoryStore creates on first run - persisted the same way.
COPY data ./data

EXPOSE 3001
CMD ["node", "dist/server/index.js"]
