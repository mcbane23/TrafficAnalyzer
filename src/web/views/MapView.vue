<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { CameraEntry } from '../../types/camera';
import type { CameraAnalysisOverview, TrafficLevel } from '../../types/analysis';
import { fetchCameras } from '../services/api';
import { fetchAnalyzedCameras, fetchLatestOverview, subscribeOverview } from '../services/analysis';
import { TRAFFIC_LABELS } from '../composables/trafficUi';
import { t } from '../i18n';

// Marker fill per traffic level, matching the dashboard's stripe colors (emerald/amber/red-500).
const LEVEL_COLORS: Record<TrafficLevel, string> = { light: '#10b981', moderate: '#f59e0b', heavy: '#ef4444' };
const NOT_ANALYZED = '#64748b';
const BELGRADE: L.LatLngExpression = [44.8125, 20.4612];

const router = useRouter();
const mapEl = ref<HTMLDivElement | null>(null);
const cameras = ref<CameraEntry[]>([]);
const analyzed = ref<Set<string> | null>(null);
const overview = shallowRef(new Map<string, CameraAnalysisOverview>());
const error = ref<string | null>(null);
let map: L.Map | null = null;
const markers = new Map<string, L.CircleMarker>();
let unsubscribe: (() => void) | null = null;

const placed = computed(() => cameras.value.filter((c) => c.location.lat !== undefined && c.location.lon !== undefined));
const unplaced = computed(() => cameras.value.filter((c) => c.location.lat === undefined || c.location.lon === undefined));

/** What a marker says about its camera: color, and the same in words (the color alone isn't enough). */
function describe(camera: CameraEntry): { color: string; text: string } {
  if (camera.status !== 'active') return { color: '#1e293b', text: t('map.offline') };
  const entry = overview.value.get(camera.id);
  const isAnalyzed = analyzed.value === null || analyzed.value.has(camera.id);
  if (!isAnalyzed || !entry || entry.error) return { color: NOT_ANALYZED, text: t('map.notAnalyzed') };
  return { color: LEVEL_COLORS[entry.trafficLevel], text: t('map.level', { level: TRAFFIC_LABELS[entry.trafficLevel] }) };
}

function popupFor(camera: CameraEntry, text: string): HTMLElement {
  const box = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = camera.name;
  const state = document.createElement('div');
  state.textContent = text;
  const open = document.createElement('a');
  open.href = `/cameras/${encodeURIComponent(camera.id)}`;
  open.textContent = t('map.open');
  open.addEventListener('click', (event) => {
    event.preventDefault();
    void router.push({ name: 'camera-detail', params: { id: camera.id } });
  });
  box.append(name, state, open);
  box.className = 'map-popup';
  return box;
}

function render() {
  if (!map) return;
  for (const camera of placed.value) {
    const { color, text } = describe(camera);
    let marker = markers.get(camera.id);
    if (!marker) {
      marker = L.circleMarker([camera.location.lat!, camera.location.lon!], { radius: 9, weight: 2, color: '#0f172a', fillOpacity: 0.95 }).addTo(map);
      markers.set(camera.id, marker);
    }
    marker.setStyle({ fillColor: color });
    marker.bindTooltip(`${camera.name} · ${text}`);
    marker.bindPopup(popupFor(camera, text));
  }
}

onMounted(async () => {
  if (mapEl.value) {
    map = L.map(mapEl.value, { zoomControl: true }).setView(BELGRADE, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  }
  try {
    cameras.value = await fetchCameras();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return;
  }
  try {
    const ids = await fetchAnalyzedCameras();
    analyzed.value = ids === null ? null : new Set(ids);
    overview.value = new Map((await fetchLatestOverview()).map((entry) => [entry.cameraId, entry]));
  } catch {
    // Markers show as not analyzed until the stream delivers a level.
  }
  render();
  if (map && placed.value.length) map.fitBounds(L.latLngBounds(placed.value.map((c) => [c.location.lat!, c.location.lon!])), { padding: [30, 30] });
  unsubscribe = subscribeOverview((entry) => {
    const next = new Map(overview.value);
    next.set(entry.cameraId, entry);
    overview.value = next;
  });
});
watch(overview, render);

onBeforeUnmount(() => {
  unsubscribe?.();
  map?.remove();
  map = null;
  markers.clear();
});
</script>

<template>
  <main class="mx-auto max-w-7xl px-4 py-6">
    <h1 class="text-2xl font-bold text-slate-100">{{ t('map.title') }}</h1>
    <p class="mt-1 text-sm text-slate-400">{{ t('map.subtitle') }}</p>
    <p v-if="error" class="mt-4 text-sm text-red-300">{{ error }}</p>
    <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400" :aria-label="t('map.legend')">
      <span v-for="level in (['light', 'moderate', 'heavy'] as const)" :key="level" class="inline-flex items-center gap-1.5">
        <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: LEVEL_COLORS[level] }"></span>{{ TRAFFIC_LABELS[level] }}
      </span>
      <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: NOT_ANALYZED }"></span>{{ t('map.notAnalyzed') }}</span>
      <span class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full border border-slate-500 bg-slate-800"></span>{{ t('map.offline') }}</span>
    </div>
    <div ref="mapEl" class="map-tiles mt-3 h-[65vh] min-h-[320px] overflow-hidden rounded-xl border border-slate-800" role="region" :aria-label="t('map.title')"></div>
    <!-- The same as text: the markers can't be reached with a keyboard or read by a screen reader. -->
    <details class="mt-3 rounded-xl border border-slate-800 bg-slate-900 px-4 py-2 text-sm">
      <summary class="cursor-pointer py-1 text-slate-300">{{ t('map.list', { count: cameras.length }) }}</summary>
      <ul class="mt-2 grid gap-1 pb-2 sm:grid-cols-2 lg:grid-cols-3">
        <li v-for="camera in cameras" :key="camera.id" class="flex items-center gap-2">
          <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: describe(camera).color }" aria-hidden="true"></span>
          <router-link :to="{ name: 'camera-detail', params: { id: camera.id } }" class="truncate text-slate-200 hover:underline">{{ camera.name }}</router-link>
          <span class="shrink-0 text-xs text-slate-500">{{ describe(camera).text }}</span>
        </li>
      </ul>
    </details>
    <p v-if="unplaced.length" class="mt-2 text-xs text-slate-500">{{ t('map.unplaced', { names: unplaced.map((c) => c.name).join(', ') }) }}</p>
  </main>
</template>

<style scoped>
/* Dimmed in the dark theme, so the bright map doesn't glare next to the rest of the page. */
:root[data-theme='dark'] .map-tiles :deep(.leaflet-tile-pane) {
  filter: brightness(0.75) contrast(1.1) saturate(0.85);
}
.map-tiles :deep(.map-popup) {
  display: grid;
  gap: 2px;
  font-size: 13px;
}
.map-tiles :deep(.map-popup a) {
  margin-top: 4px;
  font-weight: 600;
}
</style>
