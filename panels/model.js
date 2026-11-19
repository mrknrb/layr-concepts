// What the panel decides without a page, as plain functions (tested in test/model.test.js): selections, edges as the
// rows show them, where dragged rows may go, the free layouts' choices and geometry, prototype zoom steps, the Status
// set. Ported from layr_code's panels/view.tsx.
import { nodeLabel, edgeName } from "../shared/outline.js";

/** How a node's children are laid out in a view (`looks.layout`; null is vertical). */
export const LAYOUT_INFO = {
  vertical: { label: "Vertical", icon: "vertical", mark: "↓", description: "An outline, one below the other" },
  horizontal: { label: "Horizontal", icon: "horizontal", mark: "→", description: "Side by side" },
  free: { label: "Free", icon: "free", mark: "✥", description: "Where you put them, on a canvas, with edges drawn" },
};

/** The automatic arrangements of a free layout (shared/layout), as the menus name them. */
export const ARRANGE_INFO = {
  tidy: { label: "Tidy", description: "Where you put them, pushed apart where they overlap" },
  organic: { label: "Organic", description: "Linked ones close together", ordered: true },
  "flow-down": { label: "Flow ↓", description: "In layers along the edges, top to bottom", ordered: true },
  "flow-right": { label: "Flow →", description: "In layers along the edges, left to right", ordered: true },
  rows: { label: "Rows", description: "Left to right like text, linked ones next to each other", ordered: true },
  grid: { label: "Grid", description: "In columns and rows", ordered: true },
  pack: { label: "Pack", description: "As tight as possible, the tallest first" },
  columns: { label: "Columns", description: "Side by side in their order, tops aligned; edges don't count" },
};

/** The set "Add a Status set" makes: where a feature stands. */
export const STATUS = [
  { name: "Idea", color: null, description: "Thought of, not decided" },
  { name: "Planned", color: "blue", description: "Decided, not started" },
  { name: "In progress", color: "orange", description: "Being built" },
  { name: "Done", color: "green", description: "Built and in use" },
  { name: "Dropped", color: "red", description: "Decided against" },
];

/** The zoom levels a prototype's page steps through, percent, as in a browser. */
export const PROTOTYPE_ZOOMS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300];

/** The next zoom level from `zoom` (which may be between levels) in a direction; `zoom` itself at the end. */
export function nextZoom(zoom, direction) {
  const levels = direction > 0 ? PROTOTYPE_ZOOMS : [...PROTOTYPE_ZOOMS].reverse();
  return levels.find((level) => (level - zoom) * direction > 0) ?? zoom;
}

// ---------------------------------------------------------------- selection

/**
 * A click with Ctrl (toggle) or Shift (a range from `anchor`) on the row `conn`, among the rows shown (`rows`, top to
 * bottom). Gives the new selection and anchor.
 */
export function clickSelect(selection, rows, anchor, conn, range) {
  if (range && anchor) {
    const [a, b] = [rows.indexOf(anchor), rows.indexOf(conn)];
    if (a >= 0 && b >= 0) return { selection: rows.slice(Math.min(a, b), Math.max(a, b) + 1), anchor };
  }
  const next = selection.includes(conn) ? selection.filter((c) => c !== conn) : [...selection, conn];
  return { selection: next, anchor: conn };
}

/** Shift+↑↓ from the cursor `from`: the rows from the anchor to the next row up or down. */
export function extendSelection(rows, anchor, from, by) {
  const to = rows[rows.indexOf(from) + by];
  if (!to) return null;
  const start = rows.includes(anchor) ? anchor : from;
  const [a, b] = [rows.indexOf(start), rows.indexOf(to)];
  return { selection: rows.slice(Math.min(a, b), Math.max(a, b) + 1), cursor: to, anchor: start };
}

// ---------------------------------------------------------------- edges

export const otherEnd = (e, node) => (e.data.from === node ? e.data.to : e.data.from);

/** Edges of `node` that hold where it is shown: everywhere, or only in `parent`. */
export const edgesHere = (graph, node, parent) => graph.edgesOf(node).filter((e) => !e.data.in || e.data.in === parent);

/** "is a" edges without a label, from `node`, holding everywhere: a `[Type]` badge next to it instead of a chip. */
export const isTypeBadge = (graph, e, node) =>
  e.data.from === node &&
  !e.data.label &&
  !e.data.in &&
  !!e.data.relation &&
  nodeLabel(graph, e.data.relation).toLowerCase() === "is a";

