// Reads that help an AI check its work: concepts_check looks through a group for what might be wrong, concepts_follow
// follows edges of a type through several steps (what blocks what) and puts what it reached in the edges' order.
import { edgeLine, findType } from "./edges.js";
import { firstLine, Graph } from "./graph.js";
import { edgeName, nodeLabel, shortId } from "./outline.js";
import { applyBundle } from "./rows.js";
/** Children concepts_check looks at. */
export const CHECK_PAGE = 500;
/** Nodes concepts_follow reaches at most. */
export const FOLLOW_MAX = 200;
/** Cycles shown per type. */
const CYCLES = 5;
const words = (text) => text.split(/\s+/).filter(Boolean).length;
/**
 * concepts_check: what might be wrong in a group. Cycles only for the types in `acyclic` (a cycle of "relates to" is
 * fine); edges both ways, the same edge twice, edges without a type, children with the same title, outdated or missing
 * summaries. It only reports: whether something is wrong is for the AI, or the user, to say.
 */
export async function checkGroup(load, group, types, acyclic = []) {
  const graph = new Graph();
  applyBundle(graph, await load.level([group], 0, CHECK_PAGE));
  if (!graph.node(group)) throw new Error("That node doesn't exist");
  for (const t of types) if (!graph.node(t.id)) graph.setNode({ id: t.id, data: { text: t.text }, created_at: "" });
  const end = (n) => `${nodeLabel(graph, n)} (#${shortId(n)})`;
  const line = (e) =>
    `${edgeLine(graph, e, end)}, ${e.data.in ? `only in ${nodeLabel(graph, e.data.in)}` : "everywhere"}`;
  const kids = graph.children(group).map((g) => g.data.to);
  const kidSet = new Set(kids);
  // The edges on the children that hold here: only in this group, or everywhere.
  const edges = new Map();
  for (const kid of kids) {
    for (const e of [...graph.outgoing(kid, "edge"), ...graph.incoming(kid, "edge")]) {
      if (!e.data.in || e.data.in === group) edges.set(e.id, e);
    }
  }
  const all = [...edges.values()];
  const sections = [];
  const section = (title, list) => {
    if (list.length) sections.push([title, ...list.map((l) => `  ${l}`)]);
  };
  for (const name of acyclic) {
    const type = findType(types, name);
    if (!type) throw new Error(`No edge type "${name}" (there are: ${types.map((t) => t.text).join(", ")})`);
    const among = all.filter((e) => e.data.relation === type.id && kidSet.has(e.data.from) && kidSet.has(e.data.to));
    const cycles = findCycles(among).slice(0, CYCLES);
    section(
      `Cycles of "${type.text}" (it goes one way, so each is a mistake somewhere):`,
      cycles.map((c) => [...c, c[0]].map(end).join(" → ")),
    );
  }
  const key = (e) => `${e.data.from} ${e.data.to} ${e.data.relation ?? ""} ${e.data.in ?? ""}`;
  const byKey = new Map();
  for (const e of all) byKey.set(key(e), [...(byKey.get(key(e)) ?? []), e]);
  section(
    "The same edge more than once (one is enough; the labels may differ):",
    [...byKey.values()].filter((list) => list.length > 1).map((list) => list.map(line).join("; ")),
  );
  const both = all.filter(
    (e) =>
      e.data.from < e.data.to &&
      all.some((x) => x.data.from === e.data.to && x.data.to === e.data.from && x.data.relation === e.data.relation),
  );
  section(
    'Edges both ways with the same type (fine for a type like "mixed with", one too many for one like "blocks"):',
    both.map(line),
  );
  section("Edges without a type (give them one with concepts__connect):", all.filter((e) => !e.data.relation).map(line));
  const titles = new Map();
  for (const kid of kids) {
    const title = firstLine(graph.node(kid).data.text).trim().toLowerCase();
    if (title) titles.set(title, [...(titles.get(title) ?? []), kid]);
  }
  section(
    "Children with the same title (maybe one concept twice; one node can be in several groups):",
    [...titles.values()].filter((list) => list.length > 1).map((list) => list.map(end).join(", ")),
  );
  const outdated = [group, ...kids].filter((n) => graph.summary(n)?.data.outdated);
  section("Outdated summaries (write them again from the children):", outdated.map(end));
  const inside = kids.reduce((n, kid) => n + words(graph.node(kid).data.text), 0);
  if (inside >= 300 && !graph.summary(group)) {
    sections.push([`No summary, with ${inside} words inside: concepts__summary #${shortId(group)}`]);
  }
  const total = graph.childCount(group);
  const head = `Check of ${end(group)}, ${kids.length < total ? `the first ${kids.length} of ` : ""}${total} children:`;
  if (!acyclic.length) sections.push(["(Cycles are checked only for the types given in `acyclic`.)"]);
  if (!sections.some((s) => s.length > 1 || s[0].startsWith("No summary"))) {
    return [head, "Nothing found.", ...sections.flat()].join("\n");
  }
  return [head, ...sections.flat()].join("\n");
}
/** Cycles among `edges`, each as its nodes in order, each found once. */
export function findCycles(edges) {
  const next = new Map();
  for (const e of edges) next.set(e.data.from, [...(next.get(e.data.from) ?? []), e.data.to]);
  const cycles = new Map();
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, "open");
    stack.push(node);
    for (const to of next.get(node) ?? []) {
      if (state.get(to) === "open") {
        const cycle = stack.slice(stack.indexOf(to));
        // The same cycle starting at another node: written from its smallest id.
        const start = cycle.indexOf([...cycle].sort()[0]);
        const turned = [...cycle.slice(start), ...cycle.slice(0, start)];
        cycles.set(turned.join(" "), turned);
      } else if (!state.has(to)) visit(to);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of next.keys()) if (!state.has(node)) visit(node);
  return [...cycles.values()];
}
/**
 * concepts_follow: the nodes reached from `start` along edges (of a type), step by step, as a tree, and then all of
 * them in the edges' order (each node before those its edges point to), or the cycle that leaves no order.
 */
