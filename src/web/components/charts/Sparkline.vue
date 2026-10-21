<script setup lang="ts">
import { computed } from 'vue';

/**
 * Tiny inline trend line. `null` values (periods with no analysis) break the line rather than dropping it to zero.
 * `max` fixes the top of the scale (e.g. 100 for a percentage); by default it is the largest value.
 */
const props = withDefaults(defineProps<{ values: Array<number | null>; color?: string; height?: number; max?: number }>(), {
  color: '#38bdf8',
  height: 28,
});

const WIDTH = 100;

const segments = computed(() => {
  const max = props.max ?? Math.max(1, ...props.values.map((v) => v ?? 0));
  const step = props.values.length > 1 ? WIDTH / (props.values.length - 1) : WIDTH;
  const result: string[] = [];
  let current: string[] = [];
  props.values.forEach((value, i) => {
    if (value === null) {
      if (current.length) result.push(current.join(' '));
      current = [];
      return;
    }
    const y = props.height - 2 - (value / max) * (props.height - 4);
    current.push(`${(i * step).toFixed(1)},${y.toFixed(1)}`);
  });
  if (current.length) result.push(current.join(' '));
  return result;
});
</script>

<template>
  <svg :viewBox="`0 0 ${WIDTH} ${height}`" preserveAspectRatio="none" class="w-full" :style="{ height: `${height}px` }" aria-hidden="true">
    <polyline
      v-for="(points, i) in segments"
      :key="i"
      :points="points"
      fill="none"
      :stroke="color"
      stroke-width="1.5"
      stroke-linejoin="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>
