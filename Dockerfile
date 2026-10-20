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
 && npm prune --omit=dev \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32

# ---- Runtime stage -------------------------------------------------------
# Debian-based (not alpine): better-sqlite3's native module is compiled
# against glibc in the build stage, and Debian's ffmpeg is installed below.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# Debian's ffmpeg/ffprobe, used instead of the bundled npm binaries. Those are
# static-glibc builds, which cannot resolve hostnames: they segfault on every
# https:// camera URL, so no capture or revalidation could ever succeed in
# this image. FFMPEG_PATH/FFPROBE_PATH (see ffmpegRunner.ts/probeRunner.ts)
# point the app at these instead.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe

COPY package.json package-lock.json ./
# Production-only dependencies, pruned and natively compiled in the build stage
# (onnxruntime-node trimmed to its Linux binaries; the CUDA download is skipped
# by .npmrc).
COPY --from=build /app/node_modules ./node_modules

# Compiled server + frontend bundle.
COPY --from=build /app/dist ./dist
# Camera registry data, read/written by CameraRegistryStore at runtime -
# mount this as a volume (see docker-compose.yml) to persist edits made by
# `npm run cameras:revalidate`. Also holds traffic-history.db, the SQLite
# file TrafficHistoryStore creates on first run - persisted the same way.
COPY data ./data
# YOLO11n (COCO, ONNX) for the boxes drawn over a watched camera - see
# LiveOverlayService. Resolved relative to dist/, i.e. /app/models.
COPY models ./models

EXPOSE 3001
CMD ["node", "dist/server/index.js"]