export async function follow(load, start, types, options = {}) {
  const { type, direction = "out" } = options;
  const depth = Math.max(1, Math.min(options.depth ?? 5, 10));
  const graph = new Graph();
  applyBundle(graph, await load.get([start]));
  if (!graph.node(start)) throw new Error("That node doesn't exist");
  for (const t of types) if (!graph.node(t.id)) graph.setNode({ id: t.id, data: { text: t.text }, created_at: "" });
  const end = (n) => `${nodeLabel(graph, n)} (#${shortId(n)})`;
  // Breadth first, so each node shows where it is reached first (fewest steps).
  const steps = new Map();
  const reachedBy = new Map([[start, ""]]);
  const used = new Map();
  let level = [start];
  let stopped = false;
  for (let step = 0; step < depth && level.length && !stopped; step++) {
    const next = [];
    for (const node of level) {
      const out = direction !== "in" ? graph.outgoing(node, "edge") : [];
      const into = direction !== "out" ? graph.incoming(node, "edge") : [];
      const list = [...out, ...into].filter((e) => !type || e.data.relation === type);
      steps.set(node, list);
      for (const e of list) {
        used.set(e.id, e);
        const other = e.data.from === node ? e.data.to : e.data.from;
        if (reachedBy.has(other)) continue;
        if (reachedBy.size >= FOLLOW_MAX) {
          stopped = true;
          break;
        }
        reachedBy.set(other, e.id);
        next.push(other);
      }
    }
    if (next.length && step + 1 < depth) applyBundle(graph, await load.get(next));
    level = next;
  }
  const lines = [];
  const write = (node, indent) => {
    for (const e of steps.get(node) ?? []) {
      const other = e.data.from === node ? e.data.to : e.data.from;
      const name = edgeName(graph, e);
      const arrow = e.data.from === node ? `--${name}-->` : `<--${name}--`;
      const only = e.data.in ? `, only in ${nodeLabel(graph, e.data.in)}` : "";
      const first = reachedBy.get(other) === e.id;
      lines.push(`${indent}- ${arrow} ${end(other)}${only}${first ? "" : " (shown elsewhere)"}`);
      if (first) write(other, `${indent}  `);
    }
  };
  lines.push(end(start));
  write(start, "");
  if (stopped) lines.push(`Stopped at ${FOLLOW_MAX} nodes.`);
  const deeper = [...reachedBy.keys()].filter((n) => !steps.has(n));
  if (deeper.length && !stopped) {
    lines.push(`${deeper.length} reached in the last step may lead further (more \`depth\`)`);
  }
  // The order the edges give: a node before the nodes its edges point to.
  const nodes = [...reachedBy.keys()];
  if (nodes.length > 2) {
    const before = new Map(nodes.map((n) => [n, 0]));
    const counted = [...used.values()].filter((e) => before.has(e.data.from) && before.has(e.data.to));
    for (const e of counted) before.set(e.data.to, before.get(e.data.to) + 1);
    const ready = nodes.filter((n) => !before.get(n));
    const order = [];
    while (ready.length) {
      const n = ready.shift();
      order.push(n);
      for (const e of counted) {
        if (e.data.from !== n) continue;
        const left = before.get(e.data.to) - 1;
        before.set(e.data.to, left);
        if (!left) ready.push(e.data.to);
      }
    }
    if (order.length === nodes.length) {
      lines.push("In the edges' order (each before the nodes its edges point to):");
      lines.push(...order.map((n, i) => `${i + 1}. ${end(n)}`));
    } else {
      lines.push("No order: these edges go in a circle (concepts__check with `acyclic` shows where).");
    }
  }
  return lines.join("\n");
}
