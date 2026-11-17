// Flow layout of one connected component: the Sugiyama method (Sugiyama, Tagawa, Toda 1981). Edges are turned to run
// one way (cycles broken by depth-first search), boxes get layers by network simplex (Gansner, Koutsofios, North, Vo,
// "A technique for drawing directed graphs", 1993), edges longer than one layer get dummy points, the order within
// layers is improved by barycenter sweeps that count crossings (Barth, Jünger, Mutzel, "Bilayer cross counting",
// 2004), and positions across come from Brandes, Köpf, "Fast and simple horizontal coordinate assignment" (2001).
//
// Rewritten from dagre's lib/acyclic.ts, lib/rank/*, lib/normalize.ts, lib/order/* and lib/position/bk.ts
// (https://github.com/dagrejs/dagre):
//   Copyright (c) 2012-2014 Chris Pettitt. MIT licence:
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
//   copyright notice and this permission notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
//   SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//   OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
// Changes: nodes and edges are numbers in arrays instead of a string-keyed graph library; no clusters, edge labels
// or rank directions (the caller swaps width and height for left to right); the edge leaving the spanning tree is the
// first by node index; a cap on network simplex rounds; no dummies for edges across more than `MAX_SPAN` layers.
/**
 * @typedef {object} Dag
 * @property {number} n
 * @property {number[]} ev Edge tails, heads, weights.
 * @property {number[]} ew
 * @property {number[]} weight
 * @property {number[][]} out
 * @property {number[][]} in
 */
