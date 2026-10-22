<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { RoadAxis } from '../../types/stats';
import { t } from '../i18n';

type Point = [number, number];
type Zone = { name?: string; points: Point[] };

/**
 * Draws a camera's ignore zones over a still of its view: click to place a
 * new zone's corners and close it on its first corner (or "Finish"), drag a
 * selected zone's corners to adjust it, delete one. Corners are kept in
 * normalized (0-1) frame coordinates, as the registry stores them. When the
 * statistics have learned the camera's road axis, arrows mark which way
 * directions A and B run, so they can be named.
 */
const props = defineProps<{
  imageUrl: string;
  axis: RoadAxis | null;
  labelA: string;
  labelB: string;
}>();
const zones = defineModel<Zone[]>({ required: true });

const svg = ref<SVGSVGElement | null>(null);
/** The still's pixel size, so the drawing keeps the picture's proportions (the cameras are 704x576). */
const size = ref({ width: 704, height: 576 });
const imageFailed = ref(false);
const drawing = ref<Point[] | null>(null);
const hover = ref<Point | null>(null);
const selected = ref<number | null>(null);
const dragging = ref<{ zone: number; point: number } | null>(null);

const px = (p: Point) => [p[0] * size.value.width, p[1] * size.value.height] as const;
const pointsAttr = (points: Point[]) => points.map((p) => px(p).join(',')).join(' ');
/** Corner handles a fixed on-screen size, whatever the still's resolution. */
const handleRadius = computed(() => size.value.width / 110);

function onImageLoad(event: Event) {
  const img = event.target as HTMLImageElement;
  if (img.naturalWidth && img.naturalHeight) size.value = { width: img.naturalWidth, height: img.naturalHeight };
  imageFailed.value = false;
}

function toPoint(event: PointerEvent | MouseEvent): Point {
  const rect = svg.value!.getBoundingClientRect();
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
  return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)];
}

/** Within a few pixels on screen of `a`, so a click on the first corner closes the zone. */
function near(a: Point, b: Point): boolean {
  const rect = svg.value!.getBoundingClientRect();
  return Math.hypot((a[0] - b[0]) * rect.width, (a[1] - b[1]) * rect.height) < 12;
}

function startZone() {
  selected.value = null;
  drawing.value = [];
}

function finishZone() {
  const points = drawing.value;
  drawing.value = null;
  hover.value = null;
  if (!points || points.length < 3) return;
  zones.value = [...zones.value, { name: t('zones.defaultName', { n: zones.value.length + 1 }), points }];
  selected.value = zones.value.length - 1;
}

function cancelZone() {
  drawing.value = null;
  hover.value = null;
}

function removeZone(index: number) {
  zones.value = zones.value.filter((_, i) => i !== index);
  selected.value = null;
}

function renameZone(index: number, name: string) {
  zones.value = zones.value.map((zone, i) => (i === index ? { ...zone, name: name.trim() || undefined } : zone));
}

function onCanvasClick(event: MouseEvent) {
  if (!drawing.value) {
    selected.value = null;
    return;
  }
  const point = toPoint(event);
  if (drawing.value.length >= 3 && near(point, drawing.value[0])) finishZone();
  else drawing.value = [...drawing.value, point];
}

function onPointerMove(event: PointerEvent) {
  if (drawing.value) hover.value = toPoint(event);
  const drag = dragging.value;
  if (!drag) return;
  const point = toPoint(event);
  zones.value = zones.value.map((zone, i) =>
    i === drag.zone ? { ...zone, points: zone.points.map((p, j) => (j === drag.point ? point : p)) } : zone,
  );
}

function startDrag(event: PointerEvent, zone: number, point: number) {
  event.stopPropagation();
  (event.target as Element).setPointerCapture?.(event.pointerId);
  dragging.value = { zone, point };
}

function selectZone(event: MouseEvent, index: number) {
  if (drawing.value) return;
  event.stopPropagation();
  selected.value = index;
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && drawing.value) {
    event.stopPropagation();
    cancelZone();
  } else if (event.key === 'Enter' && drawing.value) {
    // Not the dialog's "Save": Enter here closes the zone being drawn.
    event.preventDefault();
    event.stopPropagation();
    finishZone();
  }
}

/** Arrows from the middle of the picture along the road axis: A one way, B the other. */
const axisArrows = computed(() => {
  if (!props.axis) return null;
  const { width, height } = size.value;
  const length = Math.min(width, height) * 0.28;
  const cx = width / 2;
  const cy = height / 2;
  const end = (sign: number) => [cx + sign * props.axis!.x * length, cy + sign * props.axis!.y * length] as const;
  return { cx, cy, a: end(1), b: end(-1) };
});

