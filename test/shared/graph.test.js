import { afterEach, describe, expect, it } from "../expect.js";
import { connect, groupEdges } from "../../shared/edges.js";
import { checkGroup, follow } from "../../shared/inspect.js";
import { applyProposal } from "../../shared/proposals.js";
import { Graph } from "../../shared/graph.js";
import { Ops, uuid } from "../../shared/ops.js";
import { compareMembers } from "../../shared/order.js";
import { hiddenWords, outline, shortText, viewTitle } from "../../shared/outline.js";
import { childrenOutline, readOutline } from "../../shared/read.js";
import { applyBundle, applyRow, TABLES } from "../../shared/rows.js";
const g = (id, pos, t = 0) => ({
  id,
  data: { type: "group", from: "p", to: id, pos },
  created_at: `2026-01-01T00:00:0${t}Z`,
});
describe("compareMembers", () => {
  it("sorts by pos byte by byte, then age, then id", () => {
    const list = [g("d", "a1", 2), g("c", "a1", 1), g("b", "Zz"), g("a", "a0V"), g("e", "a1", 1)];
    expect(list.sort(compareMembers).map((m) => m.id)).toEqual(["b", "a", "c", "e", "d"]);
  });
});
/**
 * The concepts tables in memory, with the database's cascades and its unique place per group (checked at the end of
 * each statement), counting statements; and the plugin's read functions over them.
 */
function fakeDb() {
  const tables = Object.fromEntries(Object.values(TABLES).map((t) => [t, new Map()]));
  let statements = 0;
  const list = (rows) => (Array.isArray(rows) ? rows : [rows]);
  const matches = (row, filter) =>
    Object.entries(filter).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v));
  const remove = (table, test) => {
    for (const row of [...tables[table].values()].filter(test)) {
      tables[table].delete(row.id);
      if (table === TABLES.nodes) {
        remove(TABLES.groups, (g) => g.parent === row.id || g.child === row.id);
        remove(TABLES.edges, (e) => [e.from_node, e.to_node, e.in_group].includes(row.id));
        remove(TABLES.views, (v) => v.root === row.id);
        remove(TABLES.details, (d) => d.node === row.id);
        remove(TABLES.nodeTags, (t) => t.node === row.id);
        remove(TABLES.looks, (l) => l.node === row.id);
      } else if (table === TABLES.tags) {
        remove(TABLES.nodeTags, (t) => t.tag === row.id);
      } else if (table === TABLES.tagSets) {
        for (const tag of tables.tags.values()) if (tag.tag_set === row.id) tag.tag_set = null;
      } else if (table === TABLES.groups) {
        remove(TABLES.edges, (e) => e.in_group === row.parent && [e.from_node, e.to_node].includes(row.child));
      } else if (table === TABLES.views) {
        remove(TABLES.looks, (l) => l.view === row.id);
      }
    }
  };
  const statement = async (write) => {
    statements++;
    const result = write();
    const places = [...tables.groups.values()].map((g) => `${g.parent} ${g.pos}`);
    if (new Set(places).size !== places.length) throw new Error("duplicate key value violates concepts_groups_pos");
    return result;
  };
  const db = {
    select: async (table, filter) => [...tables[table].values()].filter((row) => matches(row, filter ?? {})),
    insert: (table, rows) =>
      statement(() => {
        for (const row of list(rows)) {
          const id = row.id ?? uuid();
          if (tables[table].has(id)) throw new Error("duplicate key");
          if (table === TABLES.nodeTags) {
            // A tag of a single set replaces the node's other tag of that set (concepts_node_tags_single).
            const set = tables.tag_sets.get(tables.tags.get(row.tag)?.tag_set);
            const sameSet = (t) => tables.tags.get(t.tag)?.tag_set === set?.id;
            if (set?.single) remove(TABLES.nodeTags, (t) => t.node === row.node && t.tag !== row.tag && sameSet(t));
          }
          tables[table].set(id, { ...row, id });
        }
        return [];
      }),
    upsert: (table, rows) =>
      statement(() => {
        for (const row of list(rows)) tables[table].set(row.id, { ...tables[table].get(row.id), ...row });
        return [];
      }),
    update: (table, filter, patch) =>
      statement(() => {
        for (const row of tables[table].values()) if (matches(row, filter)) Object.assign(row, patch);
        return [];
      }),
    delete: (table, filter) => statement(() => remove(table, (row) => matches(row, filter))),
  };
  /** The graph as loaded from the tables. */
  const load = () => {
    const graph = new Graph();
    for (const [table, rows] of Object.entries(tables)) rows.forEach((row) => applyRow(graph, table, "insert", row));
    return graph;
  };
  // The read functions (migration 0009), as far as these tests need them.
  const groups = () => [...tables.groups.values()];
  const info = (row) => ({
    ...row,
    children: groups().filter((g) => g.parent === row.id).length,
    parents: groups().filter((g) => g.child === row.id).length,
    tags: [...tables.node_tags.values()].filter((t) => t.node === row.id).map((t) => ({ id: t.id, tag: t.tag })),
  });
  const bundle = (nodeIds, groupIds) => {
    const edges = [...tables.edges.values()].filter(
      (e) => nodeIds.includes(e.from_node) || nodeIds.includes(e.to_node),
    );
    const ids = new Set([...nodeIds, ...edges.flatMap((e) => [e.from_node, e.to_node, e.type, e.in_group])]);
    return {
      nodes: [...tables.nodes.values()].filter((n) => ids.has(n.id)).map(info),
      groups: groups().filter((g) => groupIds.includes(g.id)),
      edges: edges,
      details: [...tables.details.values()].filter((d) => nodeIds.includes(d.node)),
      tags: [...tables.tags.values()].filter((t) =>
        [...tables.node_tags.values()].some((nt) => nt.tag === t.id && ids.has(nt.node)),
      ),
    };
  };
  const sorted = (parent) =>
    groups()
      .filter((g) => g.parent === parent)
      .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.created_at.localeCompare(b.created_at)));
  let reads = 0;
  const loader = {
    get: async (ids) => (reads++, bundle(ids, [])),
    level: async (parents, skip, pageSize) => {
      reads++;
      const page = parents.flatMap((p) => sorted(p).slice(skip, skip + pageSize));
      return {
        ...bundle(
          [...parents, ...page.map((g) => g.child)],
          page.map((g) => g.id),
        ),
        expanded: parents,
      };
    },
    where: async () => ({ view: false, parents: [], path: [] }),
  };
  return { db, load, loader, reads: () => reads, statements: () => [statements, (statements = 0)][0] };
}
const snapshot = (graph) =>
  JSON.stringify([
    ...[graph.nodes, graph.conns, graph.views, graph.details].map((map) =>
      [...map.values()].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, data }) => ({ id, data })),
    ),
    [...graph.looks.values()].map((l) => [l.view, l.node, l.open, l.layout, l.x, l.y].join(" ")).sort(),
    ...[graph.tags, graph.tagSets].map((map) => [...map.values()].map((r) => JSON.stringify(r)).sort()),
    [...graph.nodeTags.values()].map((t) => `${t.id} ${t.node} ${t.tag}`).sort(),
  ]);