function dag(n, edges) {
  const g = { n, ev: [], ew: [], weight: [], out: [], in: [] };
  for (let v = 0; v < n; v++) [g.out[v], g.in[v]] = [[], []];
  const seen = new Map();
  for (const [v, w, weight] of edges) {
    if (v === w) continue;
    const key = v * n + w;
    const old = seen.get(key);
    if (old !== undefined) {
      g.weight[old] = g.weight[old] + weight;
      continue;
    }
    const e = g.ev.length;
    seen.set(key, e);
    g.ev.push(v);
    g.ew.push(w);
    g.weight.push(weight);
    g.out[v].push(e);
    g.in[w].push(e);
  }
  return g;
}
/** Reverse the edges that close cycles (dagre's dfsFAS): back edges of a depth-first search in index order. */
function acyclic(n, edges) {
  const out = Array.from({ length: n }, () => []);
  edges.forEach(([v], e) => out[v].push(e));
  const visited = new Uint8Array(n);
  const onStack = new Uint8Array(n);
  const reversed = new Uint8Array(edges.length);
  for (let s = 0; s < n; s++) {
    if (visited[s]) continue;
    // Iterative depth-first search: [node, next out edge].
    const stack = [[s, 0]];
    visited[s] = onStack[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      if (i >= out[v].length) {
        onStack[v] = 0;
        stack.pop();
        continue;
      }
      top[1] = i + 1;
      const e = out[v][i];
      const w = edges[e][1];
      if (onStack[w]) reversed[e] = 1;
      else if (!visited[w]) {
        visited[w] = onStack[w] = 1;
        stack.push([w, 0]);
      }
    }
  }
  return edges.map(([v, w, weight], e) => (reversed[e] ? [w, v, weight] : [v, w, weight]));
}
// ---------- layers: network simplex ----------
/** Initial ranks, as low as possible: each node one above its lowest successor. */
function longestPath(g, rank) {
  const done = new Uint8Array(g.n);
  for (let s = 0; s < g.n; s++) {
    if (g.in[s].length || done[s]) continue;
    const stack = [[s, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      if (i < g.out[v].length) {
        top[1] = i + 1;
        const w = g.ew[g.out[v][i]];
        if (!done[w]) stack.push([w, 0]);
        continue;
      }
      let r = Infinity;
      for (const e of g.out[v]) r = Math.min(r, rank[g.ew[e]] - 1);
      rank[v] = r === Infinity ? 0 : r;
      done[v] = 1;
      stack.pop();
    }
  }
}
const slack = (g, rank, e) => rank[g.ew[e]] - rank[g.ev[e]] - 1;
/**
 * A spanning tree, by graph edge ids per node.
 * @typedef {object} Tree
 * @property {Uint8Array} inTree
 * @property {{ to: number, edge: number }[][]} adj
 * @property {Int32Array} low
 * @property {Int32Array} lim
 * @property {Int32Array} parent
 * @property {Int32Array} parentEdge The graph edge between a node and its parent.
 * @property {Float64Array} cut Cut value of the tree edge between a node and its parent.
 */
/** A spanning tree of tight edges (slack 0), shifting ranks to make edges tight. Node 0 is its root. */
function feasibleTree(g, rank) {
  const t = {
    inTree: new Uint8Array(g.n),
    adj: Array.from({ length: g.n }, () => []),
    low: new Int32Array(g.n),
    lim: new Int32Array(g.n),
    parent: new Int32Array(g.n).fill(-1),
    parentEdge: new Int32Array(g.n).fill(-1),
    cut: new Float64Array(g.n),
  };
  const members = [0];
  t.inTree[0] = 1;
  const tightTree = () => {
    for (let k = 0; k < members.length; k++) {
      const stack = [members[k]];
      while (stack.length) {
        const v = stack.pop();
        for (const e of [...g.out[v], ...g.in[v]]) {
          const w = g.ev[e] === v ? g.ew[e] : g.ev[e];
          if (t.inTree[w] || slack(g, rank, e)) continue;
          t.inTree[w] = 1;
          members.push(w);
          t.adj[v].push({ to: w, edge: e });
          t.adj[w].push({ to: v, edge: e });
          stack.push(w);
        }
      }
    }
    return members.length;
  };
  while (tightTree() < g.n) {
    let best = -1;
    let bestSlack = Infinity;
    for (let e = 0; e < g.ev.length; e++) {
      if (t.inTree[g.ev[e]] === t.inTree[g.ew[e]]) continue;
      const s = slack(g, rank, e);
      if (s < bestSlack) [best, bestSlack] = [e, s];
    }
    if (best < 0) break;
    const delta = t.inTree[g.ev[best]] ? bestSlack : -bestSlack;
    for (const v of members) rank[v] = rank[v] + delta;
  }
  return t;
}
/** Post-order numbers (`lim`), the lowest below each node (`low`) and parents, from the root 0. */
function lowLim(t) {
  let next = 1;
  t.parent[0] = -1;
  t.parentEdge[0] = -1;
  const visited = new Uint8Array(t.adj.length);
  const stack = [[0, 0, next]];
  visited[0] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const [v, i, low] = top;
    if (i < t.adj[v].length) {
      top[1] = i + 1;
      const { to, edge } = t.adj[v][i];
      if (visited[to]) continue;
      visited[to] = 1;
      t.parent[to] = v;
      t.parentEdge[to] = edge;
      stack.push([to, 0, next]);
      continue;
    }
    t.low[v] = low;
    t.lim[v] = next++;
    stack.pop();
  }
}
/** Nodes children first (by `lim`). */
function postorder(t) {
  const order = new Int32Array(t.adj.length);
  for (let v = 0; v < order.length; v++) order[t.lim[v] - 1] = v;
  return order;
}
/** The cut value of the tree edge between `child` and its parent. */
function cutValue(g, t, child) {
  const parent = t.parent[child];
  const pe = t.parentEdge[child];
  const childIsTail = g.ev[pe] === child;
  let cut = g.weight[pe];
  for (const e of [...g.out[child], ...g.in[child]]) {
    const isOut = g.ev[e] === child;
    const other = isOut ? g.ew[e] : g.ev[e];
    if (other === parent) continue;
    const pointsToHead = isOut === childIsTail;
    const w = g.weight[e];
    cut += pointsToHead ? w : -w;
    if (t.parent[other] === child && t.parentEdge[other] === e) cut += pointsToHead ? -t.cut[other] : t.cut[other];
  }
  return cut;
}
function cutValues(g, t) {
  const order = postorder(t);
  for (let k = 0; k < order.length - 1; k++) t.cut[order[k]] = cutValue(g, t, order[k]);
}
const isDescendant = (t, v, root) => t.low[root] <= t.lim[v] && t.lim[v] <= t.lim[root];
/** Ranks that make the total weighted edge length small, from 0. */
function networkSimplex(g) {
  const rank = new Int32Array(g.n);
  longestPath(g, rank);
  const t = feasibleTree(g, rank);
  lowLim(t);
  cutValues(g, t);
  for (let round = 0; round < 20 * g.n + 100; round++) {
    // Leaving: a tree edge with a negative cut value.
    let leave = -1;
    for (let v = 1; v < g.n && leave < 0; v++) if (t.parent[v] >= 0 && t.cut[v] < 0) leave = v;
    if (leave < 0) break;
    // Entering: the edge with the least slack across the cut.
    const pe = t.parentEdge[leave];
    let tail = g.ev[pe];
    const head = g.ew[pe];
    let flip = false;
    if (t.lim[tail] > t.lim[head]) [tail, flip] = [head, true];
    let enter = -1;
    let enterSlack = Infinity;
    for (let e = 0; e < g.ev.length; e++) {
      if (flip !== isDescendant(t, g.ev[e], tail) || flip === isDescendant(t, g.ew[e], tail)) continue;
      const s = slack(g, rank, e);
      if (s < enterSlack) [enter, enterSlack] = [e, s];
    }
    if (enter < 0) break;
    // Exchange them, then renumber, recompute cut values and ranks from the root.
    const [a, b] = [leave, t.parent[leave]];
    t.adj[a] = t.adj[a].filter((x) => x.to !== b);
    t.adj[b] = t.adj[b].filter((x) => x.to !== a);
    const [u, w] = [g.ev[enter], g.ew[enter]];
    t.adj[u].push({ to: w, edge: enter });
    t.adj[w].push({ to: u, edge: enter });
    lowLim(t);
    cutValues(g, t);
    const order = postorder(t);
    for (let k = order.length - 2; k >= 0; k--) {
      const v = order[k];
      const e = t.parentEdge[v];
      rank[v] = g.ev[e] === v ? rank[t.parent[v]] - 1 : rank[t.parent[v]] + 1;
    }
  }
  let min = Infinity;
  for (let v = 0; v < g.n; v++) min = Math.min(min, rank[v]);
  for (let v = 0; v < g.n; v++) rank[v] = rank[v] - min;
  return rank;
}
// ---------- order within layers ----------
/**
 * The graph with dummy nodes on long edges: every edge joins neighbouring layers.
 * @typedef {object} Layered
 * @property {number} n
 * @property {Uint8Array} dummy
 * @property {Int32Array} rank
 * @property {{ v: number, w: number }[][]} succ
 * @property {{ v: number, w: number }[][]} pred
 */
