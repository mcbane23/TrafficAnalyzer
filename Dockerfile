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

# .npmrc too: it is what stops onnxruntime-node's install script downloading
# its CUDA/TensorRT providers (~270 MB, useless without an NVIDIA GPU). Without
# it in the build context at `npm ci`, they ended up in every image.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
# After pruning, delete what the amd64 Linux runtime never loads:
# - the bundled ffmpeg/ffprobe (~140 MB): FFMPEG_PATH/FFPROBE_PATH point at
#   the ffmpeg stage's, and ffmpegRunner.ts/probeRunner.ts only require the packages
#   when those are unset;
# - other platforms' native binaries (onnxruntime-node, sharp, better-sqlite3)
#   and better-sqlite3's SQLite sources (it loads prebuilds/linux-x64.node);
# - openvino-node's unused frontends and NPU plugin. The IR frontend (the
#   model format) and the CPU and GPU plugins stay.
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf node_modules/@ffmpeg-installer node_modules/@ffprobe-installer \
 && rm -rf node_modules/onnxruntime-node/bin/napi-v*/darwin node_modules/onnxruntime-node/bin/napi-v*/win32 node_modules/onnxruntime-node/bin/napi-v*/linux/arm64 \
 && rm -rf node_modules/@img/sharp-wasm32 node_modules/@img/sharp-linuxmusl-x64 node_modules/@img/sharp-libvips-linuxmusl-x64 \
 && (cd node_modules/better-sqlite3 && rm -rf deps src && find prebuilds -type f ! -name linux-x64.node -delete) \
 && ls node_modules/onnxruntime-node/bin/napi-v*/linux/x64/onnxruntime_binding.node node_modules/better-sqlite3/prebuilds/linux-x64.node >/dev/null \
 && (cd node_modules/openvino-node/bin && rm -f libopenvino_onnx_frontend.so* libopenvino_paddle_frontend.so* libopenvino_pytorch_frontend.so* libopenvino_tensorflow_frontend.so* libopenvino_tensorflow_lite_frontend.so* libopenvino_gguf_frontend.so* libopenvino_intel_npu_plugin.so) \
 && ls node_modules/openvino-node/bin/libopenvino_ir_frontend.so* >/dev/null

# ---- ffmpeg stage -------------------------------------------------------
# A minimal ffmpeg/ffprobe, built with only what the cameras need: H.264/HEVC
# and MJPEG decoding, HLS/MPEG-TS/RTSP input over http(s), and the fps/scale
# filters with raw video output. Every active camera keeps one ffmpeg running,
# and Debian's build links dozens of codec libraries whose start-up cost
# (~18 MB of private memory) each of those processes pays. Measured on 22
# live cameras: ~36 MB per capture with Debian's ffmpeg, ~17 MB with this one.
# Linked dynamically against glibc (unlike the bundled npm binaries, it can
# resolve hostnames), OpenSSL for https and zlib.
FROM debian:trixie AS ffmpeg
ARG FFMPEG_VERSION=7.1.5
ARG FFMPEG_SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils build-essential pkg-config nasm libssl-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL -o ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
 && tar xf ffmpeg.tar.xz --strip-components=1 \
 && ./configure --prefix=/opt/ffmpeg \
      --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-ffplay \
      --enable-openssl --enable-zlib \
      --enable-protocol=file,pipe,http,https,httpproxy,tcp,tls,udp,rtp,crypto,hls \
      --enable-demuxer=hls,mpegts,mov,rtsp,rtp,sdp,mjpeg,mpjpeg,h264,hevc,aac \
      --enable-decoder=h264,hevc,mjpeg,aac \
      --enable-parser=h264,hevc,mjpeg,aac \
      --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb \
      --enable-filter=fps,scale,format,showinfo,null,anull \
      --enable-encoder=rawvideo --enable-muxer=rawvideo \
 && make -j"$(nproc)" \
 && make install \
 && /opt/ffmpeg/bin/ffmpeg -hide_banner -protocols | grep -q https

# ---- Runtime stage -------------------------------------------------------
# Debian-based (not alpine): better-sqlite3's native module is compiled
# against glibc in the build stage, and so is the ffmpeg stage's ffmpeg.
FROM node:22-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# The minimal ffmpeg/ffprobe from the ffmpeg stage, used instead of the
# bundled npm binaries. Those are static-glibc builds, which cannot resolve
# hostnames: they segfault on every https:// camera URL, so no capture or
# revalidation could ever succeed in this image. FFMPEG_PATH/FFPROBE_PATH
# (see ffmpegRunner.ts/probeRunner.ts) point the app at these instead. Its
# only runtime library outside the base image is OpenSSL (libssl3t64).
#
# intel-opencl-icd (Intel's compute runtime) is what OpenVINO's GPU plugin
# talks to when OVERLAY_DEVICE=GPU; it only does anything if the host's
# /dev/dri is passed into the container.
COPY --from=build /intel-graphics.gpg /usr/share/keyrings/intel-graphics.gpg
# ca-certificates goes in first: the slim image has none, and Intel's
# repository is HTTPS-only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/intel-graphics.gpg] https://repositories.intel.com/gpu/ubuntu noble unified" \
      > /etc/apt/sources.list.d/intel-gpu.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends libssl3t64 intel-opencl-icd \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
ENV FFMPEG_PATH=/usr/local/bin/ffmpeg
ENV FFPROBE_PATH=/usr/local/bin/ffprobe

COPY package.json ./
# Production-only dependencies, pruned and trimmed in the build stage. The
# frontend's libraries (vue, chart.js, hls.js...) are devDependencies: Vite
# bundles them into dist/web, so they aren't needed here.
COPY --from=build /app/node_modules ./node_modules

# Compiled server + frontend bundle.
COPY --from=build /app/dist ./dist
# Camera registry data, read/written by CameraRegistryStore at runtime -
# mount this as a volume (see docker-compose.yml) to persist edits made by
# `npm run cameras:revalidate`. Also holds traffic-history.db, the SQLite
# file TrafficHistoryStore creates on first run - persisted the same way.
COPY data ./data
# A second copy outside data/, which a mount hides: on start the server copies
# whatever data/cameras lacks from here, so an empty bind mount (./data) gets
# the default registry instead of a server that can't start.
COPY data/cameras ./defaults/cameras
# YOLO26 models (COCO; ONNX for the CPU, OpenVINO IR for an Intel GPU) for the
# boxes drawn over a watched camera - see
# LiveOverlayService. Resolved relative to dist/, i.e. /app/models.
COPY models ./models

EXPOSE 3001
# Marks the container unhealthy when the server stops answering (TrueNAS and
# `docker ps` show it). The slim image has no curl, so Node's own fetch asks.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
