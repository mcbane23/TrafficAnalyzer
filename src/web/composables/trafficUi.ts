import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TrafficLevel } from '../../types/analysis';
import type { CameraEntry } from '../../types/camera';
import type { RoadAxis, StatsBucket, StatsRange } from '../../types/stats';

/** Shared look for traffic levels, directions and ranges, so every view uses the same colors and words. */

export const RANGES: Array<{ value: StatsRange; label: string }> = [
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

/** Bucket sizes offered per range, default first - mirrors the server's ALLOWED_BUCKETS. */
export const ALLOWED_BUCKETS_UI: Record<StatsRange, Array<{ value: StatsBucket; label: string }>> = {
  '1h': [
    { value: '5m', label: '5 min' },
    { value: '15m', label: '15 min' },
  ],
  '24h': [
    { value: '1h', label: 'hour' },
    { value: '15m', label: '15 min' },
  ],
  '7d': [
    { value: '1h', label: 'hour' },
    { value: '1d', label: 'day' },
  ],
  '30d': [{ value: '1d', label: 'day' }],
};

export const TRAFFIC_LABELS: Record<TrafficLevel, string> = {
  light: 'Light',
  moderate: 'Moderate',
  heavy: 'Heavy',
};

export const TRAFFIC_BADGE_STYLES: Record<TrafficLevel, string> = {
  light: 'bg-emerald-500/15 text-emerald-400',
  moderate: 'bg-amber-500/15 text-amber-400',
  heavy: 'bg-red-500/15 text-red-400',
};

export const TRAFFIC_BAR_STYLES: Record<TrafficLevel, string> = {
  light: 'bg-emerald-500',
  moderate: 'bg-amber-500',
  heavy: 'bg-red-500',
};

/** Fixed colors for direction A / B / undetermined, used by every chart and counter. */
export const DIRECTION_COLORS = {
  a: '#38bdf8',
  b: '#a78bfa',
  unknown: '#475569',
};

export const OCCUPANCY_COLOR = '#f59e0b';

const ARROWS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

/** Arrow glyph for a direction in image space (y down). */
export function arrowFor(x: number, y: number): string {
  const angle = Math.atan2(y, x);
  const index = Math.round(angle / (Math.PI / 4));
  return ARROWS[(index + 8) % 8];
}

/** Display names for a camera's two directions: the registry's names if set, else "Direction A/B" with an arrow showing which way it is on screen. */
export function directionLabels(camera: CameraEntry | null | undefined, axis: RoadAxis | null | undefined) {
  const arrowA = axis ? ` ${arrowFor(axis.x, axis.y)}` : '';
  const arrowB = axis ? ` ${arrowFor(-axis.x, -axis.y)}` : '';
  return {
    a: camera?.directions?.a ? `${camera.directions.a}${arrowA}` : `Direction A${arrowA}`,
    b: camera?.directions?.b ? `${camera.directions.b}${arrowB}` : `Direction B${arrowB}`,
  };
}

export function formatCount(value: number): string {
  return value.toLocaleString();
}

/** The globally selected time range, kept in the URL (`?range=`) so it survives navigation and reloads. */
export function useStatsRange() {
  const route = useRoute();
  const router = useRouter();
  return computed<StatsRange>({
    get: () => {
      const value = route.query.range;
      return RANGES.some((r) => r.value === value) ? (value as StatsRange) : '24h';
    },
    set: (value) => {
      router.replace({ query: { ...route.query, range: value } });
    },
  });
}
