// How the AI reads the concept map: wide before deep, within a budget. Titles and summaries of a group's children
// come first; a group is opened only while its children still fit, a level at a time, so the reader stops at a
// level of detail; what budget is left then shows shortened long texts in full. Reads only what it shows, through
// the plugin's functions (`Loader`).
import { Graph } from "./graph.js";
import { groupFooter, hiddenWords, nodeLines, outline, shortId } from "./outline.js";
import { applyBundle } from "./rows.js";
/** Tokens, roughly 4 characters each. */
export const DEFAULT_BUDGET = 2000;
export const MAX_BUDGET = 20000;
const CHARS_PER_TOKEN = 4;
/** Children read per group. */
const PAGE = 100;
/** Groups whose children are read in one round trip. */
const CHUNK = 20;
const size = (lines) => lines.reduce((n, line) => n + line.length + 3, 0);
/** An outline of `root` and as much below it as `budget` (tokens) allows. */
export async function readOutline(load, root, budget = DEFAULT_BUDGET) {
  const graph = new Graph();
  const [where, bundle] = await Promise.all([load.where(root), load.get([root])]);
  applyBundle(graph, bundle);
  if (!graph.node(root)) throw new Error("That node doesn't exist");
  const limit = Math.min(Math.max(budget, 200), MAX_BUDGET) * CHARS_PER_TOKEN;
  const cost = (id, full, open) => size(nodeLines(graph, id, { full, expanded: open }));
  const opened = new Set();
  const seen = new Set([root]);
  /** What each shown node's lines were counted at. */
  const counted = new Map();
  let used = cost(root, true, true) + 80;
  let level = [root];
  while (level.length && used < limit) {
    const groups = level.filter((id) => graph.childCount(id) > 0 && !opened.has(id));
    const next = [];
    for (let i = 0; i < groups.length && used < limit; i += CHUNK) {
      const chunk = groups.slice(i, i + CHUNK);
      const unread = chunk.filter((id) => !graph.expanded.has(id));
      if (unread.length) applyBundle(graph, await load.level(unread, 0, PAGE));
      for (const id of chunk) {
        const kids = graph
          .children(id)
          .map((g) => g.data.to)
          .filter((k) => !seen.has(k));
        const costs = kids.map((k) => cost(k, false, false));
        const extra = costs.reduce((n, c) => n + c, 0) + size(groupFooter(graph, id));
        // The root always shows its children's titles.
        if (id !== root && used + extra > limit) {
          // Not opened, it shows the start of what is inside instead.
          const now = cost(id, false, false);
          used += now - (counted.get(id) ?? now);
          counted.set(id, now);
          continue;
        }
        used += extra;
        opened.add(id);
        kids.forEach((k, j) => {
          seen.add(k);
          counted.set(k, costs[j]);
        });
        next.push(...kids);
      }
    }
    level = next;
  }
  // Shortened texts in full, in reading order, while the budget lasts.
  const full = new Set([root]);
  const visit = (id, done) => {
    if (done.has(id)) return;
    done.add(id);
    const node = graph.node(id);
    if (node && hiddenWords(node.data.text)) {
      const open = opened.has(id);
      const extra = cost(id, true, open) - cost(id, false, open);
      if (used + extra <= limit) {
        full.add(id);
        used += extra;
      }
    }
    if (opened.has(id)) for (const g of graph.children(id)) visit(g.data.to, done);
  };
  visit(root, new Set());
  const text = outline(graph, root, { expanded: (id) => opened.has(id), full: (id) => full.has(id), path: where.path });
  const partial = [...seen].some(
    (id) => (graph.childCount(id) > 0 && !opened.has(id)) || (!full.has(id) && hiddenWords(graph.node(id).data.text)),
  );
  if (!partial) return text;
  return `${text}\n\n(Not opened or shortened: read it by its #id; a bigger budget shows more at once.)`;
}
/** A page of a group's children, one line each with summaries: for groups with more children than a read shows. */
export async function childrenOutline(load, parent, offset = 0, limit = PAGE) {
  const graph = new Graph();
  applyBundle(graph, await load.level([parent], offset, limit));
  if (!graph.node(parent)) throw new Error("That node doesn't exist");
  const total = graph.childCount(parent);
  const kids = graph.children(parent);
  const lines = [`${offset + 1}–${offset + kids.length} of the ${total} children of #${shortId(parent)}:`];
  kids.forEach((g, i) => {
    const own = nodeLines(graph, g.data.to, { full: false, expanded: false });
    own.forEach((line, j) => lines.push(j === 0 ? `${offset + i + 1}. ${line}` : `   ${line}`));
  });
  if (offset + kids.length < total) {
    lines.push(`… ${total - offset - kids.length} more: offset ${offset + kids.length}`);
  }
  return lines.join("\n");
}