onMounted(() => window.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <div>
    <div class="relative overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
      <img
        :src="imageUrl"
        alt=""
        class="block w-full select-none"
        draggable="false"
        @load="onImageLoad"
        @error="imageFailed = true"
      />
      <div v-if="imageFailed" class="flex aspect-[704/576] items-center justify-center p-6 text-center text-sm text-slate-400">
        {{ t('zones.noImage') }}
      </div>
      <svg
        ref="svg"
        class="absolute inset-0 h-full w-full touch-none"
        :class="drawing ? 'cursor-crosshair' : ''"
        :viewBox="`0 0 ${size.width} ${size.height}`"
        preserveAspectRatio="none"
        @click="onCanvasClick"
        @pointermove="onPointerMove"
        @pointerup="dragging = null"
        @pointerleave="hover = null"
      >
        <defs>
          <marker id="zone-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#38bdf8" />
          </marker>
        </defs>

        <g v-if="axisArrows" class="pointer-events-none">
          <line
            :x1="axisArrows.cx" :y1="axisArrows.cy" :x2="axisArrows.a[0]" :y2="axisArrows.a[1]"
            stroke="#38bdf8" :stroke-width="handleRadius * 0.7" marker-end="url(#zone-arrow)"
          />
          <line
            :x1="axisArrows.cx" :y1="axisArrows.cy" :x2="axisArrows.b[0]" :y2="axisArrows.b[1]"
            stroke="#38bdf8" :stroke-width="handleRadius * 0.7" stroke-dasharray="6 4" marker-end="url(#zone-arrow)"
          />
          <text :x="axisArrows.a[0]" :y="axisArrows.a[1]" dy="-10" :text-anchor="axisArrows.a[0] > axisArrows.cx ? 'end' : 'start'" fill="#e0f2fe" :font-size="handleRadius * 3" paint-order="stroke" stroke="#0f172a" stroke-width="4">A: {{ labelA }}</text>
          <text :x="axisArrows.b[0]" :y="axisArrows.b[1]" dy="-10" :text-anchor="axisArrows.b[0] > axisArrows.cx ? 'end' : 'start'" fill="#e0f2fe" :font-size="handleRadius * 3" paint-order="stroke" stroke="#0f172a" stroke-width="4">B: {{ labelB }}</text>
        </g>

        <g v-for="(zone, index) in zones" :key="index">
          <polygon
            :points="pointsAttr(zone.points)"
            :fill="selected === index ? 'rgba(248,113,113,0.40)' : 'rgba(248,113,113,0.25)'"
            :stroke="selected === index ? '#fca5a5' : '#f87171'"
            :stroke-width="handleRadius * 0.45"
            class="cursor-pointer"
            @click="selectZone($event, index)"
          />
          <template v-if="selected === index && !drawing">
            <circle
              v-for="(point, j) in zone.points"
              :key="j"
              :cx="px(point)[0]"
              :cy="px(point)[1]"
              :r="handleRadius"
              fill="#fff"
              stroke="#b91c1c"
              :stroke-width="handleRadius * 0.35"
              class="cursor-move"
              @pointerdown="startDrag($event, index, j)"
              @click.stop
            />
          </template>
        </g>

        <g v-if="drawing" class="pointer-events-none">
          <polyline
            :points="pointsAttr(hover ? [...drawing, hover] : drawing)"
            fill="rgba(250,204,21,0.15)"
            stroke="#facc15"
            :stroke-width="handleRadius * 0.45"
          />
          <circle
            v-for="(point, j) in drawing"
            :key="j"
            :cx="px(point)[0]"
            :cy="px(point)[1]"
            :r="j === 0 && drawing.length >= 3 ? handleRadius * 1.6 : handleRadius"
            :fill="j === 0 ? '#facc15' : '#fff'"
            stroke="#a16207"
            :stroke-width="handleRadius * 0.35"
          />
        </g>
      </svg>
    </div>

    <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <template v-if="drawing">
        <span class="text-amber-300">{{ t('zones.drawingHint', { count: drawing.length }) }}</span>
        <button type="button" class="rounded-md bg-amber-500 px-2.5 py-1 font-medium text-slate-950 disabled:opacity-50" :disabled="drawing.length < 3" @click="finishZone">
          {{ t('zones.finish') }}
        </button>
        <button type="button" class="rounded-md px-2.5 py-1 text-slate-300 hover:bg-slate-800" @click="cancelZone">{{ t('zones.cancel') }}</button>
      </template>
      <template v-else>
        <button type="button" class="rounded-md bg-slate-800 px-2.5 py-1 font-medium text-slate-100 hover:bg-slate-700" @click="startZone">
          + {{ t('zones.add') }}
        </button>
        <span class="text-slate-500">{{ zones.length ? t('zones.editHint') : t('zones.none') }}</span>
      </template>
    </div>

    <ul v-if="zones.length" class="mt-2 space-y-1">
      <li
        v-for="(zone, index) in zones"
        :key="index"
        class="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
        :class="selected === index ? 'bg-red-500/10' : ''"
      >
        <span class="h-3 w-3 shrink-0 rounded-sm bg-red-400/70"></span>
        <input
          class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-slate-200 hover:border-slate-700 focus:border-slate-600 focus:outline-none"
          :value="zone.name ?? ''"
          :placeholder="t('zones.defaultName', { n: index + 1 })"
          maxlength="60"
          @focus="selected = index"
          @change="renameZone(index, ($event.target as HTMLInputElement).value)"
        />
        <span class="text-xs text-slate-500">{{ t('zones.points', { count: zone.points.length }) }}</span>
        <button type="button" class="text-xs text-red-400 hover:text-red-300" @click="removeZone(index)">{{ t('zones.remove') }}</button>
      </li>
    </ul>
  </div>
</template>