/**
 * Edges are drawn straight, so dummies only steer the order; an edge across more layers than this gets none (and
 * doesn't steer it), or a long chain with edges back to its start would bring hundreds of thousands of them.
 */
const MAX_SPAN = 6;
function normalize(g, rank) {
  const ranks = [...rank];
  const succ = Array.from({ length: g.n }, () => []);
  const pred = Array.from({ length: g.n }, () => []);
  const link = (a, b, w) => {
    succ[a].push({ v: b, w });
    pred[b].push({ v: a, w });
  };
  for (let e = 0; e < g.ev.length; e++) {
    let v = g.ev[e];
    const to = g.ew[e];
    if (rank[to] - rank[v] > MAX_SPAN) continue;
    for (let r = rank[v] + 1; r < rank[to]; r++) {
      const d = ranks.length;
      ranks.push(r);
      succ.push([]);
      pred.push([]);
      link(v, d, g.weight[e]);
      v = d;
    }
    link(v, to, g.weight[e]);
  }
  const dummy = new Uint8Array(ranks.length);
  dummy.fill(1, g.n);
  return { n: ranks.length, dummy, rank: Int32Array.from(ranks), succ, pred };
}
/** First order: depth-first from the nodes of the first layers, each placed when first reached. */
function initOrder(l) {
  let max = 0;
  for (let v = 0; v < l.n; v++) max = Math.max(max, l.rank[v]);
  const layers = Array.from({ length: max + 1 }, () => []);
  const visited = new Uint8Array(l.n);
  const starts = [...Array(l.n).keys()].sort((a, b) => l.rank[a] - l.rank[b]);
  for (const s of starts) {
    if (visited[s]) continue;
    const stack = [s];
    while (stack.length) {
      const v = stack.pop();
      if (visited[v]) continue;
      visited[v] = 1;
      layers[l.rank[v]].push(v);
      for (let i = l.succ[v].length - 1; i >= 0; i--) stack.push(l.succ[v][i].v);
    }
  }
  return layers;
}
/** Weighted crossings between two neighbouring layers, with an accumulator tree. */
function crossings(l, north, south, pos) {
  const entries = [];
  for (const v of north) {
    entries.push(...l.succ[v].map((s) => ({ pos: pos[s.v], w: s.w })).sort((a, b) => a.pos - b.pos));
  }
  let first = 1;
  while (first < south.length) first <<= 1;
  const tree = new Float64Array(2 * first - 1);
  first -= 1;
  let cc = 0;
  for (const entry of entries) {
    let index = entry.pos + first;
    tree[index] = tree[index] + entry.w;
    let sum = 0;
    while (index > 0) {
      if (index % 2) sum += tree[index + 1];
      index = (index - 1) >> 1;
      tree[index] = tree[index] + entry.w;
    }
    cc += entry.w * sum;
  }
  return cc;
}
function positions(l, layers) {
  const pos = new Int32Array(l.n);
  for (const layer of layers) layer.forEach((v, i) => (pos[v] = i));
  return pos;
}
function crossCount(l, layers) {
  const pos = positions(l, layers);
  let cc = 0;
  for (let r = 1; r < layers.length; r++) cc += crossings(l, layers[r - 1], layers[r], pos);
  return cc;
}
/**
 * Reorder one layer by the barycenters of its neighbours in the layer before; nodes without any keep their place.
 * Ties go by the old place, from the right when `biasRight`. Returns whether a tie was broken.
 */
