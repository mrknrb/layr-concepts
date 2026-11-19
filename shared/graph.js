// The loaded part of the concept graph in memory, with indexes by connection end. Panels and the backend load only
// what they need (`rows.ts` bundles), so a node's children may be missing or partly loaded: `counts` say how many
// there are in all, `expanded` which nodes' children were loaded. Pure reads; writes are in ops.ts.
import { compareMembers } from "./order.js";
export class Graph {
  nodes = new Map();
  conns = new Map();
  views = new Map();
  details = new Map();
  /** Children and groups of each node, all of them (from the database), by node id. */
  counts = new Map();
  /** Nodes whose children were loaded (the first page, at least). */
  expanded = new Set();
  /** Looks (how a place shows in a view), by id. */
  looks = new Map();
  /** The "Edge types" node, once there is one. */
  edgeTypes;
  /** Tags and tag sets: those loaded (panels load them all; bundles bring the ones on their nodes). */
  tags = new Map();
  tagSets = new Map();
  /** Tags on loaded nodes, by row id. */
  nodeTags = new Map();
  /** Conn ids by their `from` / `to` end; detail ids by node; node tag ids by node. */
  out = new Map();
  in = new Map();
  detailsOf = new Map();
  tagsAt = new Map();
  /** Look ids by view and node (`lookKey`). */
  lookAt = new Map();
  /** Forget everything, e.g. before loading again. */
  clear() {
    for (const map of [this.nodes, this.conns, this.views, this.details, this.counts, this.looks]) map.clear();
    for (const map of [this.tags, this.tagSets, this.nodeTags]) map.clear();
    for (const map of [this.out, this.in, this.detailsOf, this.tagsAt, this.lookAt]) map.clear();
    this.expanded.clear();
    this.edgeTypes = undefined;
  }
  setNode(rec) {
    this.nodes.set(rec.id, rec);
  }
  deleteNode(id) {
    this.nodes.delete(id);
    this.counts.delete(id);
    this.expanded.delete(id);
    for (const detail of [...(this.detailsOf.get(id) ?? [])]) this.deleteDetail(detail);
    for (const row of [...(this.tagsAt.get(id) ?? [])]) this.deleteNodeTag(row);
    for (const [lookId, look] of this.looks) if (look.node === id) this.deleteLook(lookId);
  }
  setView(rec) {
    this.views.set(rec.id, rec);
  }
  deleteView(id) {
    this.views.delete(id);
    for (const [lookId, look] of this.looks) if (look.view === id) this.deleteLook(lookId);
  }
  setConn(rec) {
    this.deleteConn(rec.id);
    this.conns.set(rec.id, rec);
    index(this.out, rec.data.from).add(rec.id);
    index(this.in, rec.data.to).add(rec.id);
  }
  deleteConn(id) {
    const old = this.conns.get(id);
    if (!old) return;
    this.conns.delete(id);
    this.out.get(old.data.from)?.delete(id);
    this.in.get(old.data.to)?.delete(id);
  }
  setDetail(rec) {
    this.deleteDetail(rec.id);
    this.details.set(rec.id, rec);
    index(this.detailsOf, rec.data.node).add(rec.id);
  }
  deleteDetail(id) {
    const old = this.details.get(id);
    if (!old) return;
    this.details.delete(id);
    this.detailsOf.get(old.data.node)?.delete(id);
  }
  setLook(row) {
    this.deleteLook(row.id);
    this.looks.set(row.id, row);
    this.lookAt.set(lookKey(row), row.id);
  }
  deleteLook(id) {
    const old = this.looks.get(id);
    if (!old) return;
    this.looks.delete(id);
    if (this.lookAt.get(lookKey(old)) === id) this.lookAt.delete(lookKey(old));
  }
  setTag(row) {
    this.tags.set(row.id, row);
  }
  /** A deleted tag is gone from every node too (the database cascades). */
  deleteTag(id) {
    this.tags.delete(id);
    for (const row of [...this.nodeTags.values()]) if (row.tag === id) this.deleteNodeTag(row.id);
  }
  setTagSet(row) {
    this.tagSets.set(row.id, row);
  }
  /** A deleted set's tags stay, in no set. */
  deleteTagSet(id) {
    this.tagSets.delete(id);
    for (const tag of this.tags.values()) if (tag.tag_set === id) this.tags.set(tag.id, { ...tag, tag_set: null });
  }
  setNodeTag(row) {
    this.deleteNodeTag(row.id);
    this.nodeTags.set(row.id, row);
    index(this.tagsAt, row.node).add(row.id);
  }
  deleteNodeTag(id) {
    const old = this.nodeTags.get(id);
    if (!old) return;
    this.nodeTags.delete(id);
    this.tagsAt.get(old.node)?.delete(id);
  }
  /** All of a node's tags at once (a node read again). */
  setNodeTags(node, rows) {
    for (const id of [...(this.tagsAt.get(node) ?? [])]) this.deleteNodeTag(id);
    for (const row of rows) this.setNodeTag(row);
  }
  node(id) {
    return this.nodes.get(id);
  }
  conn(id) {
    return this.conns.get(id);
  }
  group(id) {
    const rec = this.conns.get(id);
    return rec?.data.type === "group" ? rec : undefined;
  }
  edge(id) {
    const rec = this.conns.get(id);
    return rec?.data.type === "edge" ? rec : undefined;
  }
  outgoing(id, type) {
    return this.ends(this.out, id, type);
  }
  incoming(id, type) {
    return this.ends(this.in, id, type);
  }
  ends(map, id, type) {
    const result = [];
    for (const connId of map.get(id) ?? []) {
      const rec = this.conns.get(connId);
      if (rec?.data.type === type) result.push(rec);
    }
    return result;
  }
  /** Loaded group conns from `parent` whose child is loaded, unordered. */
  members(parent) {
    return this.outgoing(parent, "group").filter((g) => this.nodes.has(g.data.to));
  }
  /** Where `node` appears, as far as loaded: its group conns from loaded parents. */
  parents(node) {
    return this.incoming(node, "group").filter((g) => this.nodes.has(g.data.from));
  }
  membership(parent, child) {
    return this.outgoing(parent, "group").find((g) => g.data.to === child);
  }
  /** How many children `node` has, loaded or not. */
  childCount(node) {
    return Math.max(this.counts.get(node)?.children ?? 0, this.members(node).length);
  }
  /** In how many groups `node` is, loaded or not. */
  parentCount(node) {
    return Math.max(this.counts.get(node)?.parents ?? 0, this.parents(node).length);
  }
  /** Threads (T3 threads, AI chats) that changed or mentioned `node`. */
  threadCount(node) {
    return this.counts.get(node)?.threads ?? 0;
  }
  /** Every loaded group conn of `parent` has its place in `children`: the counts agree with what is loaded. */
  childrenComplete(parent) {
    const count = this.counts.get(parent)?.children;
    return count !== undefined && this.outgoing(parent, "group").length >= count;
  }
  /** A child added to (+1) or taken out of (-1) a group: the counts of both ends follow. */
  adjustCounts(parent, child, delta) {
    const p = this.counts.get(parent);
    if (p) this.counts.set(parent, { ...p, children: Math.max(0, p.children + delta) });
    const c = this.counts.get(child);
    if (c) this.counts.set(child, { ...c, parents: Math.max(0, c.parents + delta) });
  }
  /**
   * An edge counts when both ends are loaded, different nodes and, if it is only for one group (`in`), both are
   * children of that group as far as loaded. Anything else is ignored.
   */
  validEdge(rec) {
    const { from, to } = rec.data;
    if (from === to || !this.nodes.has(from) || !this.nodes.has(to)) return false;
    return !rec.data.in || (!!this.membership(rec.data.in, from) && !!this.membership(rec.data.in, to));
  }
  /** Edges from or to `node`, valid ones only. */
  edgesOf(node) {
    return [...this.outgoing(node, "edge"), ...this.incoming(node, "edge")].filter((e) => this.validEdge(e));
  }
  /** Edges that hold wherever their nodes are (no `in`) from or to `node`. */
  relations(node) {
    return this.edgesOf(node).filter((e) => !e.data.in);
  }
  /** Edges only for the group `parent`. */
  edges(parent) {
    return this.members(parent).flatMap((g) =>
      this.outgoing(g.data.to, "edge").filter((e) => e.data.in === parent && this.validEdge(e)),
    );
  }
  /** Edges between two children of `parent` that hold there: those only for it and those everywhere. */
  edgesBetween(parent) {
    const kids = new Set(this.members(parent).map((g) => g.data.to));
    return [...kids].flatMap((node) =>
      this.outgoing(node, "edge").filter(
        (e) => kids.has(e.data.to) && (!e.data.in || e.data.in === parent) && this.validEdge(e),
      ),
    );
  }
  /** The loaded children of `parent` in order (see `compareMembers`). */
  children(parent) {
    return this.members(parent).sort(compareMembers);
  }
  /** Every loaded group conn of `parent` in order, its child loaded or not: what places a new child. */
  orderOf(parent) {
    return this.outgoing(parent, "group").sort(compareMembers);
  }
  /** Whether `above` contains `below`, directly or deeper, as far as loaded. */
  contains(above, below) {
    const seen = new Set();
    const stack = [above];
    while (stack.length) {
      const id = stack.pop();
      for (const g of this.outgoing(id, "group")) {
        if (g.data.to === below) return true;
        if (!seen.has(g.data.to)) {
          seen.add(g.data.to);
          stack.push(g.data.to);
        }
      }
    }
    return false;
  }
  /** A loaded node by full id or by a unique id prefix (outlines show 8 characters). */
  findNode(idOrPrefix) {
    const exact = this.nodes.get(idOrPrefix);
    if (exact) return exact;
    if (idOrPrefix.length < 4) return undefined;
    const matches = [...this.nodes.values()].filter((n) => n.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }
  /** A node's summary, if it has one. */
  summary(node) {
    for (const id of this.detailsOf.get(node) ?? []) {
      const rec = this.details.get(id);
      if (rec?.data.kind === "summary") return rec;
    }
    return undefined;
  }
  /** How the node `node` looks in the view `view` (wherever it shows there), if it differs from the default. */
  look(view, node) {
    const id = this.lookAt.get(`${view} ${node}`);
    return id ? this.looks.get(id) : undefined;
  }
  /** The views whose root is `node`, oldest first. */
  viewsOf(node) {
    return [...this.views.values()]
      .filter((v) => v.data.root === node)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  isView(node) {
    return this.viewsOf(node).length > 0;
  }
  /** The rows of a node's tags. */
  nodeTagRows(node) {
    return [...(this.tagsAt.get(node) ?? [])].map((id) => this.nodeTags.get(id));
  }
  /** The row of `tag` on `node`, if it has it. */
  nodeTag(node, tag) {
    return this.nodeTagRows(node).find((row) => row.tag === tag);
  }
  /** A node's tags (those loaded), in the order of `sortedTags`. */
  tagsOf(node) {
    const ids = new Set(this.nodeTagRows(node).map((row) => row.tag));
    return this.sortedTags().filter((t) => ids.has(t.id));
  }
  /** Every loaded tag: set by set in the sets' order, each set's tags in theirs, then the tags in no set. */
  sortedTags() {
    const sets = this.sortedTagSets().map((s) => s.id);
    const rank = (t) => {
      const at = t.tag_set ? sets.indexOf(t.tag_set) : -1;
      return at < 0 ? sets.length : at;
    };
    return [...this.tags.values()].sort(
      (a, b) => rank(a) - rank(b) || a.pos - b.pos || a.created_at.localeCompare(b.created_at),
    );
  }
  /** The sets in order. */
  sortedTagSets() {
    return [...this.tagSets.values()].sort((a, b) => a.pos - b.pos || a.created_at.localeCompare(b.created_at));
  }
  /** A loaded tag by name, in any case. */
  tagByName(name) {
    const key = name.trim().toLowerCase();
    return [...this.tags.values()].find((t) => t.name.toLowerCase() === key);
  }
  /** A loaded set by name, in any case. */
  tagSetByName(name) {
    const key = name.trim().toLowerCase();
    return [...this.tagSets.values()].find((s) => s.name.toLowerCase() === key);
  }
}
/** A node's label: its first line, with layr links reduced to their labels. */
export function firstLine(text) {
  const line = text.trim().split("\n")[0] ?? "";
  return line.replace(/\[([^\]\n]*)\]\(layr:\/\/[^)\s]+\)/g, "$1").trim();
}
const lookKey = (l) => `${l.view} ${l.node}`;
function index(map, key) {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  return set;
}
