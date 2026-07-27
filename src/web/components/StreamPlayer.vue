<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Hls from 'hls.js';
import type { CameraEntry } from '../../types/camera';

const props = defineProps<{ camera: CameraEntry }>();

const videoRef = ref<HTMLVideoElement | null>(null);
const error = ref<string | null>(null);
let hls: Hls | null = null;

function destroy() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
}

function attach() {
  destroy();
  error.value = null;

  if (props.camera.status !== 'active') {
    error.value = props.camera.lastError ?? 'This camera is currently marked inactive.';
    return;
  }

  if (props.camera.protocol !== 'HLS') {
    error.value = `Playback for protocol "${props.camera.protocol}" isn't supported yet.`;
    return;
  }

  const video = videoRef.value;
  if (!video) return;

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Native HLS support (Safari) - no hls.js needed.
    video.src = props.camera.url;
    video.play().catch(() => undefined);
    return;
  }

  if (Hls.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        error.value = `Stream error: ${data.details}`;
      }
    });
    hls.loadSource(props.camera.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => undefined);
    });
    return;
  }

  error.value = 'HLS playback is not supported in this browser.';
}

onMounted(attach);
onBeforeUnmount(destroy);
watch(() => props.camera.id, attach);
</script>

<template>
  <div class="overflow-hidden rounded-xl bg-black">
    <video v-show="!error" ref="videoRef" class="aspect-video w-full" controls muted playsinline></video>
    <div v-if="error" class="flex aspect-video w-full items-center justify-center p-6 text-center text-sm text-slate-300">
      {{ error }}
    </div>
  </div>
</template>