function sortLayer(layer, nbrs, pos, biasRight) {
  const sortable = [];
  const unsortable = [];
  layer.forEach((v, i) => {
    let [sum, weight] = [0, 0];
    for (const u of nbrs[v]) [sum, weight] = [sum + u.w * pos[u.v], weight + u.w];
    if (weight) sortable.push({ v, i, bc: sum / weight });
    else unsortable.push({ v, i });
  });
  let usedBias = false;
  sortable.sort((a, b) => {
    if (a.bc !== b.bc) return a.bc - b.bc;
    usedBias = true;
    return biasRight ? b.i - a.i : a.i - b.i;
  });
  unsortable.sort((a, b) => b.i - a.i);
  const result = [];
  const consume = () => {
    while (unsortable.length && unsortable[unsortable.length - 1].i <= result.length) result.push(unsortable.pop().v);
  };
  consume();
  for (const entry of sortable) {
    result.push(entry.v);
    consume();
  }
  while (unsortable.length) result.push(unsortable.pop().v);
  return { result, usedBias };
}
/** Sweep down and up, keeping the order with the fewest crossings, until four sweeps bring nothing better. */
function order(l) {
  const layers = initOrder(l);
  let best = layers.map((x) => [...x]);
  let bestCC = Infinity;
  for (let i = 0, lastBest = 0; lastBest < 4; i++, lastBest++) {
    const down = i % 2 === 1;
    const switchBias = i % 4 >= 2;
    let biasRight = true;
    const pos = positions(l, layers);
    const ranks = down
      ? [...Array(Math.max(0, layers.length - 1)).keys()].map((r) => r + 1)
      : [...Array(Math.max(0, layers.length - 1)).keys()].map((r) => layers.length - 2 - r);
    for (const r of ranks) {
      const { result, usedBias } = sortLayer(layers[r], down ? l.pred : l.succ, pos, biasRight);
      layers[r] = result;
      result.forEach((v, k) => (pos[v] = k));
      if (switchBias && usedBias) biasRight = !biasRight;
    }
    const cc = crossCount(l, layers);
    if (cc < bestCC) {
      lastBest = 0;
      bestCC = cc;
      best = layers.map((x) => [...x]);
    } else if (cc === bestCC) best = layers.map((x) => [...x]);
  }
  return best;
}
// ---------- positions across: Brandes–Köpf ----------
/** Inner segments (dummy to dummy) win over other edges they cross: those edges are conflicts. */
function type1Conflicts(l, layers, pos) {
  const conflicts = new Set();
  for (let r = 1; r < layers.length; r++) {
    const prev = layers[r - 1];
    const layer = layers[r];
    let [k0, scanPos] = [0, 0];
    layer.forEach((v, i) => {
      const w = l.dummy[v] ? l.pred[v].find((u) => l.dummy[u.v])?.v : undefined;
      const k1 = w !== undefined ? pos[w] : prev.length;
      if (w === undefined && i !== layer.length - 1) return;
      for (const scan of layer.slice(scanPos, i + 1)) {
        for (const { v: u } of l.pred[scan]) {
          const uPos = pos[u];
          if ((uPos < k0 || k1 < uPos) && !(l.dummy[u] && l.dummy[scan])) conflicts.add(pairKey(l.n, u, scan));
        }
      }
      scanPos = i + 1;
      k0 = k1;
    });
  }
  return conflicts;
}
const pairKey = (n, a, b) => (a < b ? a * n + b : b * n + a);
/** Align each node with a median neighbour in the layer before, unless that crosses an earlier alignment. */
function verticalAlignment(l, layers, conflicts, nbrs) {
  const root = new Int32Array(l.n);
  const align = new Int32Array(l.n);
  const pos = new Int32Array(l.n);
  for (const layer of layers) {
    layer.forEach((v, i) => {
      root[v] = v;
      align[v] = v;
      pos[v] = i;
    });
  }
  for (const layer of layers) {
    let prevIdx = -1;
    for (const v of layer) {
      const ws = nbrs[v].map((u) => u.v).sort((a, b) => pos[a] - pos[b]);
      if (!ws.length) continue;
      const mp = (ws.length - 1) / 2;
      for (let i = Math.floor(mp); i <= Math.ceil(mp); i++) {
        const w = ws[i];
        if (align[v] === v && prevIdx < pos[w] && !conflicts.has(pairKey(l.n, v, w))) {
          align[w] = v;
          align[v] = root[v] = root[w];
          prevIdx = pos[w];
        }
      }
    }
  }
  return { root, align };
}
/** Place blocks (aligned nodes) as far left as their separations allow, then pull them right where there's room. */
function horizontalCompaction(l, layers, root, width, nodeSep, edgeSep) {
  const sep = (v, u) =>
    width[v] / 2 + (l.dummy[v] ? edgeSep : nodeSep) / 2 + (l.dummy[u] ? edgeSep : nodeSep) / 2 + width[u] / 2;
  // The block graph: an edge from a block to the one right of it in some layer, as long as the widest gap.
  const blocks = [];
  const isBlock = new Uint8Array(l.n);
  const out = new Map();
  const inn = new Map();
  for (const layer of layers) {
    let u;
    for (const v of layer) {
      const rv = root[v];
      if (!isBlock[rv]) {
        isBlock[rv] = 1;
        blocks.push(rv);
        out.set(rv, new Map());
        inn.set(rv, new Map());
      }
      if (u !== undefined) {
        const ru = root[u];
        const s = Math.max(sep(v, u), out.get(ru).get(rv) ?? 0);
        out.get(ru).set(rv, s);
        inn.get(rv).set(ru, s);
      }
      u = v;
    }
  }
  const xs = new Float64Array(l.n);
  const iterate = (set, next) => {
    const stack = [...blocks];
    const visited = new Uint8Array(l.n);
    let b = stack.pop();
    while (b !== undefined) {
      if (visited[b]) set(b);
      else {
        visited[b] = 1;
        stack.push(b);
        for (const nb of next(b)) stack.push(nb);
      }
      b = stack.pop();
    }
  };
  iterate(
    (b) => {
      let x = 0;
      for (const [p, s] of inn.get(b)) x = Math.max(x, xs[p] + s);
      xs[b] = x;
    },
    (b) => inn.get(b).keys(),
  );
  iterate(
    (b) => {
      let min = Infinity;
      for (const [s, gap] of out.get(b)) min = Math.min(min, xs[s] - gap);
      if (min !== Infinity) xs[b] = Math.max(xs[b], min);
    },
    (b) => out.get(b).keys(),
  );
  for (let v = 0; v < l.n; v++) xs[v] = xs[root[v]];
  return xs;
}
/** Centres across: the four alignments (up/down × left/right), aligned to the narrowest, balanced. */
function positionX(l, layers, width, nodeSep, edgeSep) {
  const conflicts = type1Conflicts(l, layers, positions(l, layers));
  const all = [];
  const kinds = [];
  for (const vert of ["u", "d"]) {
    let adjusted = vert === "u" ? layers : [...layers].reverse();
    for (const horiz of ["l", "r"]) {
      if (horiz === "r") adjusted = adjusted.map((layer) => [...layer].reverse());
      const { root } = verticalAlignment(l, adjusted, conflicts, vert === "u" ? l.pred : l.succ);
      let xs = horizontalCompaction(l, adjusted, root, width, nodeSep, edgeSep);
      if (horiz === "r") xs = xs.map((x) => -x);
      all.push(xs);
      kinds.push(horiz);
    }
  }
  const extent = (xs) => {
    let [min, max] = [Infinity, -Infinity];
    for (let v = 0; v < l.n; v++) {
      min = Math.min(min, xs[v] - width[v] / 2);
      max = Math.max(max, xs[v] + width[v] / 2);
    }
    return { min, max };
  };
  let narrowest = all[0];
  let narrowestWidth = Infinity;
  for (const xs of all) {
    const { min, max } = extent(xs);
    if (max - min < narrowestWidth) [narrowest, narrowestWidth] = [xs, max - min];
  }
  const values = (xs) => {
    let [min, max] = [Infinity, -Infinity];
    for (const x of xs) [min, max] = [Math.min(min, x), Math.max(max, x)];
    return { min, max };
  };
  const target = values(narrowest);
  all.forEach((xs, k) => {
    if (xs === narrowest) return;
    const { min, max } = values(xs);
    const delta = kinds[k] === "l" ? target.min - min : target.max - max;
    for (let v = 0; v < l.n; v++) xs[v] = xs[v] + delta;
  });
  const result = new Float64Array(l.n);
  for (let v = 0; v < l.n; v++) {
    const four = all.map((xs) => xs[v]).sort((a, b) => a - b);
    result[v] = (four[1] + four[2]) / 2;
  }
  return result;
}
/**
 * Centres for the nodes of a connected component, layers top to bottom. `edges`: [from, to, weight]. Boxes in a
 * layer are centred on its middle; layers are `rankSep` apart, boxes in one at least `nodeSep`.
 */
export function layeredLayout(sizes, edges, nodeSep, rankSep) {
  const n = sizes.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  if (n < 2) return { x, y };
  const g = dag(n, acyclic(n, edges));
  const rank = networkSimplex(g);
  const l = normalize(g, rank);
  const layers = order(l);
  const width = new Float64Array(l.n);
  for (let v = 0; v < n; v++) width[v] = sizes[v].w;
  const xs = positionX(l, layers, width, nodeSep, nodeSep / 2);
  let top = 0;
  for (const layer of layers) {
    let height = 0;
    for (const v of layer) if (v < n) height = Math.max(height, sizes[v].h);
    for (const v of layer) if (v < n) [x[v], y[v]] = [xs[v], top + height / 2];
    top += height + rankSep;
  }
  return { x, y };
}