let check;
// After every test, what the tables hold reads as the graph the ops kept in memory.
afterEach(() => {
  check?.();
  check = undefined;
});
/** A graph with ops on fake tables. */
function setup() {
  const fake = fakeDb();
  const graph = new Graph();
  const ops = new Ops(graph, fake.db);
  const texts = (parent) => graph.children(parent).map((g) => graph.node(g.data.to).data.text);
  check = () => expect(snapshot(fake.load())).toBe(snapshot(graph));
  return { graph, ops, texts, written: fake.statements, fake };
}
describe("Ops", () => {
  it("says which nodes each change touched", async () => {
    const fake = fakeDb();
    const touched = [];
    const ops = new Ops(new Graph(), fake.db, (nodes) => touched.push(nodes));
    const p = await ops.createNode("P");
    const a = await ops.addNewChild(p, "A");
    const b = await ops.addNewChild(p, "B");
    touched.length = 0;
    await ops.moveChild(b.group, 0);
    await ops.reorder(p, [a.node, b.node]);
    const edge = await ops.addEdge(a.node, b.node);
    await ops.deleteEdge(edge);
    await ops.setSummary(p, "Two letters");
    await ops.removeFromGroup(a.group);
    expect(touched).toEqual([[p, b.node], [p], [a.node, b.node], [a.node, b.node], [p], [p, a.node]]);
  });
  it("keeps the order through inserts, moves and removals, one statement each", async () => {
    const { ops, texts, written } = setup();
    const recipe = await ops.createNode("Pancakes");
    const flour = await ops.addNewChild(recipe, "Flour");
    await ops.addNewChild(recipe, "Milk");
    await ops.addNewChild(recipe, "Egg", 1);
    expect(texts(recipe)).toEqual(["Flour", "Egg", "Milk"]);
    written();
    await ops.moveChild(flour.group, 2);
    expect(texts(recipe)).toEqual(["Egg", "Milk", "Flour"]);
    expect(written()).toBe(1);
    await ops.removeFromGroup(flour.group);
    expect(texts(recipe)).toEqual(["Egg", "Milk"]);
    expect(written()).toBe(1);
  });
  it("always finds room, also after many inserts at the same place", async () => {
    const { ops, texts } = setup();
    const p = await ops.createNode("P");
    await ops.addNewChild(p, "first");
    await ops.addNewChild(p, "last");
    for (let i = 0; i < 200; i++) await ops.addNewChild(p, `${i}`, 1);
    const list = texts(p);
    expect(list[0]).toBe("first");
    expect(list[1]).toBe("199");
    expect(list[200]).toBe("0");
    expect(list[201]).toBe("last");
  });
  it("gives every child a fresh key, in one statement, when neighbours tie", async () => {
    const { graph, ops, texts, written } = setup();
    const p = await ops.createNode("P");
    const a = await ops.addNewChild(p, "A");
    const b = await ops.addNewChild(p, "B");
    // Shown for a moment while another device's change arrives: B with A's key.
    const tied = graph.group(b.group);
    const pos = graph.group(a.group).data.pos;
    graph.setConn({ ...tied, data: { ...tied.data, pos }, created_at: "2999-01-01T00:00:00Z" });
    expect(texts(p)).toEqual(["A", "B"]);
    written();
    await ops.addNewChild(p, "X", 1);
    expect(written()).toBe(2); // the node, then all three places
    expect(texts(p)).toEqual(["A", "X", "B"]);
    const keys = graph.children(p).map((m) => m.data.pos);
    expect(new Set(keys).size).toBe(3);
    expect([...keys].sort()).toEqual(keys);
  });
  it("lets one node be in many groups, each with its own order", async () => {
    const { graph, ops, texts } = setup();
    const pancakes = await ops.createNode("Pancakes");
    const bread = await ops.createNode("Bread");
    const flour = await ops.addNewChild(pancakes, "Flour");
    const milk = await ops.addNewChild(pancakes, "Milk");
    await ops.addChild(bread, milk.node);
    await ops.addChild(bread, flour.node);
    expect(texts(pancakes)).toEqual(["Flour", "Milk"]);
    expect(texts(bread)).toEqual(["Milk", "Flour"]);
    expect(graph.parentCount(milk.node)).toBe(2);
    expect(graph.childCount(bread)).toBe(2);
  });
  it("refuses containment cycles and duplicates", async () => {
    const { ops } = setup();
    const a = await ops.createNode("A");
    const b = await ops.addNewChild(a, "B");
    await expect(ops.addChild(b.node, a)).rejects.toThrow(/descendant/);
    await expect(ops.addChild(a, a)).rejects.toThrow(/itself/);
    await expect(ops.addChild(a, b.node)).rejects.toThrow(/already/);
  });
  it("deletes a node everywhere and leaves its children", async () => {
    const { graph, ops } = setup();
    const a = await ops.createNode("A");
    const b = await ops.createNode("B");
    const x = await ops.addNewChild(a, "X");
    await ops.addChild(b, x.node);
    const y = await ops.addNewChild(x.node, "Y");
    await ops.addEdge(x.node, b, { label: "part of" });
    await ops.addView(x.node);
    const view = await ops.addView(a);
    await ops.setSummary(x.node, "Y and Z");
    await ops.setLook(view, x.node, { open: true });
    const z = await ops.addNewChild(x.node, "Z");
    await ops.addEdge(y.node, z.node, { label: "only in X", in: x.node });
    await ops.deleteNode(x.node);
    expect(graph.children(a)).toEqual([]);
    expect(graph.children(b)).toEqual([]);
    expect(graph.viewsOf(x.node)).toEqual([]);
    expect(graph.viewsOf(a).length).toBe(1);
    expect(graph.node(y.node)).toBeDefined();
    expect(graph.parentCount(y.node)).toBe(0);
    expect([...graph.conns.values()]).toEqual([]);
    expect(graph.details.size).toBe(0);
    expect(graph.looks.size).toBe(0);
  });
  it("places a child among all of a group's children, also when only some are loaded", async () => {
    const { ops, fake } = setup();
    const p = await ops.createNode("P");
    for (const t of ["a", "b", "c", "d"]) await ops.addNewChild(p, t);
    // Another panel that loaded only the first two children.
    const graph = new Graph();
    applyBundle(graph, await fake.loader.level([p], 0, 2));
    const other = new Ops(graph, fake.db);
    await other.addNewChild(p, "end");
    await other.addNewChild(p, "second", 1);
    const all = new Graph();
    applyBundle(all, await fake.loader.level([p], 0, 100));
    const texts = all.children(p).map((g) => all.node(g.data.to).data.text);
    expect(texts).toEqual(["a", "second", "b", "c", "d", "end"]);
    check = undefined; // the first graph didn't see the other panel's writes
  });
  it("keeps a look per view and node, the same in every group, and no row for the default look", async () => {
    const { graph, ops, written } = setup();
    const food = await ops.createNode("Food");
    const breakfast = await ops.addNewChild(food, "Breakfast");
    const dinner = await ops.addNewChild(food, "Dinner");
    const eggs = await ops.addNewChild(breakfast.node, "Eggs");
    await ops.addChild(dinner.node, eggs.node);
    const v1 = await ops.addView(food);
    const v2 = await ops.addView(food, "Food, in detail");
    await ops.setLook(v1, eggs.node, { open: true, layout: "horizontal" });
    expect(graph.look(v1, eggs.node)).toMatchObject({ node: eggs.node, open: true, layout: "horizontal" });
    // The same node in another view looks as it did.
    expect(graph.look(v2, eggs.node)).toBeUndefined();
    written();
    await ops.setLook(v1, eggs.node, { open: false });
    expect(written()).toBe(1);
    await ops.setLook(v1, eggs.node, { layout: "vertical" });
    expect(graph.look(v1, eggs.node)).toBeUndefined();
    expect(graph.looks.size).toBe(0);
    await ops.setLook(v2, eggs.node, { x: 10, y: 20 });
    await ops.removeView(v2);
    expect(graph.looks.size).toBe(0);
    expect(graph.viewsOf(food).map((v) => v.id)).toEqual([v1]);
    // How its prototype shows is kept per view too, and back at the default it needs no row.
    await ops.setLook(v1, eggs.node, { proto_open: true, proto_h: 400, proto_zoom: 80 });
    expect(graph.look(v1, eggs.node)).toMatchObject({ open: false, proto_open: true, proto_h: 400, proto_zoom: 80 });
    await ops.setLook(v1, eggs.node, { proto_open: false, proto_h: null });
    expect(graph.look(v1, eggs.node)).toMatchObject({ proto_zoom: 80 });
    await ops.setLook(v1, eggs.node, { proto_zoom: null });
    expect(graph.look(v1, eggs.node)).toBeUndefined();
  });
  it("keeps a moved child's look in every view, without its old free position and width", async () => {
    const { graph, ops } = setup();
    const a = await ops.createNode("A");
    const b = await ops.createNode("B");
    const x = await ops.addNewChild(a, "X");
    const v1 = await ops.addView(a);
    const v2 = await ops.addView(a);
    const v3 = await ops.addView(a);
    await ops.setLook(v1, x.node, { open: true, x: 5, y: 5, w: 300 });
    await ops.setLook(v2, x.node, { layout: "free" });
    await ops.setLook(v3, x.node, { x: 1, y: 2 });
    await ops.moveToGroup(x.group, b);
    expect(graph.look(v1, x.node)).toMatchObject({ open: true, x: null, y: null, w: null });
    expect(graph.look(v2, x.node)).toMatchObject({ open: false, layout: "free" });
    expect(graph.look(v3, x.node)).toBeUndefined();
    expect(graph.looks.size).toBe(2);
    // Taking it out of a group keeps its looks: they belong to the node.
    const [inB] = graph.children(b);
    await ops.removeFromGroup(inB.id);
    expect(graph.looks.size).toBe(2);
  });
  it("names a view, or says it has no name, with its root's title cut short", async () => {
    const { graph, ops } = setup();
    const root = await ops.createNode("Recipes from the whole family, collected over the years");
    const view = await ops.addView(root);
    expect(viewTitle(graph, view)).toBe("(no view name) · Recipes from the whole family…");
    await ops.updateView(view, { name: "  Overview " });
    expect(graph.views.get(view).data.name).toBe("Overview");
    expect(viewTitle(graph, view)).toBe("Overview");
    await ops.updateView(view, { name: "" });
    expect(graph.views.get(view).data).toEqual({ root });
  });
  it("gets another root, keeping its name and looks", async () => {
    const { graph, ops } = setup();
    const food = await ops.createNode("Food");
    const pasta = await ops.addNewChild(food, "Pasta");
    const sauce = await ops.addNewChild(pasta.node, "Sauce");
    const view = await ops.addView(food, "Kitchen");
    await ops.setLook(view, sauce.node, { open: true });
    await ops.updateView(view, { root: pasta.node });
    expect(graph.views.get(view).data).toEqual({ root: pasta.node, name: "Kitchen" });
    expect(graph.viewsOf(food)).toEqual([]);
    expect(graph.look(view, sauce.node)?.open).toBe(true);
  });
  it("gives a node the same look as the root and as a child", async () => {
    const { graph, ops } = setup();
    const food = await ops.createNode("Food");
    const pasta = await ops.addNewChild(food, "Pasta");
    const view = await ops.addView(food);
    const other = await ops.addView(food);
    // Laid out as a child, then opened as the root: the same look.
    await ops.setLook(view, pasta.node, { layout: "horizontal" });
    await ops.updateView(view, { root: pasta.node });
    expect(graph.look(view, pasta.node)?.layout).toBe("horizontal");
    // Changed as the root, back to the old root: it shows as a child with the change.
    await ops.setLook(view, pasta.node, { layout: "free", arrange: "grid" });
    await ops.updateView(view, { root: food });
    expect(graph.look(view, pasta.node)).toMatchObject({ layout: "free", arrange: "grid" });
    expect(graph.look(other, pasta.node)).toBeUndefined();
    // Back to the default: no row.
    await ops.setLook(view, pasta.node, { layout: "vertical", arrange: null });
    expect(graph.look(view, pasta.node)).toBeUndefined();
  });
});
describe("a node's colour", () => {
  it("is saved on the node, shows in outlines, and comes off with null", async () => {
    const { graph, ops, fake } = setup();
    const root = await ops.createNode("Login");
    await ops.updateNode(root, { color: "red" });
    expect(graph.node(root).data.color).toBe("red");
    expect(outline(graph, root).replace(/#[0-9a-f]{8}/g, "#id")).toBe("Login (#id; colour: red)");
    const read = new Graph();
    applyBundle(read, await fake.loader.get([root]));
    expect(read.node(root).data.color).toBe("red");
    await ops.updateNode(root, { color: null });
    expect(graph.node(root).data).toEqual({ text: "Login" });
  });
});
describe("tags", () => {
  it("label nodes; a tag of a single set replaces the node's other one", async () => {
    const { graph, ops } = setup();
    const login = await ops.createNode("Login");
    const status = await ops.createTagSet({ name: "Status", single: true });
    const planned = await ops.createTag({ name: "Planned", tag_set: status, color: "blue" });
    const done = await ops.createTag({ name: "Done", tag_set: status, color: "green" });
    const breaking = await ops.createTag({ name: "breaking" });
    await ops.tag(login, planned);
    await ops.tag(login, breaking);
    await ops.tag(login, done);
    expect(graph.tagsOf(login).map((t) => t.name)).toEqual(["Done", "breaking"]);
    await ops.untag(login, breaking);
    expect(graph.tagsOf(login).map((t) => t.name)).toEqual(["Done"]);
  });
  it("keep their names unique in any case, and stay when their set goes", async () => {
    const { graph, ops } = setup();
    const status = await ops.createTagSet({ name: "Status" });
    const idea = await ops.createTag({ name: "Idea", tag_set: status });
    await expect(ops.createTag({ name: "idea" })).rejects.toThrow('There is a tag "Idea" already');
    await expect(ops.createTagSet({ name: "STATUS" })).rejects.toThrow('There is a set "Status" already');
    await ops.updateTag(idea, { name: "Ideas", description: "Not planned yet" });
    await ops.deleteTagSet(status);
    expect(graph.tags.get(idea)).toMatchObject({ name: "Ideas", tag_set: null, description: "Not planned yet" });
  });
  it("go from every node with the tag or the node", async () => {
    const { graph, ops } = setup();
    const a = await ops.createNode("A");
    const b = await ops.createNode("B");
    const tag = await ops.createTag({ name: "mobile" });
    const other = await ops.createTag({ name: "web" });
    await ops.tag(a, tag);
    await ops.tag(b, tag);
    await ops.tag(b, other);
    await ops.deleteTag(tag);
    expect(graph.tagsOf(a)).toEqual([]);
    expect(graph.tagsOf(b).map((t) => t.name)).toEqual(["web"]);
    await ops.deleteNode(b);
    expect(graph.nodeTags.size).toBe(0);
  });
  it("show in outlines, set by set in order, and come with bundles", async () => {
    const { graph, ops, fake } = setup();
    const root = await ops.createNode("Login");
    const loose = await ops.createTag({ name: "breaking" });
    const status = await ops.createTagSet({ name: "Status", single: true });
    await ops.tag(root, loose);
    await ops.tag(root, await ops.createTag({ name: "Planned", tag_set: status }));
    expect(outline(graph, root).replace(/#[0-9a-f]{8}/g, "#id")).toBe("Login (#id; tags: Planned, breaking)");
    const read = new Graph();
    applyBundle(read, await fake.loader.get([root]));
    expect(
      read
        .tagsOf(root)
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Planned", "breaking"]);
  });
});
describe("applying a proposal", () => {
  it("marks each change done, stops at one that fails, and continues there or skips it", async () => {
    const { db } = fakeDb();
    const changes = ["a", "b", "c"].map((title) => ({ tool: "x", args: {}, title }));
    await db.insert(TABLES.proposals, { id: "p", title: "Three", changes });
    const ran = [];
    let failing = "b";
    const run = async (c) => {
      if (c.title === failing) throw new Error(`no ${c.title}`);
      ran.push(c.title);
    };
    const row = async () => (await db.select(TABLES.proposals, { id: "p" }))[0];
    await expect(applyProposal(db, "p", run)).rejects.toThrow("1 of 3 done; stopped at 2: no b");
    expect((await row()).changes.map((c) => [c.done ?? false, c.error ?? null])).toEqual([
      [true, null],
      [false, "no b"],
      [false, null],
    ]);
    // Accepted again, it doesn't make the first one again.
    await expect(applyProposal(db, "p", run)).rejects.toThrow("stopped at 2");
    expect(ran).toEqual(["a"]);
    // Skipped, the rest is made and the proposal is gone.
    await applyProposal(db, "p", run, true);
    expect(ran).toEqual(["a", "c"]);
    expect(await row()).toBeUndefined();
    // Fixed in the meantime, it goes on from the change that failed.
    await db.insert(TABLES.proposals, { id: "q", title: "Again", changes });
    failing = "c";
    await expect(applyProposal(db, "q", run)).rejects.toThrow("stopped at 3");
    failing = "";
    await applyProposal(db, "q", run);
    expect(ran).toEqual(["a", "c", "a", "b", "c"]);
  });
  it("runs only once at a time", async () => {
    const { db } = fakeDb();
    await db.insert(TABLES.proposals, { id: "p", title: "One", changes: [{ tool: "x", args: {} }] });
    let release = () => {};
    const slow = () => new Promise((done) => (release = done));
    const first = applyProposal(db, "p", slow);
    await new Promise((done) => setTimeout(done, 0));
    await expect(applyProposal(db, "p", slow)).rejects.toThrow(/being applied already/);
    release();
    await first;
  });
});
describe("reordering a whole group", () => {
  it("needs every child, once", async () => {
    const { graph, ops, texts } = setup();
    const p = await ops.createNode("P");
    const [a, b, c] = [await ops.addNewChild(p, "A"), await ops.addNewChild(p, "B"), await ops.addNewChild(p, "C")];
    await expect(ops.reorder(p, [c.node, a.node])).rejects.toThrow(/leaves out 1 of the children: "B"/);
    await expect(ops.reorder(p, [c.node, a.node, a.node])).rejects.toThrow(/twice/);
    await ops.reorder(p, [c.node, a.node, b.node]);
    expect(texts(p)).toEqual(["C", "A", "B"]);
    expect(graph.children(p)).toHaveLength(3);
  });
});
describe("edges", () => {
  it("hold wherever their nodes are, or only in one group", async () => {
    const { graph, ops } = setup();
    const pancakes = await ops.createNode("Pancakes");
    const bread = await ops.createNode("Bread");
    const grain = await ops.createNode("Grain");
    const flour = await ops.addNewChild(pancakes, "Flour");
    const milk = await ops.addNewChild(pancakes, "Milk");
    await ops.addChild(bread, flour.node);
    await ops.addChild(bread, milk.node);
    await ops.addEdge(flour.node, grain, { label: "is a" });
    const mixed = await ops.addEdge(flour.node, milk.node, { label: "mixed with", in: pancakes });
    expect(graph.relations(flour.node).map((e) => e.data.label)).toEqual(["is a"]);
    expect(graph.edges(pancakes).map((e) => e.data.label)).toEqual(["mixed with"]);
    expect(graph.edgesBetween(pancakes)).toHaveLength(1);
    expect(graph.edgesBetween(bread)).toHaveLength(0);
    await expect(ops.addEdge(flour.node, grain, { in: pancakes })).rejects.toThrow(/both nodes in that group/);
    await expect(ops.addEdge(flour.node, flour.node)).rejects.toThrow(/two different/);
    // Made to hold everywhere, it shows in Bread too.
    await ops.updateEdge(mixed, { in: null });
    expect(graph.edgesBetween(bread)).toHaveLength(1);
  });
  it("only for a group go when a node leaves it; the others stay", async () => {
    const { graph, ops } = setup();
    const p = await ops.createNode("P");
    const q = await ops.createNode("Q");
    const a = await ops.addNewChild(p, "A");
    const b = await ops.addNewChild(p, "B");
    await ops.addEdge(a.node, b.node, { label: "here", in: p });
    await ops.addEdge(a.node, b.node, { label: "always" });
    await ops.moveToGroup(a.group, q);
    expect(graph.edgesOf(a.node).map((e) => e.data.label)).toEqual(["always"]);
    expect([...graph.conns.values()].filter((c) => c.data.type === "edge")).toHaveLength(1);
  });
  it("have types: nodes under one Edge types node, made once", async () => {
    const { graph, ops } = setup();
    const coffee = await ops.createNode("Coffee");
    const sleep = await ops.createNode("Insomnia");
    const causes = await ops.addEdgeType("causes");
    const types = await ops.edgeTypes();
    expect(graph.isView(types)).toBe(true);
    expect(graph.children(types).map((c) => c.data.to)).toEqual([causes]);
    const id = await ops.addEdgeType("is a");
    expect(await ops.edgeTypes()).toBe(types);
    expect(graph.children(types).map((c) => c.data.to)).toEqual([causes, id]);
    await ops.addEdge(coffee, sleep, { relation: causes, label: "sometimes" });
    const text = outline(graph, coffee).replace(/#[0-9a-f]{8}/g, "#id");
    expect(text).toContain("--causes · sometimes--> Insomnia (#id)");
  });
});
describe("edges for the AI", () => {
  /** A group with three children and an edge type, and what concepts_connect reads with, fresh for each call. */
  async function map() {
    const { ops, fake } = setup();
    check = undefined; // concepts_connect writes through graphs of its own.
    const plan = await ops.createNode("Plan");
    const a = (await ops.addNewChild(plan, "A")).node;
    const b = (await ops.addNewChild(plan, "B")).node;
    const c = (await ops.addNewChild(plan, "C")).node;
    const outside = await ops.createNode("Outside");
    await ops.addEdgeType("blocks");
    const source = {
      resolve: async (name) => name,
      slice: async (ids) => {
        const graph = new Graph();
        applyBundle(graph, await fake.loader.get(ids));
        for (const row of await fake.db.select(TABLES.groups, { child: ids })) {
          applyRow(graph, TABLES.groups, "insert", row);
        }
        return { graph, ops: new Ops(graph, fake.db) };
      },
      types: async () => {
        const graph = fake.load();
        const [settings] = await fake.db.select(TABLES.settings);
        const text = (id) => graph.node(id).data.text;
        const types = graph.children(settings.edge_types).map((g) => g.data.to);
        return types.map((id) => ({ id, text: text(id), meaning: null }));
      },
      select: (table, filter) => fake.db.select(table, filter),
      propose: async (title, changes) => {
        proposed.push({ title, changes });
        return `Proposed: ${title}`;
      },
    };
    const proposed = [];
    const edges = () => [...fake.load().conns.values()].flatMap((e) => (e.data.type === "edge" ? [e.data] : []));
    const run = (args) => connect(source, args);
    return { ops, plan, a, b, c, outside, fake, source, edges, run, proposed };
  }
  const ids = (text) => text.replace(/#[0-9a-f]{8}/g, "#id");
  it("adds many at once, saying for each what it did and where it holds", async () => {
    const { plan, a, b, c, outside, edges, run } = await map();
    const text = await run({
      type: "blocks",
      in: plan,
      edges: [
        { from: a, to: b, label: "first" },
        { from: b, to: c },
        { from: a, to: outside },
        { from: a, to: c, in: undefined, type: "nope" },
      ],
    });
    const lines = text.replace(/#[0-9a-f]{8}/g, "#id").split("\n");
    expect(lines[0]).toBe("4 edges, 2 failed:");
    expect(lines[1]).toBe("1. added A (#id) --blocks · first--> B (#id), only in Plan");
    expect(lines[2]).toBe("2. added B (#id) --blocks--> C (#id), only in Plan");
    expect(lines[3]).toMatch(/^3\. failed .*Outside \(#id\) is not in Plan/);
    expect(lines[4]).toMatch(/^4\. failed .*No edge type "nope" \(there are: blocks\)/);
    expect(edges()).toHaveLength(2);
  });
  it("needs a type, and changes the label of an edge that is there instead of adding another", async () => {
    const { a, b, edges, run } = await map();
    await expect(run({ from: a, to: b })).rejects.toThrow(/Give the edge's `type`/);
    await run({ from: a, to: b, type: "blocks", label: "first" });
    expect(await run({ from: a, to: b, type: "blocks", label: "first" })).toMatch(/^already there/);
    expect(await run({ from: a, to: b, type: "blocks" })).toMatch(/^changed the label: A .*--blocks--> B/);
    expect(edges().map((e) => e.label)).toEqual([undefined]);
    // Made once, the new type is reused by the next edge.
    await run({
      newType: true,
      type: "causes",
      edges: [
        { from: a, to: b },
        { from: b, to: a },
      ],
    });
    expect(new Set(edges().map((e) => e.relation)).size).toBe(2);
  });
  it("says why it removed nothing, and previews without doing anything", async () => {
    const { plan, a, b, edges, run } = await map();
    await run({ from: a, to: b, type: "blocks" });
    const none = await run({ from: a, to: b, in: plan, remove: true });
    expect(none).toMatch(/^removed nothing, none matched: from A .* there is: A .*--blocks--> B .*, everywhere$/);
    expect(await run({ from: b, to: a, remove: true })).toMatch(/only the other way/);
    expect(await run({ from: a, to: b, remove: true, preview: true })).toMatch(/^would remove A/);
    expect(await run({ from: a, to: b, type: "new", newType: true, preview: true })).toMatch(/^would make the type/);
    expect(edges()).toHaveLength(1);
    expect(await run({ from: a, to: b, remove: true })).toMatch(/^removed A/);
    expect(edges()).toHaveLength(0);
  });
  it("moves an edge to hold only in a group, or everywhere again", async () => {
    const { plan, a, b, outside, edges, run } = await map();
    await run({ from: a, to: b, type: "blocks", label: "first" });
    const moved = ids(await run({ from: a, to: b, newIn: plan }));
    expect(moved).toBe("moved: A (#id) --blocks · first--> B (#id), only in Plan");
    expect(edges()[0].in).toBe(plan);
    expect(await run({ from: a, to: b, newIn: plan })).toMatch(/^already holds only in Plan/);
    await run({ from: a, to: b, newIn: "everywhere" });
    expect(edges()[0].in).toBeUndefined();
    await run({ from: a, to: outside, type: "blocks" });
    await expect(run({ from: a, to: outside, newIn: plan })).rejects.toThrow(/Outside .* is not in Plan/);
    await expect(run({ from: b, to: a, newIn: plan })).rejects.toThrow(/No edge like that to move/);
  });
  it("retypes edges, dropping one whose pair has the new type already, and proposes many", async () => {
    const { ops, plan, a, b, c, edges, run, proposed } = await map();
    await run({
      type: "blocks",
      edges: [
        { from: a, to: b },
        { from: b, to: c },
      ],
    });
    await run({ from: a, to: b, type: "causes", newType: true });
    const text = ids(await run({ type: "blocks", retype: "causes", in: plan }));
    expect(text).toContain('Gave 2 edges the type "causes":');
    expect(text).toContain("dropped, as A (#id) --causes--> B (#id), everywhere is there");
    expect(text).toContain("changed B (#id) --causes--> C (#id), everywhere");
    expect(edges()).toHaveLength(2);
    // More than a few: a proposal, with the edges' ids.
    const nodes = [];
    for (let i = 0; i < 12; i++) nodes.push(await ops.createNode(`N${i}`));
    await run({ type: "causes", edges: nodes.slice(1).map((n, i) => ({ from: nodes[i], to: n })) });
    expect(await run({ type: "causes", retype: "after", newType: true })).toBe(
      'Proposed: Change the type of 13 edges from "causes" to "after"',
    );
    expect(proposed[0].changes[0]).toMatchObject({ tool: "retype", args: { to: "after", newType: true } });
    expect(proposed[0].changes[0].args.edges.length).toBe(13);
  });
  it("checks a group for what might be wrong", async () => {
    const { ops, fake, source, plan, a, b, c, run } = await map();
    const pairs = [
      [a, b],
      [b, c],
      [c, a],
      [b, a],
    ];
    await run({ type: "blocks", edges: pairs.map(([from, to]) => ({ from, to })) });
    await ops.addNewChild(plan, "a");
    const types = await source.types();
    const text = ids(await checkGroup(fake.loader, plan, types, ["blocks"]));
    expect(text).toContain('Cycles of "blocks"');
    expect(text).toMatch(/ {2}(A|B|C) \(#id\) → \w \(#id\) → \w \(#id\) → \1 \(#id\)\n/);
    expect(text).toContain("Edges both ways with the same type");
    expect(text).toContain("Children with the same title");
    expect(ids(await checkGroup(fake.loader, a, types))).toContain("Nothing found.");
  });
  it("follows edges step by step and puts what it reached in their order", async () => {
    const { fake, source, a, b, c, outside, run } = await map();
    const pairs = [
      [a, b],
      [b, c],
      [a, c],
      [c, outside],
    ];
    await run({ type: "blocks", edges: pairs.map(([from, to]) => ({ from, to })) });
    const types = await source.types();
    const text = ids(await follow(fake.loader, a, types, { type: types[0].id }));
    expect(text.split("\n")).toEqual([
      "A (#id)",
      "- --blocks--> B (#id)",
      "  - --blocks--> C (#id) (shown elsewhere)",
      "- --blocks--> C (#id)",
      "  - --blocks--> Outside (#id)",
      "In the edges' order (each before the nodes its edges point to):",
      "1. A (#id)",
      "2. B (#id)",
      "3. C (#id)",
      "4. Outside (#id)",
    ]);
    const back = ids(await follow(fake.loader, c, types, { direction: "in", depth: 1 }));
    expect(back).toContain("- <--blocks-- B (#id)");
    expect(back).toContain("may lead further");
  });
  it("lists a group's edges by where they hold", async () => {
    const { plan, a, b, c, outside, fake, run } = await map();
    await run({
      type: "blocks",
      edges: [
        { from: a, to: b, in: plan },
        { from: b, to: c },
        { from: c, to: outside },
      ],
    });
    const text = (await groupEdges(fake.loader, plan)).replace(/#[0-9a-f]{8}/g, "#id");
    expect(text).toBe(
      [
        "Edges in Plan (#id), children 1–3 of 3:",
        "Only in this group (1):",
        "  A (#id) --blocks--> B (#id)",
        "Between its children, holding everywhere (1):",
        "  B (#id) --blocks--> C (#id)",
        "To nodes outside it, holding everywhere (1):",
        "  C (#id) --blocks--> Outside (#id)",
      ].join("\n"),
    );
  });
});
describe("outline", () => {
  it("writes children, edges, counts, and shared nodes once", async () => {
    const { ops } = setup();
    const root = await ops.createNode("Kitchen");
    const pancakes = await ops.addNewChild(root, "Pancakes");
    const bread = await ops.addNewChild(root, "Bread");
    const flour = await ops.addNewChild(pancakes.node, "Flour");
    const milk = await ops.addNewChild(pancakes.node, "Milk");
    await ops.addChild(bread.node, flour.node);
    const wheat = await ops.addNewChild(flour.node, "Wheat");
    await ops.addEdge(flour.node, milk.node, { label: "mixed with", in: pancakes.node });
    await ops.addEdge(wheat.node, bread.node, { label: "used for" });
    await ops.addEdge(flour.node, milk.node);
    await ops.updateNode(pancakes.node, { unordered: true });
    const text = outline(ops.graph, root).replace(/#[0-9a-f]{8}/g, "#id");
    expect(text).toBe(
      [
        "Kitchen (#id; 2 inside)",
        "- Pancakes (#id; order doesn't matter; 2 inside)",
        "  - Flour (#id; 1 inside; in 2 groups)",
        "    --> Milk (#id)",
        "    - Wheat (#id)",
        "      --used for--> Bread (#id)",
        "  - Milk (#id)",
        "    <-- Flour (#id)",
        "  Edges only here:",
        "    Flour --mixed with--> Milk",
        "- Bread (#id; 1 inside)",
        "  <--used for-- Wheat (#id)",
        "  - Flour (#id, shown above)",
      ].join("\n"),
    );
  });
  it("says how many threads changed or mentioned a node", async () => {
    const { graph, ops } = setup();
    const root = await ops.createNode("Kitchen");
    graph.counts.set(root, { ...graph.counts.get(root), threads: 2 });
    expect(outline(graph, root).replace(/#[0-9a-f]{8}/g, "#id")).toBe("Kitchen (#id; 2 threads)");
  });
  it("shortens long texts to their first sentence", () => {
    expect(shortText("Short.")).toBe("Short.");
    expect(shortText("First one. Then more words here.\nAnd a line.")).toBe("First one.");
    expect(hiddenWords("Short.")).toBe(0);
    expect(hiddenWords("First one. Then more words here.\nAnd a line.")).toBe(7);
  });
});
describe("reading for the AI", () => {
  /** A book: chapters with long paragraphs, one chapter with a summary. */
  async function book() {
    const { ops, fake } = setup();
    const root = await ops.createNode("Book");
    const long = (n) => `Paragraph ${n} starts here. ${"Many more words follow in it. ".repeat(20)}`;
    const chapters = [];
    for (let c = 1; c <= 3; c++) {
      const chapter = await ops.addNewChild(root, `Chapter ${c}`);
      chapters.push(chapter.node);
      for (let p = 1; p <= 4; p++) await ops.addNewChild(chapter.node, long(c * 10 + p));
    }
    await ops.setSummary(chapters[1], "Chapter two in short.");
    return { root, chapters, fake };
  }
  it("shows titles and summaries first and stops at the budget", async () => {
    const { root, fake } = await book();
    const text = await readOutline(fake.loader, root, 200);
    expect(text).toContain("- Chapter 1 (#");
    expect(text).toContain("4 inside, not opened");
    expect(text).toContain("Summary: Chapter two in short.");
    // Chapter 1's paragraphs fit as first sentences; Chapter 3 shows only the start of what is inside it.
    expect(text).toContain("- Paragraph 11 starts here. (#");
    const inside = "Inside: Paragraph 31 starts here. · Paragraph 32 starts here. · Paragraph 33 starts here. · …";
    expect(text).toContain(inside);
    expect(text).not.toContain("Many more words");
    expect(text).toContain("(Not opened or shortened");
  });
  it("opens groups and shows long texts in full as the budget grows", async () => {
    const { root, fake } = await book();
    const medium = await readOutline(fake.loader, root, 1500);
    // Every chapter opened; the budget left shows the first paragraphs in full, the last ones shortened.
    expect(medium).not.toContain("not opened");
    expect(medium).toMatch(/- Paragraph 11 starts here\. Many more words/);
    expect(medium).toMatch(/- Paragraph 34 starts here\. \(#\w+; \+\d+ words\)/);
    const large = await readOutline(fake.loader, root, 20000);
    expect(large).toContain("Many more words");
    expect(large).not.toContain("not opened");
    expect(large).not.toContain("(Not opened or shortened");
  });
  it("pages through a group's children", async () => {
    const { chapters, fake } = await book();
    const text = await childrenOutline(fake.loader, chapters[0], 1, 2);
    expect(text.split("\n")[0]).toMatch(/^2–3 of the 4 children of #/);
    expect(text).toContain("2. Paragraph 12 starts here.");
    expect(text).toContain("… 1 more: offset 3");
  });
  it("marks an outdated summary", async () => {
    const { graph, ops } = setup();
    const n = await ops.createNode("N");
    await ops.setSummary(n, "old");
    graph.setDetail({ ...graph.summary(n), data: { ...graph.summary(n).data, outdated: true } });
    expect(outline(graph, n)).toContain("Summary (outdated, read the parts instead): old");
    check = undefined;
  });
});
