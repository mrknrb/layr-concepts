// The graph as text for an AI: an indented outline with short ids, each node's summary and edges under it, the edges
// only for one group under that group. A node already written out is referenced, not repeated, so shared subtrees
// stay short. Groups that weren't opened and long texts that were shortened say so, with the id to read them by.
import { firstLine } from "./graph.js";
export const shortId = (id) => id.slice(0, 8);
/** A node's label for menus and titles: its first line, links shown by their labels. */
export function nodeLabel(graph, id) {
  return firstLine(graph.node(id)?.data.text ?? "") || "(empty)";
}
/** A view's root as it shows beside the view's name: its label, at most 30 characters. */
export function viewRootLabel(graph, root) {
  return clip(nodeLabel(graph, root), 30);
}
/**
 * A view's title for tabs and menus: its name, else "(no view name)" with its root's label, so the root's title isn't
 * taken for the view's name.
 */
export function viewTitle(graph, view) {
  const v = graph.views.get(view);
  if (!v) return "Concept";
  return v.data.name ?? `(no view name) · ${viewRootLabel(graph, v.data.root)}`;
}
/** An edge's name: its type, then its label ("causes · sometimes"). */
export function edgeName(graph, e) {
  const type = e.data.relation ? nodeLabel(graph, e.data.relation) : "";
  return [type, e.data.label ?? ""].filter(Boolean).join(" · ");
}
/** The first sentence of a text's first line, at most 200 characters: how a long node shows when not read. */
export function shortText(text) {
  const first = text.trim().split("\n")[0] ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(first)?.[0] ?? first;
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const words = (text) => text.split(/\s+/).filter(Boolean).length;
/** How many words of `text` its short form leaves out (0: nothing). */
export function hiddenWords(text) {
  const all = text.trim();
  const short = shortText(all);
  if (all === short) return 0;
  return Math.max(1, words(all) - words(short.replace(/…$/, "")));
}
/**
 * A node's own lines, unindented: its text with notes (its id, its tags, how much is inside…), its summary, its edges
 * that hold everywhere, and for a group that isn't written out the start of what is inside.
 */
export function nodeLines(graph, id, options) {
  const node = graph.node(id);
  if (!node) return [];
  const text = node.data.text.trim() || "(empty)";
  const [first = "", ...rest] = options.full ? text.split("\n") : [shortText(text)];
  const kids = graph.childCount(id);
  const tags = [`#${shortId(id)}`];
  const labels = graph.tagsOf(id).map((t) => t.name);
  if (labels.length) tags.push(`tags: ${labels.join(", ")}`);
  if (node.data.color) tags.push(`colour: ${node.data.color}`);
  if (node.data.prototype) tags.push("prototype");
  if (node.data.image) tags.push(node.data.caption ? `picture: ${clip(firstLine(node.data.caption), 200)}` : "picture");
  if (kids && node.data.unordered) tags.push("order doesn't matter");
  if (kids) tags.push(options.expanded ? `${kids} inside` : `${kids} inside, not opened`);
  const places = graph.parentCount(id);
  if (places > 1) tags.push(`in ${places} groups`);
  const threads = graph.threadCount(id);
  if (threads) tags.push(threads === 1 ? "1 thread" : `${threads} threads`);
  const hidden = options.full ? 0 : hiddenWords(text);
  if (hidden) tags.push(`+${hidden} words`);
  const lines = [`${first} (${tags.join("; ")})`, ...rest];
  const summary = graph.summary(id);
  if (summary?.data.text.trim()) {
    const head = summary.data.outdated ? "Summary (outdated, read the parts instead):" : "Summary:";
    const [line = "", ...more] = summary.data.text.trim().split("\n");
    lines.push(`${head} ${line}`, ...more.map((l) => `  ${l}`));
  }
  for (const e of graph.relations(id)) {
    const other = e.data.from === id ? e.data.to : e.data.from;
    const name = edgeName(graph, e);
    const arrow = e.data.from === id ? `--${name ? `${name}--` : ""}>` : `<--${name ? `${name}--` : ""}`;
    lines.push(`${arrow} ${nodeLabel(graph, other)} (#${shortId(other)})`);
  }
  if (kids && !options.expanded) {
    const first3 = graph.children(id).slice(0, 3);
    if (first3.length && !summary) {
      const more = kids > first3.length ? " · …" : "";
      const titles = first3.map((g) => clip(shortText(firstLine(graph.node(g.data.to).data.text)), 80) || "(empty)");
      lines.push(`Inside: ${titles.join(" · ")}${more}`);
    }
  }
  return lines;
}
/** The lines below an expanded group's children: what wasn't loaded, and its edges only for it. */
export function groupFooter(graph, id) {
  const lines = [];
  const loaded = graph.children(id).length;
  const more = graph.childCount(id) - loaded;
  if (more > 0) lines.push(`- … ${more} more, read them with concepts__children #${shortId(id)} offset ${loaded}`);
  const edges = graph.edges(id);
  if (edges.length) {
    lines.push("Edges only here:");
    for (const e of edges) {
      const name = edgeName(graph, e);
      lines.push(`  ${nodeLabel(graph, e.data.from)} --${name ? `${name}--` : ""}> ${nodeLabel(graph, e.data.to)}`);
    }
  }
  return lines;
}
export function outline(graph, root, plan = {}) {
  const expanded = plan.expanded ?? ((node) => graph.expanded.has(node));
  const full = plan.full ?? (() => true);
  const lines = [];
  const written = new Set();
  if (plan.path?.length) lines.push(`Path: ${plan.path.map((p) => p.text || "(empty)").join(" › ")}`);
  const write = (id, indent, bullet) => {
    if (!graph.node(id)) return;
    const open = expanded(id) && graph.children(id).length > 0;
    if (written.has(id) && graph.childCount(id)) {
      const text = shortText(graph.node(id).data.text) || "(empty)";
      lines.push(`${indent}${bullet}${text} (#${shortId(id)}, shown above)`);
      return;
    }
    written.add(id);
    const inner = indent + " ".repeat(bullet.length);
    const own = nodeLines(graph, id, { full: id === root || full(id), expanded: open });
    own.forEach((line, i) => lines.push(i === 0 ? `${indent}${bullet}${line}` : `${inner}${line}`));
    if (!open) return;
    for (const g of graph.children(id)) write(g.data.to, inner, "- ");
    for (const line of groupFooter(graph, id)) lines.push(`${inner}${line}`);
  };
  write(root, "", "");
  return lines.join("\n");
}
