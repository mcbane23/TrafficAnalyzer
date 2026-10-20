/**
 * Minimum-cost bipartite assignment (the Hungarian / Kuhn-Munkres
 * algorithm), used by `VehicleTracker` to pair tracks with detections.
 *
 * `cost[row][col]` is the cost of pairing row with column; `Infinity` marks
 * a pairing that is not allowed at all. Returns, for each row, the column it
 * was assigned to, or -1 if it was left unassigned (more rows than columns,
 * or every remaining option was disallowed). The total cost of all allowed
 * pairings is minimized, which - unlike greedily taking the best pair first
 * - can't let one locally attractive pairing force two worse ones.
 *
 * O(n^3) in the larger side; track/detection counts per frame are in the
 * tens, so that's negligible.
 */
export function solveAssignment(cost: number[][]): number[] {
  const rows = cost.length;
  if (rows === 0) return [];
  const cols = cost[0].length;
  const n = Math.max(rows, cols);
  if (cols === 0) return new Array(rows).fill(-1);

  // Disallowed (and padding) cells get a cost larger than any real total, so
  // the solver only uses them when it has no alternative; they're stripped
  // out of the result afterwards.
  let maxFinite = 0;
  for (const row of cost) for (const c of row) if (Number.isFinite(c)) maxFinite = Math.max(maxFinite, Math.abs(c));
  const blocked = (maxFinite + 1) * (n + 1);
  const at = (r: number, c: number) => {
    if (r >= rows || c >= cols) return blocked;
    const v = cost[r][c];
    return Number.isFinite(v) ? v : blocked;
  };

  // Classic O(n^3) potentials formulation, 1-indexed with a virtual column 0.
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const match = new Array<number>(n + 1).fill(0); // match[col] = row
  const way = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    match[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = match[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = at(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[match[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (match[j0] !== 0);
    do {
      const j1 = way[j0];
      match[j0] = match[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const result = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= n; j++) {
    const r = match[j] - 1;
    const c = j - 1;
    if (r < rows && c < cols && Number.isFinite(cost[r][c])) result[r] = c;
  }
  return result;
}