/** An edge seen from `node`, arrows pointing at the target: "is a → Grain", or "Bread made from →". */
export function edgeText(graph, e, node) {
  const name = edgeName(graph, e);
  const text = name ? `${name} ` : "";
  return e.data.from === node ? `${text}→ ${nodeLabel(graph, e.data.to)}` : `${nodeLabel(graph, e.data.from)} ${text}→`;
}

/** Edge types for a picker: the one used last first. */
export const sortTypes = (types, last) => [
  ...types.filter((t) => t.id === last),
  ...types.filter((t) => t.id !== last),
];

// ---------------------------------------------------------------- dragging

/**
 * Whether the rows `conns` (group conns) can be dropped on `t` (`{kind: "gap", parent, index}`, `{kind: "into", node}`
 * or `{kind: "free", parent}`): not into themselves or what is inside them, not into the group they are all in.
 */
export function acceptMove(graph, conns, t) {
  const dest = t.kind === "into" ? t.node : t.parent;
  const nodes = conns.map((c) => graph.group(c)?.data.to).filter(Boolean);
  if (!dest || !nodes.length || nodes.some((n) => n === dest || graph.contains(n, dest))) return false;
  if (t.kind === "into" && conns.every((c) => graph.group(c)?.data.from === dest)) return false;
  return true;
}

// ---------------------------------------------------------------- tags

/** Filtering by tags (`only`, tag ids), the node has none of them: it shows dimmed. */
export const dimmed = (graph, node, only) => only.length > 0 && !only.some((tag) => graph.nodeTag(node, tag));

/**
 * Move one of `list` (tags or sets, in order, each with a `pos`) one place up (-1) or down (+1): the new places of
 * those that change, as `[id, pos]`.
 */
export function shiftOrder(list, id, by) {
  const from = list.findIndex((x) => x.id === id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= list.length) return [];
  const order = [...list];
  order.splice(to, 0, ...order.splice(from, 1));
  return order.flatMap((x, i) => (x.pos === i + 1 ? [] : [[x.id, i + 1]]));
}

// ---------------------------------------------------------------- free layouts

/** Boxes measure to whole multiples of this, so a pixel of difference between devices rarely changes a layout. */
export const SIZE_STEP = 8;
export const step = (v) => Math.ceil(v / SIZE_STEP) * SIZE_STEP;

/** A free layout's scroll area until its size is set by hand, and the smallest it can be made. */
export const AREA = { w: 560, h: 360 };
export const AREA_MIN = { w: 160, h: 80 };
/** Widths a child in a free layout can be given. */
export const WIDTH = { min: 80, max: 1600 };
/** How tall a prototype's page can be made by dragging its bottom edge, and as tall as its page at most. */
export const PROTO_HEIGHT = { min: 60, max: 3000, fit: 560, least: 120 };

/** Where a child sits before it was put anywhere: three columns, in its group's order. */
export const firstPlace = (i) => ({ x: 16 + (i % 3) * 230, y: 16 + Math.floor(i / 3) * 120 });

/** A line between two boxes, from border to border, aimed at their centres. */
export function segment(a, b) {
  return { a: border(a, b), b: border(b, a) };
}

function border(from, to) {
  const [ax, ay] = [from.x + from.w / 2, from.y + from.h / 2];
  const [dx, dy] = [to.x + to.w / 2 - ax, to.y + to.h / 2 - ay];
  if (!dx && !dy) return { x: ax, y: ay };
  const scale = Math.min(dx ? from.w / 2 / Math.abs(dx) : Infinity, dy ? from.h / 2 / Math.abs(dy) : Infinity);
  return { x: ax + dx * scale, y: ay + dy * scale };
}

/** How big a free layout is drawn: around every box, at least 320 × 160. */
export function areaSize(boxes) {
  return {
    w: Math.max(320, ...boxes.map((b) => b.x + b.w + 16)),
    h: Math.max(160, ...boxes.map((b) => b.y + b.h + 16)),
  };
}

/**
 * Zoom to `next` (clamped), keeping the point `cx`, `cy` of the canvas where it is: the new pan and zoom.
 */
export function zoomAt({ x, y, zoom }, next, cx, cy) {
  const z = Math.min(2, Math.max(0.05, next));
  return { x: cx - ((cx - x) * z) / zoom, y: cy - ((cy - y) * z) / zoom, zoom: z };
}

/** Pan and zoom that show all of a `w` × `h` layout in a `vw` × `vh` canvas, centred, never bigger than 100%. */
export function fitAll(w, h, vw, vh) {
  const zoom = Math.min(1, vw / Math.max(1, w), vh / Math.max(1, h));
  return { zoom, x: Math.max(0, (vw - w * zoom) / 2), y: Math.max(0, (vh - h * zoom) / 2) };
}
