<script setup lang="ts">
import { computed } from 'vue';
import { Bar } from 'vue-chartjs';
import type { ChartData, ChartOptions } from 'chart.js';
import type { CameraStats } from '../../../types/stats';
import { DIRECTION_COLORS, OCCUPANCY_COLOR } from '../../composables/trafficUi';
import { formatBucketLabel, noDataPlugin } from './chartSetup';

const props = defineProps<{ stats: CameraStats; labels: { a: string; b: string } }>();

/** Below this share of a bucket analyzed, its count understates the road too much to draw - it is shaded as a gap instead. */
const MIN_COVERAGE = 0.5;

const gapIndices = computed(() =>
  props.stats.buckets.flatMap((bucket, i) => (bucket.coverage < MIN_COVERAGE ? [i] : [])),
);

const chartData = computed<ChartData<'bar' | 'line', Array<number | null>, string>>(() => {
  const { buckets, bucket, range, timeZone } = props.stats;
  const value = (pick: (b: (typeof buckets)[number]) => number) =>
    buckets.map((b) => (b.coverage < MIN_COVERAGE ? null : pick(b)));
  return {
    labels: buckets.map((b) => formatBucketLabel(b.start, bucket, range, timeZone)),
    datasets: [
      { type: 'bar', label: props.labels.a, data: value((b) => b.a), backgroundColor: DIRECTION_COLORS.a, stack: 'v', yAxisID: 'y' },
      { type: 'bar', label: props.labels.b, data: value((b) => b.b), backgroundColor: DIRECTION_COLORS.b, stack: 'v', yAxisID: 'y' },
      { type: 'bar', label: 'Direction unclear', data: value((b) => b.unknown), backgroundColor: DIRECTION_COLORS.unknown, stack: 'v', yAxisID: 'y' },
      {
        type: 'line',
        label: 'Road occupancy %',
        data: buckets.map((b) => (b.occupancy === null ? null : Math.round(b.occupancy * 100))),
        borderColor: OCCUPANCY_COLOR,
        backgroundColor: OCCUPANCY_COLOR,
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        spanGaps: false,
        yAxisID: 'y1',
      },
    ],
  };
});

const chartOptions = computed<ChartOptions<'bar'>>(() => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: false,
  interaction: { mode: 'index', intersect: false },
  scales: {
    x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
    y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Vehicles' }, ticks: { precision: 0 } },
    y1: {
      position: 'right',
      min: 0,
      max: 100,
      grid: { display: false },
      title: { display: true, text: 'Occupancy %' },
    },
  },
  plugins: {
    legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } },
    tooltip: {
      callbacks: {
        footer: (items) => {
          const bucket = props.stats.buckets[items[0]?.dataIndex ?? 0];
          if (!bucket) return '';
          if (bucket.coverage < MIN_COVERAGE) return 'Not analyzed in this period';
          return `Total ${bucket.total} · ${bucket.large} large · analyzed ${Math.round(bucket.coverage * 100)}%`;
        },
      },
    },
    noData: { indices: gapIndices.value },
  },
}));
</script>

<template>
  <div class="h-72">
    <Bar :data="chartData as ChartData<'bar'>" :options="chartOptions" :plugins="[noDataPlugin]" />
  </div>
</template>
