// Edges for the AI: concepts_connect adds, relabels, moves, retypes and removes many in one call, saying for each what
// it did, and concepts_edges lists a group's edges by where they hold, so an AI can check its work.
import { Graph } from "./graph.js";
import { edgeName, nodeLabel, shortId } from "./outline.js";
import { applyBundle, TABLES } from "./rows.js";
/** More changes than this in one call is a big change: a proposal for the user. */
export const MANY = 10;
/** Edges in one concepts_connect call at most. */
export const MAX_EDGES = 100;
/** Edges retyped in one call at most. */
export const MAX_RETYPE = 500;
/** Children whose edges concepts_edges lists at a time. */
export const EDGE_PAGE = 100;
const asError = (error) => (error instanceof Error ? error : new Error(String(error)));
const everywhere = (place) => place.trim().toLowerCase() === "everywhere";
/** An edge type by name or id (a prefix of 4 or more). */
export function findType(types, nameOrId) {
  const key = nameOrId.trim().replace(/^#/, "").toLowerCase();
  return types.find((t) => t.text.toLowerCase() === key) ?? types.find((t) => key.length >= 4 && t.id.startsWith(key));
}
const noType = (types, nameOrId) => {
  const list = types.map((t) => t.text).join(", ") || "none yet";
  return new Error(`No edge type "${nameOrId}" (there are: ${list}). Pass newType: true to make it.`);
};
/** Make sure the type nodes are in `graph`, so lines can name them. */
function nameTypes(graph, types) {
  for (const t of types) if (!graph.node(t.id)) graph.setNode({ id: t.id, data: { text: t.text }, created_at: "" });
}
/** The edges the AI gave: `edges` with what is given beside it, or one `from` → `to`. */
function edgeSpecs(args) {
  const { edges, newType, remove, preview, retype, ...shared } = args;
  if (edges?.length && (shared.from || shared.to)) throw new Error("Give `from` and `to`, or `edges`, not both");
  const specs = edges?.length
    ? edges.map((e) => ({ type: shared.type, label: shared.label, in: shared.in, newIn: shared.newIn, ...e }))
    : shared.from && shared.to
      ? [{ ...shared, from: shared.from, to: shared.to }]
      : [];
  if (specs.length > MAX_EDGES) throw new Error(`At most ${MAX_EDGES} edges at once`);
  return specs;
}
/** Resolve every node the specs name at once; a name that fails fails only the edges using it. */
async function resolveAll(source, names) {
  const ids = new Map();
  await Promise.all([...new Set(names)].map(async (n) => ids.set(n, await source.resolve(n).catch(asError))));
  return ids;
}
/**
 * concepts_connect: add, relabel, move or remove edges, many in one call, or retype them. The ids are resolved and the
 * nodes read once, then each edge is done on its own, so one that fails doesn't stop the others. A line per edge says
 * what was done.
 */
export async function connect(source, args) {
  if (args.retype !== undefined) return retype(source, args);
  const { newType, remove, preview } = args;
  const specs = edgeSpecs(args);
  if (!specs.length) throw new Error("Give `from` and `to`, or `edges`");
  const places = (e) => [e.in, e.newIn && !everywhere(e.newIn) ? e.newIn : undefined];
  const named = specs.flatMap((e) => [e.from, e.to, ...places(e).filter((p) => !!p)]);
  const ids = await resolveAll(source, named);
  const found = [...new Set([...ids.values()].filter((v) => typeof v === "string"))];
  const { graph, ops } = await source.slice(found);
  const id = (name) => {
    const value = ids.get(name);
    if (value instanceof Error) throw value;
    if (!graph.node(value)) throw new Error(`No node "${name}"`);
    return value;
  };
  // Edge types by name or id, read once; a new one is made once (none in a preview: null).
  let types;
  const typeOf = async (nameOrId) => {
    types ??= await source.types();
    const known = findType(types, nameOrId);
    if (known) {
      nameTypes(graph, [known]);
      return known.id;
    }
    if (newType && !remove) {
      if (preview) return null;
      const made = await ops.addEdgeType(nameOrId.trim());
      types.push({ id: made, text: nameOrId.trim(), meaning: null });
      return made;
    }
    throw noType(types, nameOrId);
  };
  const end = (n) => `${nodeLabel(graph, n)} (#${shortId(n)})`;
  const where = (only) => (only ? `only in ${nodeLabel(graph, only)}` : "everywhere");
  const show = (e) => `${edgeLine(graph, e, end)}, ${where(e.data.in)}`;
  const inGroup = (group, nodes) => {
    for (const n of nodes) {
      if (graph.membership(group, n)) continue;
      throw new Error(`${end(n)} is not in ${end(group)}, so the edge can't hold only there`);
    }
  };
  const one = async (spec) => {
    const [a, b] = [id(spec.from), id(spec.to)];
    const group = spec.in ? id(spec.in) : undefined;
    const relation = spec.type ? await typeOf(spec.type) : undefined;
    const between = graph.outgoing(a, "edge").filter((e) => e.data.to === b);
    const matching = between.filter(
      (e) => (!spec.type || e.data.relation === relation) && (!group || e.data.in === group),
    );
    const whatIsThere = () => {
      const back = graph.outgoing(b, "edge").filter((e) => e.data.to === a);
      return between.length
        ? `from ${end(a)} to ${end(b)} there is: ${between.map(show).join("; ")}`
        : back.length
          ? `there is none from ${end(a)} to ${end(b)}, only the other way: ${back.map(show).join("; ")}`
          : `there is no edge between ${end(a)} and ${end(b)}`;
    };
    if (remove) {
      if (!matching.length) return `removed nothing, none matched: ${whatIsThere()}`;
      if (!preview) for (const e of matching) await ops.deleteEdge(e.id);
      return `${preview ? "would remove" : "removed"} ${matching.map(show).join("; ")}`;
    }
    if (spec.newIn !== undefined) {
      if (!matching.length) throw new Error(`No edge like that to move: ${whatIsThere()}`);
      if (matching.length > 1) {
        throw new Error(`${matching.length} edges match (${matching.map(show).join("; ")}): give \`type\` or \`in\``);
      }
      const e = matching[0];
      const target = everywhere(spec.newIn) ? undefined : id(spec.newIn);
      if (e.data.in === target) return `already holds ${where(target)}: ${show(e)}`;
      if (target) inGroup(target, [a, b]);
      const clash = between.find((x) => x.id !== e.id && x.data.relation === e.data.relation && x.data.in === target);
      if (clash) {
        throw new Error(`One of this type already holds ${where(target)}: ${show(clash)}. Remove one of them.`);
      }
      if (preview) return `would make ${show(e)} hold ${where(target)}`;
      const label = spec.label !== undefined ? { label: spec.label.trim() || null } : {};
      await ops.updateEdge(e.id, { in: target ?? null, ...label });
      return `moved: ${show(graph.edge(e.id))}`;
    }
    if (!spec.type) throw new Error("Give the edge's `type` (concepts__types lists them; `newType: true` makes one)");
    if (a === b) throw new Error("An edge needs two different nodes");
    if (group) inGroup(group, [a, b]);
    const text = spec.label?.trim() || undefined;
    const name = (type) => [type, text].filter(Boolean).join(" · ");
    if (relation === null) {
      const type = spec.type.trim();
      return `would make the type "${type}" and add ${end(a)} --${name(type)}--> ${end(b)}, ${where(group)}`;
    }
    const same = between.find((e) => e.data.relation === relation && e.data.in === group);
    if (same) {
      if (same.data.label === text) return `already there: ${show(same)}`;
      if (preview) return `would change the label of ${show(same)} to ${text ? `"${text}"` : "none"}`;
      await ops.updateEdge(same.id, { label: text ?? null });
      return `changed the label: ${show(graph.edge(same.id))}`;
    }
    const elsewhere = between.filter((e) => e.data.relation === relation);
    const note = elsewhere.length
      ? ` (one of this type also holds ${elsewhere.map((e) => where(e.data.in)).join(", ")}: move it with \`newIn\` ` +
        "or remove it, if this one replaces it)"
      : "";
    if (preview) {
      return `would add ${end(a)} --${name(nodeLabel(graph, relation))}--> ${end(b)}, ${where(group)}${note}`;
    }
    const edge = await ops.addEdge(a, b, { relation, label: text, in: group });
    return `added ${show(graph.edge(edge))}${note}`;
  };
  if (specs.length === 1) return one(specs[0]);
  const lines = [];
  let failed = 0;
  for (const spec of specs) {
    try {
      lines.push(await one(spec));
    } catch (error) {
      failed++;
      lines.push(`failed (${spec.from} → ${spec.to}): ${asError(error).message}`);
    }
  }
  const head = `${specs.length} edges${failed ? `, ${failed} failed` : ""}${preview ? " (preview: none done)" : ""}:`;
  return [head, ...lines.map((line, i) => `${i + 1}. ${line}`)].join("\n");
}
/**
 * Give the edges of `type` the type `retype`: every one, those between the children of `in`, or those between the
 * pairs given. More than a few become a proposal.
 */
async function retype(source, args) {
  if (!args.type || !args.retype?.trim()) {
    throw new Error("Give `type`, the type the edges have, and `retype`, the new one");
  }
  if (args.newIn !== undefined || args.remove) {
    throw new Error("`retype` changes only the type: no `newIn` or `remove`");
  }
  const types = await source.types();
  const from = findType(types, args.type);
  if (!from) throw noType(types, args.type);
  const to = findType(types, args.retype);
  if (!to && !args.newType) throw noType(types, args.retype);
  if (to?.id === from.id) throw new Error("That is the type they have");
  let rows = await source.select(TABLES.edges, { type: from.id });
  const group = args.in ? await source.resolve(args.in) : undefined;
  if (group) {
    const kids = new Set((await source.select(TABLES.groups, { parent: group })).map((g) => g.child));
    rows = rows.filter((r) => kids.has(r.from_node) && kids.has(r.to_node) && (!r.in_group || r.in_group === group));
  }
  const specs = edgeSpecs({ ...args, type: undefined, in: undefined, retype: undefined });
  if (specs.length) {
    const ids = await resolveAll(
      source,
      specs.flatMap((e) => [e.from, e.to]),
    );
    const pairs = new Set(specs.map((e) => `${ids.get(e.from)} ${ids.get(e.to)}`));
    rows = rows.filter((r) => pairs.has(`${r.from_node} ${r.to_node}`));
  }
  const toName = to?.text ?? args.retype.trim();
  if (!rows.length) return `No edges of type "${from.text}" like that, so nothing to change`;
  if (rows.length > MAX_RETYPE) throw new Error(`${rows.length} edges: at most ${MAX_RETYPE} at once (give \`in\`)`);
  const change = { edges: rows.map((r) => r.id), from: from.id, to: to?.id ?? toName, newType: !to };
  if (args.preview) return applyRetype(source, change, true);
  if (rows.length > MANY) {
    const title = `Change the type of ${rows.length} edges from "${from.text}" to "${toName}"`;
    return source.propose(title, [{ tool: "retype", args: { ...change }, title }]);
  }
  return applyRetype(source, change);
}
/** A retype, run directly or once the user accepts it. An edge whose pair already has the new type there is dropped. */
export async function applyRetype(source, change, preview = false) {
  const rows = (await source.select(TABLES.edges, { id: change.edges })).filter((r) => r.type === change.from);
  const { graph, ops } = await source.slice([...new Set(rows.flatMap((r) => [r.from_node, r.to_node]))]);
  const types = await source.types();
  let to = change.newType ? findType(types, change.to)?.id : change.to;
  const toName = types.find((t) => t.id === to)?.text ?? change.to;
  nameTypes(graph, types);
  const end = (n) => `${nodeLabel(graph, n)} (#${shortId(n)})`;
  const show = (e) =>
    `${edgeLine(graph, e, end)}, ${e.data.in ? `only in ${nodeLabel(graph, e.data.in)}` : "everywhere"}`;
  const lines = [];
  for (const row of rows) {
    const e = graph.edge(row.id);
    if (!e) continue;
    const clash = graph
      .outgoing(e.data.from, "edge")
      .find((x) => to !== undefined && x.data.to === e.data.to && x.data.relation === to && x.data.in === e.data.in);
    if (preview) {
      lines.push(`${clash ? "would drop (that pair has one already)" : "would change"} ${show(e)}`);
      continue;
    }
    if (clash) {
      lines.push(`dropped, as ${show(clash)} is there: ${show(e)}`);
      await ops.deleteEdge(e.id);
      continue;
    }
    to ??= await ops.addEdgeType(change.to);
    nameTypes(graph, [{ id: to, text: toName, meaning: null }]);
    await ops.updateEdge(e.id, { relation: to });
    lines.push(`changed ${show(graph.edge(e.id))}`);
  }
  const head = preview
    ? `Would give ${rows.length} edges the type "${toName}" (preview: none done):`
    : `Gave ${rows.length} edges the type "${toName}":`;
  return [head, ...lines.map((line, i) => `${i + 1}. ${line}`)].join("\n");
}
/** An edge as `A --type · label--> B`, its ends written by `end`. */
export function edgeLine(graph, e, end) {
  const name = edgeName(graph, e);
  return `${end(e.data.from)} --${name ? `${name}--` : ""}> ${end(e.data.to)}`;
}
/** concepts_edges: the edges on a page of a group's children, by where they hold. */
export async function groupEdges(load, group, offset = 0) {
  const graph = new Graph();
  applyBundle(graph, await load.level([group], offset, EDGE_PAGE));
  if (!graph.node(group)) throw new Error("That node doesn't exist");
  const kids = new Set(graph.children(group).map((g) => g.data.to));
  const total = graph.childCount(group);
  const end = (n) => `${nodeLabel(graph, n)} (#${shortId(n)})`;
  const seen = new Set();
  const only = [];
  const between = [];
  const outside = [];
  let other = 0;
  for (const kid of kids) {
    // Not `edgesOf`: that drops edges for groups that aren't loaded, which are only counted here.
    for (const e of [...graph.outgoing(kid, "edge"), ...graph.incoming(kid, "edge")]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (e.data.in === group) only.push(edgeLine(graph, e, end));
      else if (e.data.in) other++;
      else if (kids.has(e.data.from) && kids.has(e.data.to)) between.push(edgeLine(graph, e, end));
      else outside.push(edgeLine(graph, e, end));
    }
  }
  const section = (title, list) => (list.length ? [title, ...list.map((l) => `  ${l}`)] : []);
  const shown = kids.size ? `children ${offset + 1}–${offset + kids.size} of ${total}` : `none after ${offset}`;
  const lines = [
    `Edges in ${end(group)}, ${shown}:`,
    ...section(`Only in this group (${only.length}):`, only),
    ...section(`Between its children, holding everywhere (${between.length}):`, between),
    ...section(`To nodes outside it, holding everywhere (${outside.length}):`, outside),
  ];
  if (!only.length && !between.length && !outside.length) lines.push("No edges.");
  if (other) lines.push(`${other} more hold only in other groups (concepts__neighbors shows them).`);
  if (offset + kids.size < total) lines.push(`More: concepts__edges #${shortId(group)} offset ${offset + kids.size}`);
  return lines.join("\n");
}
