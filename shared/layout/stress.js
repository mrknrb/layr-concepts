// Organic layout of one connected component: sparse stress (Ortmann, Klimenta, Brandes, "A sparse stress model",
// 2016), started from Pivot MDS (Brandes, Pich, "Eigensolver methods for progressive multidimensional scaling of large
// data", 2006). Written from the papers. Stress makes the distance between two boxes match how far apart they are in
// the graph; the sparse model keeps that for neighbours and approximates the rest through k pivots, so a round costs
// O(n·(k + degree)) instead of O(n²). No randomness: pivots, the start and the update order follow the indexes, and
// only + - * / and square roots are used, which every browser computes exactly alike.
/**
 * A neighbour and how far its centre should be.
 * @typedef {{ j: number, d: number }} Neighbour
 */
const PIVOTS = 50;
const ROUNDS = 80;
/** Breadth-first hops from `source` (-1: unreachable). */
function hops(nbrs, source, into) {
  into.fill(-1);
  into[source] = 0;
  const queue = new Int32Array(nbrs.length);
  let [head, tail] = [0, 0];
  queue[tail++] = source;
  while (head < tail) {
    const v = queue[head++];
    for (const { j } of nbrs[v]) {
      if (into[j] !== -1) continue;
      into[j] = into[v] + 1;
      queue[tail++] = j;
    }
  }
}
/** A small displacement that is always the same for the same index, to break ties (two boxes at one point). */
const jitter = (i) => ((Math.imul(i + 1, 2654435761) >>> 0) / 4294967296 - 0.5) * 0.02;
/** Centres for the `n` nodes of a connected component, `nbrs` symmetric. */
export function stressLayout(nbrs) {
  const n = nbrs.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  if (n < 2) return { x, y };
  let edgeSum = 0;
  let edgeCount = 0;
  for (const list of nbrs) for (const { d } of list) [edgeSum, edgeCount] = [edgeSum + d, edgeCount + 1];
  /** One hop. */
  const unit = edgeCount ? edgeSum / edgeCount : 1;
  // Pivots, max-min: the best connected node first, then each time the node farthest from all chosen ones.
  const k = Math.min(PIVOTS, n);
  const pivots = [];
  const dist = [];
  const nearest = new Float64Array(n).fill(Infinity);
  let next = 0;
  for (let i = 1; i < n; i++) if (nbrs[i].length > nbrs[next].length) next = i;
  for (let p = 0; p < k; p++) {
    const row = new Int32Array(n);
    hops(nbrs, next, row);
    pivots.push(next);
    dist.push(row);
    for (let i = 0; i < n; i++) nearest[i] = Math.min(nearest[i], row[i]);
    next = 0;
    for (let i = 1; i < n; i++) if (nearest[i] > nearest[next]) next = i;
    if (nearest[next] === 0) break;
  }
  const kk = pivots.length;
  pivotMds(dist, unit, x, y);
  // Scale so that edges come out as long as wanted (least squares), then break ties.
  let [num, den] = [0, 0];
  for (let i = 0; i < n; i++) {
    for (const { j, d } of nbrs[i]) {
      const [dx, dy] = [x[i] - x[j], y[i] - y[j]];
      const len = Math.sqrt(dx * dx + dy * dy);
      num += d * len;
      den += len * len;
    }
  }
  const scale = den > 0 ? num / den : 0;
  for (let i = 0; i < n; i++) {
    x[i] = x[i] * scale + jitter(i) * unit;
    y[i] = y[i] * scale + jitter(i + n) * unit;
  }
  // Terms: every neighbour (weight 1/d²), and every pivot that isn't one, standing for its region: the nodes nearer
  // to it than to other pivots, as many of them as are within half the distance (weight s/d²).
  const region = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0;
    for (let p = 1; p < kk; p++) if (dist[p][i] < dist[best][i]) best = p;
    region[i] = best;
  }
  const regionHops = pivots.map(() => []);
  for (let i = 0; i < n; i++) regionHops[region[i]].push(dist[region[i]][i]);
  for (const list of regionHops) list.sort((a, b) => a - b);
  const within = (p, h) => {
    const list = regionHops[p];
    let [lo, hi] = [0, list.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= h) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const start = new Int32Array(n + 1);
  const target = [];
  const want = [];
  const weight = [];
  for (let i = 0; i < n; i++) {
    const near = new Set();
    for (const { j, d } of nbrs[i]) {
      if (j === i || near.has(j)) continue;
      near.add(j);
      target.push(j);
      want.push(d);
      weight.push(1 / (d * d));
    }
    for (let p = 0; p < kk; p++) {
      const v = pivots[p];
      const h = dist[p][i];
      if (v === i || near.has(v) || h <= 0) continue;
      const d = h * unit;
      target.push(v);
      want.push(d);
      weight.push(Math.max(1, within(p, h / 2)) / (d * d));
    }
    start[i + 1] = target.length;
  }
  // Localized stress majorization, node by node in index order.
  for (let round = 0; round < ROUNDS; round++) {
    for (let i = 0; i < n; i++) {
      let [sx, sy, sw] = [0, 0, 0];
      for (let t = start[i]; t < start[i + 1]; t++) {
        const j = target[t];
        let dx = x[i] - x[j];
        let dy = y[i] - y[j];
        let len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-6) {
          [dx, dy] = [jitter(i * 31 + j), jitter(j * 31 + i)];
          len = Math.sqrt(dx * dx + dy * dy);
        }
        const w = weight[t];
        const r = want[t] / len;
        sx += w * (x[j] + r * dx);
        sy += w * (y[j] + r * dy);
        sw += w;
      }
      if (sw > 0) [x[i], y[i]] = [sx / sw, sy / sw];
    }
  }
  return { x, y };
}
/**
 * Classical scaling through pivots: the double-centred squared distances to the pivots (n × k), and the top two
 * eigenvectors of their k × k product by power iteration, give the start.
 */
