<script setup lang="ts">
import { computed } from 'vue';
import type { CameraHeatmap } from '../../../types/stats';

const props = defineProps<{ heatmap: CameraHeatmap }>();

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const max = computed(() => Math.max(1, ...props.heatmap.cells.map((c) => c.vehiclesPerHour ?? 0)));

const rows = computed(() =>
  DAYS.map((day, weekday) => ({
    day,
    cells: props.heatmap.cells.filter((c) => c.weekday === weekday).sort((a, b) => a.hour - b.hour),
  })),
);

function cellStyle(value: number | null) {
  if (value === null) return { backgroundColor: 'rgba(30, 41, 59, 0.6)' };
  // Sky-400 at an opacity proportional to volume; a floor keeps low-but-real traffic visible against "no data".
  const alpha = 0.12 + 0.88 * (value / max.value);
  return { backgroundColor: `rgba(56, 189, 248, ${alpha.toFixed(2)})` };
}

const hasData = computed(() => props.heatmap.cells.some((c) => c.vehiclesPerHour !== null));
</script>

<template>
  <div>
    <p v-if="!hasData" class="text-xs text-slate-500">No analyzed hours in the last {{ heatmap.days }} days yet.</p>
    <div v-else class="overflow-x-auto">
      <div class="grid min-w-[560px] gap-0.5" style="grid-template-columns: 2.5rem repeat(24, minmax(0, 1fr))">
        <div></div>
        <div v-for="hour in 24" :key="`h${hour}`" class="text-center text-[10px] text-slate-500">
          {{ (hour - 1) % 3 === 0 ? String(hour - 1).padStart(2, '0') : '' }}
        </div>
        <template v-for="row in rows" :key="row.day">
          <div class="pr-1 text-right text-[11px] leading-5 text-slate-400">{{ row.day }}</div>
          <div
            v-for="cell in row.cells"
            :key="`${row.day}-${cell.hour}`"
            class="h-5 rounded-sm"
            :style="cellStyle(cell.vehiclesPerHour)"
            :title="`${row.day} ${String(cell.hour).padStart(2, '0')}:00 - ${cell.vehiclesPerHour === null ? 'not analyzed' : `${cell.vehiclesPerHour} vehicles/hour`}`"
          ></div>
        </template>
      </div>
      <div class="mt-2 flex items-center gap-2 text-[11px] text-slate-500">
        <span>Fewer</span>
        <span class="h-2 w-24 rounded-sm" style="background: linear-gradient(to right, rgba(56,189,248,0.12), rgba(56,189,248,1))"></span>
        <span>More (peak {{ max }}/h)</span>
        <span class="ml-3 h-2 w-3 rounded-sm" style="background-color: rgba(30, 41, 59, 0.6)"></span>
        <span>Not analyzed</span>
      </div>
    </div>
  </div>
</template>
