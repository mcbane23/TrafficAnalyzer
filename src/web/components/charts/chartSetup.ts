import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
  type Plugin,
} from 'chart.js';

// Only the pieces the charts here use, so the bundle doesn't carry all of Chart.js.
Chart.register(BarController, BarElement, CategoryScale, Filler, Legend, LineController, LineElement, LinearScale, PointElement, Tooltip);

Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(51, 65, 85, 0.5)';
Chart.defaults.font.family = 'ui-sans-serif, system-ui, sans-serif';
Chart.defaults.font.size = 11;

/**
 * Shades the x-axis slots whose index is in `options.plugins.noData.indices`,
 * so a period the camera wasn't analyzed reads as missing data rather than
 * as an empty road.
 */
export const noDataPlugin: Plugin<'bar'> = {
  id: 'noData',
  beforeDatasetsDraw(chart, _args, options: { indices?: number[] }) {
    const indices = options.indices ?? [];
    if (indices.length === 0) return;
    const x = chart.scales.x;
    const { top, bottom } = chart.chartArea;
    const slot = (x.width / Math.max(1, x.ticks.length)) * 0.9;
    const ctx = chart.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(51, 65, 85, 0.25)';
    for (const i of indices) {
      const centre = x.getPixelForValue(i);
      ctx.fillRect(centre - slot / 2, top, slot, bottom - top);
    }
    ctx.restore();
  },
};

export function formatBucketLabel(iso: string, bucket: string, range: string, timeZone: string): string {
  const date = new Date(iso);
  if (bucket === '1d') {
    return date.toLocaleDateString(undefined, { timeZone, weekday: 'short', day: 'numeric', month: 'short' });
  }
  const time = date.toLocaleTimeString(undefined, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  if (range === '7d') {
    return `${date.toLocaleDateString(undefined, { timeZone, weekday: 'short' })} ${time}`;
  }
  return time;
}
