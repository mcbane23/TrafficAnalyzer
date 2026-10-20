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
#
# Debian trixie rather than bookworm: the Intel GPU driver below comes from
# Intel's Ubuntu 24.04 repository (needs glibc >= 2.38), because bookworm's
# own driver (2022) predates the N150's integrated GPU.
FROM node:22-trixie AS build
WORKDIR /app

# Intel's GPU repository key, fetched here because the slim runtime image has
# neither curl nor gpg.
RUN curl -fsSL https://repositories.intel.com/gpu/intel-graphics.key | gpg --dearmor -o /intel-graphics.gpg

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 \
 && (cd node_modules/openvino-node/bin && rm -f libopenvino_onnx_frontend.so* libopenvino_paddle_frontend.so* libopenvino_pytorch_frontend.so* libopenvino_tensorflow_frontend.so* libopenvino_tensorflow_lite_frontend.so* libopenvino_gguf_frontend.so* libopenvino_intel_npu_plugin.so) \
 && ls node_modules/openvino-node/bin/libopenvino_ir_frontend.so* >/dev/null

# ---- Runtime stage -------------------------------------------------------
# Debian-based (not alpine): better-sqlite3's native module is compiled
# against glibc in the build stage, and Debian's ffmpeg is installed below.
FROM node:22-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# Debian's ffmpeg/ffprobe, used instead of the bundled npm binaries. Those are
# static-glibc builds, which cannot resolve hostnames: they segfault on every
# https:// camera URL, so no capture or revalidation could ever succeed in
# this image. FFMPEG_PATH/FFPROBE_PATH (see ffmpegRunner.ts/probeRunner.ts)
# point the app at these instead.
#
# intel-opencl-icd (Intel's compute runtime) is what OpenVINO's GPU plugin
# talks to when OVERLAY_DEVICE=GPU; it only does anything if the host's
# /dev/dri is passed into the container.
COPY --from=build /intel-graphics.gpg /usr/share/keyrings/intel-graphics.gpg
RUN echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble unified" \
      > /etc/apt/sources.list.d/intel-gpu.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates intel-opencl-icd \
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
# YOLO11n (COCO, ONNX, CPU) and YOLO11s (OpenVINO IR, Intel GPU) for the
# boxes drawn over a watched camera - see
# LiveOverlayService. Resolved relative to dist/, i.e. /app/models.
COPY models ./models

EXPOSE 3001
CMD ["node", "dist/server/index.js"]
