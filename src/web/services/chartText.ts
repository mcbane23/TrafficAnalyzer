/**
 * Text versions of the charts, for screen readers (a chart is a picture to
 * them). Each returns the parts a sentence needs; the views word it.
 */

/** The largest value and where it is; null when there is no value at all. */
export function peakOf(labels: string[], values: Array<number | null>): { label: string; value: number } | null {
  let best: { label: string; value: number } | null = null;
  values.forEach((value, i) => {
    if (value !== null && (best === null || value > best.value)) best = { label: labels[i] ?? '', value };
  });
  return best;
}

/** "A: 120, B: 90, …" for the first `limit` entries, plus how many more there are. */
export function listOf(entries: Array<{ name: string; value: number }>, limit = 5, format: (n: number) => string = String): string {
  const shown = entries.slice(0, limit).map((e) => `${e.name}: ${format(e.value)}`);
  return entries.length > limit ? `${shown.join(', ')}, … (+${entries.length - limit})` : shown.join(', ');
}