function pivotMds(dist, unit, x, y) {
  const k = dist.length;
  const n = x.length;
  const c = new Float64Array(n * k);
  const rowMean = new Float64Array(n);
  const colMean = new Float64Array(k);
  let all = 0;
  for (let p = 0; p < k; p++) {
    for (let i = 0; i < n; i++) {
      const d = dist[p][i] * unit;
      const v = d * d;
      c[i * k + p] = v;
      rowMean[i] = rowMean[i] + v / k;
      colMean[p] = colMean[p] + v / n;
      all += v / (n * k);
    }
  }
  for (let i = 0; i < n; i++)
    for (let p = 0; p < k; p++) c[i * k + p] = -0.5 * (c[i * k + p] - rowMean[i] - colMean[p] + all);
  const m = new Float64Array(k * k);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      const a = c[i * k + p];
      if (a === 0) continue;
      for (let q = 0; q < k; q++) m[p * k + q] = m[p * k + q] + a * c[i * k + q];
    }
  }
  const first = powerIteration(m, k);
  const second = powerIteration(m, k, first);
  for (let i = 0; i < n; i++) {
    let [a, b] = [0, 0];
    for (let p = 0; p < k; p++) {
      a += c[i * k + p] * first[p];
      b += c[i * k + p] * second[p];
    }
    [x[i], y[i]] = [a, b];
  }
}
/** The dominant eigenvector of a symmetric k × k matrix, orthogonal to `other` if given. */
function powerIteration(m, k, other) {
  let v = new Float64Array(k);
  for (let p = 0; p < k; p++) v[p] = 1 + jitter(p + (other ? 7 : 0));
  for (let round = 0; round < 100; round++) {
    if (other) {
      let dot = 0;
      for (let p = 0; p < k; p++) dot += v[p] * other[p];
      for (let p = 0; p < k; p++) v[p] = v[p] - dot * other[p];
    }
    const next = new Float64Array(k);
    for (let p = 0; p < k; p++) {
      let sum = 0;
      for (let q = 0; q < k; q++) sum += m[p * k + q] * v[q];
      next[p] = sum;
    }
    let norm = 0;
    for (let p = 0; p < k; p++) norm += next[p] * next[p];
    norm = Math.sqrt(norm);
    if (norm < 1e-12) break;
    for (let p = 0; p < k; p++) next[p] = next[p] / norm;
    v = next;
  }
  return v;
}
