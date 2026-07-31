# syntax=docker/dockerfile:1

# ---- Build stage --------------------------------------------------------
# Compiles the Express/TS server (tsc -> dist/) and the Vue/Vite frontend
# (-> dist/web/), matching the paths src/server/index.ts and
# src/web/vite.config.ts already expect relative to each other.
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage -------------------------------------------------------
# Debian-based (not alpine): @ffprobe-installer/ffprobe only ships glibc
# binaries for linux, which musl-based alpine images can't run.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled server + frontend bundle.
COPY --from=build /app/dist ./dist
# Bundled ONNX vehicle-detection model (see src/analysis/onnxRunner.ts) -
# shipped in the image so there's no runtime/first-boot download.
COPY models ./models
# Camera registry data, read/written by CameraRegistryStore at runtime -
# mount this as a volume (see docker-compose.yml) to persist edits made by
# `npm run cameras:revalidate`. Also holds traffic-history.db, the SQLite
# file TrafficHistoryStore creates on first run - persisted the same way.
COPY data ./data

EXPOSE 3001
CMD ["node", "dist/server/index.js"]
