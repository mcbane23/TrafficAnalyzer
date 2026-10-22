import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TrafficLevel } from '../../types/analysis';
import type { CameraEntry } from '../../types/camera';
import type { RoadAxis, StatsBucket, StatsRange } from '../../types/stats';
import { formatNumber, t } from '../i18n';

/**
 * Shared look for traffic levels, directions and ranges, so every view uses the same colors and words.
 * Labels are getters over `t`, so they follow the selected language wherever they are rendered.
 */

const range = (value: StatsRange) => ({ value, get label() { return t(`range.${value}`); } });
const bucket = (value: StatsBucket) => ({ value, get label() { return t(`bucket.${value}`); } });

export const RANGES: Array<{ value: StatsRange; label: string }> = [range('1h'), range('24h'), range('7d'), range('30d')];

/** Bucket sizes offered per range, default first - mirrors the server's ALLOWED_BUCKETS. */
export const ALLOWED_BUCKETS_UI: Record<StatsRange, Array<{ value: StatsBucket; label: string }>> = {
  '1h': [bucket('5m'), bucket('15m')],
  '24h': [bucket('1h'), bucket('15m')],
  '7d': [bucket('1h'), bucket('1d')],
  '30d': [bucket('1d')],
};

export const TRAFFIC_LABELS: Record<TrafficLevel, string> = {
  get light() { return t('level.light'); },
  get moderate() { return t('level.moderate'); },
  get heavy() { return t('level.heavy'); },
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

/** Display names for a camera's two directions: the registry's names if set, else "Direction A/B" (translated) with an arrow showing which way it is on screen. */
export function directionLabels(camera: CameraEntry | null | undefined, axis: RoadAxis | null | undefined) {
  const arrowA = axis ? ` ${arrowFor(axis.x, axis.y)}` : '';
  const arrowB = axis ? ` ${arrowFor(-axis.x, -axis.y)}` : '';
  return {
    a: camera?.directions?.a ? `${camera.directions.a}${arrowA}` : `${t('direction.a')}${arrowA}`,
    b: camera?.directions?.b ? `${camera.directions.b}${arrowB}` : `${t('direction.b')}${arrowB}`,
  };
}

export function formatCount(value: number): string {
  return formatNumber(value);
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
