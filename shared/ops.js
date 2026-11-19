import { firstLine } from "./graph.js";
import { freshKeys, keyBetween } from "./order.js";
import { applyRow, detailRow, edgeRow, groupRow, nodeRow, TABLES, viewRow } from "./rows.js";
/** A node's look when nothing differs from the default (closed, vertical, arranged by hand, not placed or sized, an icon sized picture, a folded prototype). */
const NO_LOOK = {
  open: false,
  layout: null,
  arrange: null,
  use_order: null,
  overflow: null,
  area_w: null,
  area_h: null,
  x: null,
  y: null,
  w: null,
  pic_w: null,
  proto_open: false,
  proto_h: null,
  proto_zoom: null,
};
const isDefaultLook = (l) =>
  !l.open &&
  !l.layout &&
  !l.arrange &&
  !l.overflow &&
  !l.proto_open &&
  [l.use_order, l.area_w, l.area_h, l.x, l.y, l.w, l.pic_w, l.proto_h, l.proto_zoom].every((v) => v === null);
export class Ops {
  graph;
  db;
  onChange;
  constructor(
    graph,
    db,
    /** Called after every local change, before it is saved, with the nodes it changed (none for looks and views). */
    onChange = () => {},
  ) {
    this.graph = graph;
    this.db = db;
    this.onChange = onChange;
  }
  // ---------- nodes ----------
  async createNode(text) {
    const rec = { id: uuid(), data: { text }, created_at: now() };
    this.graph.setNode(rec);
    this.graph.counts.set(rec.id, { children: 0, parents: 0 });
    this.graph.expanded.add(rec.id);
    this.onChange([rec.id]);
    await this.db.insert(TABLES.nodes, nodeRow(rec));
    return rec.id;
  }
  /** `color: null` (or undefined, given) takes its colour off. */
  async updateNode(id, patch) {
    const rec = this.requireNode(id);
    const next = { ...rec, data: { ...rec.data, ...patch } };
    if (!next.data.unordered) delete next.data.unordered;
    if (!next.data.color) delete next.data.color;
    this.graph.setNode(next);
    this.onChange([id]);
    const row = nodeRow(next);
    const values = {};
    if ("text" in patch) values.text = row.text;
    if ("unordered" in patch) values.unordered = row.unordered;
    if ("color" in patch) values.color = row.color ?? null;
    await this.db.update(TABLES.nodes, { id }, values);
  }
  /**
   * Delete a node everywhere: its edges and looks, out of every group, its own children unlinked (they stay), the views
   * it is the root of gone.
   */
  async deleteNode(id) {
    this.requireNode(id);
    // The database deletes these with the node: groups it is in or holds, edges on it or only for its group.
    for (const c of [...this.graph.conns.values()]) {
      if (c.data.from === id || c.data.to === id || (c.data.type === "edge" && c.data.in === id)) {
        if (c.data.type === "group") this.graph.adjustCounts(c.data.from, c.data.to, -1);
        this.graph.deleteConn(c.id);
      }
    }
    for (const v of this.graph.viewsOf(id)) this.graph.deleteView(v.id);
    this.graph.deleteNode(id);
    this.onChange([id]);
    await this.db.delete(TABLES.nodes, { id });
  }
  // ---------- groups ----------
  /** Put `child` inside `parent` at `index` (default: last). Returns the new group conn's id. */
  async addChild(parent, child, index) {
    this.requireNode(parent);
    this.requireNode(child);
    if (parent === child) throw new Error("A node can't be inside itself");
    if (this.graph.contains(child, parent)) throw new Error("That would put a node inside its own descendant");
    await this.loadPlaces(parent);
    if (this.graph.membership(parent, child)) throw new Error("It is already in that group");
    const id = uuid();
    const keys = this.place(parent, id, index);
    const data = { type: "group", from: parent, to: child, pos: keys.get(id) };
    const rec = { id, data, created_at: now() };
    keys.delete(id);
    const moved = this.reposition(keys);
    this.graph.setConn(rec);
    this.graph.adjustCounts(parent, child, 1);
    this.onChange([parent, child]);
    if (moved.length) await this.db.upsert(TABLES.groups, [...moved, rec].map(groupRow));
    else await this.db.insert(TABLES.groups, groupRow(rec));
    return id;
  }
  /** Create a node and put it inside `parent`. */
  async addNewChild(parent, text, index) {
    await this.loadPlaces(parent);
    const node = await this.createNode(text);
    const group = await this.addChild(parent, node, index);
    return { node, group };
  }
  /** Move a child to `index` among its siblings (index counted without the child itself). */
  async moveChild(groupId, index) {
    const g = this.requireGroup(groupId);
    await this.loadPlaces(g.data.from);
    const moved = this.reposition(this.place(g.data.from, groupId, index));
    this.onChange([g.data.from, g.data.to]);
    if (moved.length > 1) await this.db.upsert(TABLES.groups, moved.map(groupRow));
    else if (moved[0]) await this.db.update(TABLES.groups, { id: groupId }, { pos: moved[0].data.pos });
  }
  /**
   * Put all of a group's children in the order `children` (node ids), in one statement. It must list every child once:
   * an order made from a stale or partial list would move children nobody saw.
   */
  async reorder(parent, children) {
    this.requireNode(parent);
    await this.loadPlaces(parent);
    const places = this.graph.orderOf(parent);
    const byChild = new Map(places.map((g) => [g.data.to, g]));
    const strange = children.filter((c) => !byChild.has(c));
    const name = (id) => `"${firstLine(this.graph.node(id)?.data.text ?? "")}" (#${id.slice(0, 8)})`;
    if (strange.length) throw new Error(`Not children of that group: ${strange.map(name).join(", ")}`);
    if (new Set(children).size !== children.length) throw new Error("A child is listed twice");
    const missing = places.filter((g) => !children.includes(g.data.to)).map((g) => g.data.to);
    if (missing.length) {
      throw new Error(`The order leaves out ${missing.length} of the children: ${missing.map(name).join(", ")}`);
    }
    const keys = freshKeys(children.length);
    const moved = this.reposition(new Map(children.map((c, i) => [byChild.get(c).id, keys[i]])));
    this.onChange([parent]);
    if (moved.length) await this.db.upsert(TABLES.groups, moved.map(groupRow));
  }
  /**
   * Move a child into another group. Its edges only for the old group are dropped; the others go with the node. In
   * every view it stays open or closed and keeps its layout, but not its free position and width, which were for the
   * old group.
   */
  async moveToGroup(groupId, parent, index) {
    const g = this.requireGroup(groupId);
    if (g.data.from === parent) return this.moveChild(groupId, index ?? Number.MAX_SAFE_INTEGER);
    const id = await this.addChild(parent, g.data.to, index);
    await this.unplace(g.data.to);
    await this.removeFromGroup(groupId);
    return id;
  }
  /**
   * Take a child out of one group, with its edges only for that group; the node stays (elsewhere, or unplaced), with
   * its looks.
   */
  async removeFromGroup(groupId) {
    const g = this.requireGroup(groupId);
    // The database deletes the edges with the group conn.
    for (const e of this.graph.edgesOf(g.data.to)) if (e.data.in === g.data.from) this.graph.deleteConn(e.id);
    this.graph.deleteConn(groupId);
    this.graph.adjustCounts(g.data.from, g.data.to, -1);
    this.onChange([g.data.from, g.data.to]);
    await this.db.delete(TABLES.groups, { id: groupId });
  }
  // ---------- looks ----------
  /**
   * Change how the node `node` looks in the view `view`, wherever it shows there (as the root or as a child): open, its
   * children's layout, its free position. A look back at the default (closed, vertical, not placed) has no row.
   */
  async setLook(view, node, patch) {
    this.requireNode(node);
    const old = this.graph.look(view, node);
    const base = { id: uuid(), view, node, ...NO_LOOK, created_at: now() };
    const next = { ...base, ...old, ...patch };
    if (next.layout === "vertical") next.layout = null;
    if (isDefaultLook(next)) {
      if (!old) return;
      this.graph.deleteLook(old.id);
      this.onChange([]);
      await this.db.delete(TABLES.looks, { id: old.id });
      return;
    }
    this.graph.setLook(next);
    this.onChange([]);
    if (!old) {
      await this.db.insert(TABLES.looks, next);
      return;
    }
    const values = {};
    for (const key of Object.keys(patch)) Object.assign(values, { [key]: next[key] });
    await this.db.update(TABLES.looks, { id: old.id }, values);
  }
  /**
   * Put many children of a group laid out freely by hand at once (an arrangement made once): `places` are the nodes
   * and their top lefts. One write.
   */
  async placeAll(view, places) {
    const rows = places.map(({ node, x, y }) => {
      this.requireNode(node);
      const old = this.graph.look(view, node);
      return { id: uuid(), view, node, ...NO_LOOK, created_at: now(), ...old, x, y };
    });
    if (!rows.length) return;
    for (const row of rows) this.graph.setLook(row);
    this.onChange([]);
    await this.db.upsert(TABLES.looks, rows);
  }
  /**
   * Forget where a node sits in free layouts and how wide it is there, in every view (`moveToGroup`: those were for
   * the old group); it stays open or closed, and its children keep their layout, arrangement and size.
   */
  async unplace(node) {
    const rows = await this.db.select(TABLES.looks, { node });
    for (const old of rows.filter((l) => l.x !== null || l.y !== null || l.w !== null)) {
      const next = { ...old, x: null, y: null, w: null };
      if (isDefaultLook(next)) {
        this.graph.deleteLook(old.id);
        await this.db.delete(TABLES.looks, { id: old.id });
      } else {
        this.graph.setLook(next);
        await this.db.update(TABLES.looks, { id: old.id }, { x: null, y: null, w: null });
      }
    }
    this.onChange([]);
  }
  // ---------- edges ----------
  /** An edge from one node to another; with `in`, it holds only inside that group (both must be in it). */
  async addEdge(from, to, fields = {}) {
    this.requireNode(from);
    this.requireNode(to);
    if (from === to) throw new Error("An edge needs two different nodes");
    const data = this.edgeData({ type: "edge", from, to }, fields);
    const rec = { id: uuid(), data, created_at: now() };
    this.graph.setConn(rec);
    this.onChange([from, to]);
    await this.db.insert(TABLES.edges, edgeRow(rec));
    return rec.id;
  }
  /** Change an edge's type, label, or where it holds: only `in` a group, or everywhere (`in: null`). */
  async updateEdge(edgeId, patch) {
    const rec = this.graph.edge(edgeId);
    if (!rec) throw new Error(`No edge ${edgeId}`);
    const data = this.edgeData(rec.data, patch);
    this.graph.setConn({ ...rec, data });
    this.onChange([rec.data.from, rec.data.to]);
    const row = edgeRow({ ...rec, data });
    const values = {};
    if ("relation" in patch) values.type = row.type;
    if ("label" in patch) values.label = row.label;
    if ("in" in patch) values.in_group = row.in_group;
    await this.db.update(TABLES.edges, { id: edgeId }, values);
  }
  async deleteEdge(edgeId) {
    const rec = this.graph.edge(edgeId);
    this.graph.deleteConn(edgeId);
    this.onChange(rec ? [rec.data.from, rec.data.to] : []);
    await this.db.delete(TABLES.edges, { id: edgeId });
  }
  /** The "Edge types" node, made (with its place in the views list) the first time it is needed. */
  async edgeTypes() {
    if (this.graph.edgeTypes && this.graph.node(this.graph.edgeTypes)) return this.graph.edgeTypes;
    const [settings] = await this.db.select(TABLES.settings);
    if (settings?.edge_types) {
      const [node] = await this.db.select(TABLES.nodes, { id: settings.edge_types });
      if (node) {
        applyRow(this.graph, TABLES.nodes, "insert", node);
        return (this.graph.edgeTypes = node.id);
      }
    }
    const node = await this.createNode("Edge types");
    await this.addView(node);
    try {
      if (settings) await this.db.update(TABLES.settings, { id: settings.id }, { edge_types: node });
      else await this.db.insert(TABLES.settings, { edge_types: node });
    } catch (error) {
      // Another device made one at the same moment: use that one.
      await this.deleteNode(node);
      const [again] = await this.db.select(TABLES.settings);
      if (!again?.edge_types) throw error;
      return (this.graph.edgeTypes = again.edge_types);
    }
    return (this.graph.edgeTypes = node);
  }
  /** A new edge type, last under "Edge types". */
  async addEdgeType(name) {
    const parent = await this.edgeTypes();
    return (await this.addNewChild(parent, name)).node;
  }
  // ---------- details ----------
  /** Write a node's summary (a short version of what is inside it, nothing new). */
  async setSummary(node, text) {
    this.requireNode(node);
    const old = this.graph.summary(node);
    const data = { node, kind: "summary", text };
    const rec = { id: old?.id ?? uuid(), data, created_at: old?.created_at ?? now() };
    this.graph.setDetail(rec);
    this.onChange([node]);
    if (old) await this.db.update(TABLES.details, { id: old.id }, { text });
    else await this.db.insert(TABLES.details, detailRow(rec));
    return rec.id;
  }
  async removeSummary(node) {
    const old = this.graph.summary(node);
    if (!old) return;
    this.graph.deleteDetail(old.id);
    this.onChange([node]);
    await this.db.delete(TABLES.details, { id: old.id });
  }
  // ---------- tags ----------
  /** Tag a node. A tag of a `single` set replaces the node's other tag of that set (the database does it too). */
  async tag(node, tag) {
    this.requireNode(node);
    const def = this.requireTag(tag);
    if (this.graph.nodeTag(node, tag)) return;
    const set = def.tag_set ? this.graph.tagSets.get(def.tag_set) : undefined;
    if (set?.single) {
      for (const row of this.graph.nodeTagRows(node)) {
        if (this.graph.tags.get(row.tag)?.tag_set === set.id) this.graph.deleteNodeTag(row.id);
      }
    }
    const row = { id: uuid(), node, tag, created_at: now() };
    this.graph.setNodeTag(row);
    this.onChange([node]);
    await this.db.insert(TABLES.nodeTags, row);
  }
  async untag(node, tag) {
    const row = this.graph.nodeTag(node, tag);
    if (!row) return;
    this.graph.deleteNodeTag(row.id);
    this.onChange([node]);
    await this.db.delete(TABLES.nodeTags, { id: row.id });
  }
  /** A new tag, last in its set (or among the tags in no set). Returns its id. */
  async createTag(fields) {
    const name = this.tagName(fields.name);
    const tagSet = fields.tag_set ?? null;
    if (tagSet) this.requireTagSet(tagSet);
    const last = [...this.graph.tags.values()].filter((t) => t.tag_set === tagSet).map((t) => t.pos);
    const row = {
      id: uuid(),
      tag_set: tagSet,
      name,
      description: fields.description?.trim() ?? "",
      color: fields.color ?? null,
      pos: Math.max(0, ...last) + 1,
      created_at: now(),
    };
    this.graph.setTag(row);
    this.onChange([]);
    await this.db.insert(TABLES.tags, row);
    return row.id;
  }
  /** Rename a tag, describe it, colour it, or put it in another set (null: none) or place (`pos`). */
  async updateTag(id, patch) {
    const old = this.requireTag(id);
    const values = {};
    if (patch.name !== undefined) values.name = this.tagName(patch.name, id);
    if (patch.description !== undefined) values.description = patch.description.trim();
    if (patch.color !== undefined) values.color = patch.color;
    if (patch.tag_set !== undefined) {
      if (patch.tag_set) this.requireTagSet(patch.tag_set);
      values.tag_set = patch.tag_set;
    }
    if (patch.pos !== undefined) values.pos = patch.pos;
    this.graph.setTag({ ...old, ...values });
    this.onChange([]);
    await this.db.update(TABLES.tags, { id }, values);
  }
  /** Delete a tag: it goes from every node too. */
  async deleteTag(id) {
    this.graph.deleteTag(id);
    this.onChange([]);
    await this.db.delete(TABLES.tags, { id });
  }
  /** A new set of tags, last. `single`: a node has at most one of its tags. Returns its id. */
  async createTagSet(fields) {
    const name = this.setName(fields.name);
    const row = {
      id: uuid(),
      name,
      description: fields.description?.trim() ?? "",
      single: !!fields.single,
      pos: Math.max(0, ...[...this.graph.tagSets.values()].map((s) => s.pos)) + 1,
      created_at: now(),
    };
    this.graph.setTagSet(row);
    this.onChange([]);
    await this.db.insert(TABLES.tagSets, row);
    return row.id;
  }
  async updateTagSet(id, patch) {
    const old = this.requireTagSet(id);
    const values = {};
    if (patch.name !== undefined) values.name = this.setName(patch.name, id);
    if (patch.description !== undefined) values.description = patch.description.trim();
    if (patch.single !== undefined) values.single = patch.single;
    if (patch.pos !== undefined) values.pos = patch.pos;
    this.graph.setTagSet({ ...old, ...values });
    this.onChange([]);
    await this.db.update(TABLES.tagSets, { id }, values);
  }
  /** Delete a set; its tags stay, in no set. */
  async deleteTagSet(id) {
    this.graph.deleteTagSet(id);
    this.onChange([]);
    await this.db.delete(TABLES.tagSets, { id });
  }
  // ---------- views ----------
  /** A new view of `root`, with the default look (a root can have many views). */
  async addView(root, name) {
    this.requireNode(root);
    const data = { root, ...(name?.trim() ? { name: name.trim() } : {}) };
    const rec = { id: uuid(), data, created_at: now() };
    this.graph.setView(rec);
    this.onChange([]);
    await this.db.insert(TABLES.views, viewRow(rec));
    return rec.id;
  }
  /** Rename a view (an empty name: the root's title) or give it another root. */
  async updateView(id, patch) {
    const rec = this.graph.views.get(id);
    if (!rec) throw new Error(`No view ${id}`);
    const { name, root } = { ...rec.data, ...patch };
    const data = { root, ...(name?.trim() ? { name: name.trim() } : {}) };
    this.graph.setView({ ...rec, data });
    this.onChange([]);
    const row = viewRow({ ...rec, data });
    const values = {};
    if ("root" in patch) values.root = row.root;
    if ("name" in patch) values.name = row.name;
    await this.db.update(TABLES.views, { id }, values);
  }
  /** Delete a view and its looks; its root stays. */
  async removeView(id) {
    this.graph.deleteView(id);
    this.onChange([]);
    await this.db.delete(TABLES.views, { id });
  }
  // ---------- internals ----------
  /** Read every place in `parent` unless all of them are loaded, so a new key fits between the right neighbours. */
  async loadPlaces(parent) {
    if (this.graph.childrenComplete(parent)) return;
    const rows = await this.db.select(TABLES.groups, { parent });
    for (const row of rows) if (!this.graph.conn(row.id)) applyRow(this.graph, TABLES.groups, "insert", row);
    const counts = this.graph.counts.get(parent) ?? { children: 0, parents: 0 };
    this.graph.counts.set(parent, { ...counts, children: rows.length });
  }
  /**
   * The `pos` keys that put the child `id` at `index` (default: last) among the other children of `parent`: just its
   * own key, or fresh keys for every child when its neighbours leave no room. `index` counts loaded children.
   */
  place(parent, id, index) {
    const others = this.graph.orderOf(parent).filter((g) => g.id !== id);
    const shown = others.filter((g) => this.graph.nodes.has(g.data.to));
    const at = index === undefined ? others.length : this.indexAmong(others, shown, index);
    const key = keyBetween(others[at - 1], others[at]);
    if (key) return new Map([[id, key]]);
    const order = others.map((g) => g.id);
    order.splice(at, 0, id);
    const keys = freshKeys(order.length);
    return new Map(order.map((g, i) => [g, keys[i]]));
  }
  /** Where the `index`-th loaded child (`shown`) is among all places (`others`). */
  indexAmong(others, shown, index) {
    const i = clamp(index, shown.length);
    if (i >= shown.length) return shown.length ? others.indexOf(shown[shown.length - 1]) + 1 : others.length;
    return others.indexOf(shown[i]);
  }
  /** Give existing group conns their new keys in the graph; returns the ones that changed. */
  reposition(keys) {
    const moved = [];
    for (const [id, pos] of keys) {
      const g = this.graph.group(id);
      if (!g || g.data.pos === pos) continue;
      const rec = { ...g, data: { ...g.data, pos } };
      this.graph.setConn(rec);
      moved.push(rec);
    }
    return moved;
  }
  /** An edge with `fields` applied, checked: an edge for one group needs both nodes in it. */
  edgeData(base, fields) {
    const { relation, label, in: only, ...rest } = { ...base, ...fields };
    if (only && (!this.graph.membership(only, rest.from) || !this.graph.membership(only, rest.to))) {
      throw new Error("An edge for one group needs both nodes in that group");
    }
    const text = label?.trim();
    return {
      ...rest,
      ...(relation ? { relation } : {}),
      ...(text ? { label: text } : {}),
      ...(only ? { in: only } : {}),
    };
  }
  requireNode(id) {
    const rec = this.graph.node(id);
    if (!rec) throw new Error(`No node ${id}`);
    return rec;
  }
  requireGroup(id) {
    const rec = this.graph.group(id);
    if (!rec) throw new Error(`No group connection ${id}`);
    return rec;
  }
  requireTag(id) {
    const row = this.graph.tags.get(id);
    if (!row) throw new Error(`No tag ${id}`);
    return row;
  }
  requireTagSet(id) {
    const row = this.graph.tagSets.get(id);
    if (!row) throw new Error(`No tag set ${id}`);
    return row;
  }
  /** A tag's name, checked: not empty, and no other tag has it (in any case). */
  tagName(name, self) {
    const text = name.trim();
    if (!text) throw new Error("A tag needs a name");
    const other = this.graph.tagByName(text);
    if (other && other.id !== self) throw new Error(`There is a tag "${other.name}" already`);
    return text;
  }
  setName(name, self) {
    const text = name.trim();
    if (!text) throw new Error("A set of tags needs a name");
    const other = this.graph.tagSetByName(text);
    if (other && other.id !== self) throw new Error(`There is a set "${other.name}" already`);
    return text;
  }
}
const clamp = (i, max) => Math.max(0, Math.min(i, max));
const now = () => new Date().toISOString();
export function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
