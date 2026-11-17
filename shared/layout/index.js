// Automatic free layouts (docs/concepts/LAYOUTS.md): from the children's boxes, the edges between them and whether
// their order counts, top lefts for every box. Deterministic: no randomness, no time limits, rounded results.
import { layeredLayout } from "./layered.js";
import { columns, grid, pack, rows } from "./pack.js";
import { stressLayout } from "./stress.js";
import { removeOverlaps } from "./vpsc.js";
export * from "./types.js";
/** Space left around the layout. */
export const MARGIN = 16;
export function arrange(input) {
  const gap = input.gap ?? 24;
  const { boxes } = input;
  const n = boxes.length;
  if (!n) return [];
  const edges = input.edges.filter(([a, b]) => a !== b && a >= 0 && b >= 0 && a < n && b < n);
  let out;
  switch (input.arrange) {
    case "tidy":
      out = removeOverlaps(boxes, gap);
      break;
    case "rows":
      out = rows(boxes, input.useOrder ? [...boxes.keys()] : connectedOrder(n, edges), gap);
      break;
    case "grid":
      out = grid(boxes, input.useOrder ? [...boxes.keys()] : connectedOrder(n, edges), gap);
      break;
    case "pack":
      out = pack(boxes, gap);
      break;
    case "columns":
      out = columns(boxes, gap);
      break;
    case "organic":
    case "flow-down":
    case "flow-right":
      out = byComponent(input.arrange, boxes, input.useOrder ? [...edges, ...chain(n)] : edges, gap);
      break;
  }
  return place(out, input.arrange === "tidy");
}
/** Consecutive children, as edges. */
const chain = (n) => [...Array(Math.max(0, n - 1)).keys()].map((i) => [i, i + 1]);
/** Children breadth first along edges (either way), each component from its first child: linked ones end up close. */
function connectedOrder(n, edges) {
  const nbrs = undirected(n, edges);
  const seen = new Uint8Array(n);
  const order = [];
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    for (let head = order.push(s) - 1; head < order.length; head++) {
      for (const j of nbrs[order[head]]) {
        if (seen[j]) continue;
        seen[j] = 1;
        order.push(j);
      }
    }
  }
  return order;
}
/** Each node's neighbours either way, sorted, no repeats. */
function undirected(n, edges) {
  const sets = Array.from({ length: n }, () => new Set());
  for (const [a, b] of edges) {
    sets[a].add(b);
    sets[b].add(a);
  }
  return sets.map((s) => [...s].sort((a, b) => a - b));
}
/** Lay out each connected component on its own, then pack the components (single boxes too) together. */
function byComponent(kind, boxes, edges, gap) {
  const n = boxes.length;
  const nbrs = undirected(n, edges);
  const component = new Int32Array(n).fill(-1);
  const members = [];
  for (let s = 0; s < n; s++) {
    if (component[s] >= 0) continue;
    const list = [s];
    component[s] = members.length;
    for (let head = 0; head < list.length; head++) {
      for (const j of nbrs[list[head]]) {
        if (component[j] >= 0) continue;
        component[j] = members.length;
        list.push(j);
      }
    }
    members.push(list.sort((a, b) => a - b));
  }
  const local = new Int32Array(n);
  for (const list of members) list.forEach((v, i) => (local[v] = i));
  const inside = members.map(() => []);
  for (const [a, b] of edges) inside[component[a]].push([local[a], local[b]]);
  const placed = boxes.map(() => ({ x: 0, y: 0 }));
  const extents = [];
  members.forEach((list, c) => {
    const sizes = list.map((v) => boxes[v]);
    let tops;
    if (list.length === 1) tops = [{ x: 0, y: 0 }];
    else if (kind === "organic") tops = organic(sizes, list, local, nbrs, gap);
    else tops = flow(sizes, inside[c], gap, kind === "flow-right");
    let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
    tops.forEach((p, i) => {
      [minX, minY] = [Math.min(minX, p.x), Math.min(minY, p.y)];
      [maxX, maxY] = [Math.max(maxX, p.x + sizes[i].w), Math.max(maxY, p.y + sizes[i].h)];
    });
    list.forEach((v, i) => (placed[v] = { x: tops[i].x - minX, y: tops[i].y - minY }));
    extents.push({ w: maxX - minX, h: maxY - minY });
  });
  if (members.length === 1) return placed;
  const at = pack(extents, gap * 2);
  return placed.map((p, v) => ({ x: p.x + at[component[v]].x, y: p.y + at[component[v]].y }));
}
function organic(sizes, list, local, nbrs, gap) {
  const radius = (b) => (b.w + b.h) / 4;
  const graph = list.map((v) =>
    nbrs[v].map((u) => ({ j: local[u], d: radius(sizes[local[v]]) + radius(sizes[local[u]]) + gap })),
  );
  const { x, y } = stressLayout(graph);
  const rects = sizes.map((b, i) => ({ w: b.w, h: b.h, x: x[i] - b.w / 2, y: y[i] - b.h / 2 }));
  return removeOverlaps(rects, gap);
}
function flow(sizes, edges, gap, across) {
  const turned = sizes.map((b) => (across ? { w: b.h, h: b.w } : { w: b.w, h: b.h }));
  const { x, y } = layeredLayout(
    turned,
    edges.map(([a, b]) => [a, b, 1]),
    gap,
    gap * 2,
  );
  return sizes.map((b, i) =>
    across ? { x: y[i] - b.w / 2, y: x[i] - b.h / 2 } : { x: x[i] - b.w / 2, y: y[i] - b.h / 2 },
  );
}
/** Whole pixels, the whole layout `MARGIN` from the top left; `stay`: only moved there if it went past it. */
function place(out, stay) {
  let [minX, minY] = [Infinity, Infinity];
  for (const p of out) [minX, minY] = [Math.min(minX, p.x), Math.min(minY, p.y)];
  const dx = stay ? Math.max(0, MARGIN - minX) : MARGIN - minX;
  const dy = stay ? Math.max(0, MARGIN - minY) : MARGIN - minY;
  return out.map((p) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) }));
}
