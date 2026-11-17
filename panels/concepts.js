// The concept map panel: views and proposals on the side, a view's nodes in the middle, and the node you pick on the
// right (its text, summary, tags, edges, places, threads, picture or prototype page). It reads and writes the user's
// tables itself, as the signed-in user, with the same shared code the backend uses (shared/graph.js, shared/ops.js) on
// the Supabase session layr gives it (layr__supabase_session); accepting a proposal runs on the backend (the PC).
// Rebuilt from layr_code's plugins/concepts/panels (view.tsx, store.ts, drag.tsx): each node's children laid out per
// view (vertical, horizontal, or free on a canvas with automatic arrangements), several rows selected at once, rows
// dragged between groups, Markdown in node texts, prototypes folded out under their nodes, tags, edges, and links to
// the pipeline and Claude threads. The page is built anew on each change and morphed into place (dom.js).
import { firstLine, Graph } from "../shared/graph.js";
import { layrLink, layrMarkdownLink, parseLayrLink, prototypeLink } from "../shared/links.js";
import { Ops } from "../shared/ops.js";
import { edgeName, nodeLabel, shortId, viewRootLabel } from "../shared/outline.js";
import { readOutline } from "../shared/read.js";
import { applyBundle, applyRow, TABLES, TAG_COLORS } from "../shared/rows.js";
import { createSupabase } from "../shared/supabase.js";
import { ask, confirmIt, isOpen as modalOpen, modal, pick, pickNode, showText } from "./dialogs.js";
import { h, icon, iconButton, morphChildren } from "./dom.js";
import { dragFrom, targetAt } from "./drag.js";
import { editAction, rowAction, textToSave } from "./keys.js";
import { layOut } from "./layout.js";
import { hasMarkdown, renderMarkdown } from "./markdown.js";
import { showMenu } from "./menu.js";
import {
  acceptMove,
  AREA,
  AREA_MIN,
  areaSize,
  clickSelect,
  dimmed,
  edgesHere,
  edgeText,
  extendSelection,
  firstPlace,
  fitAll,
  isTypeBadge,
  LAYOUT_INFO,
  otherEnd,
  segment,
  sortTypes,
  step,
  WIDTH,
  zoomAt,
} from "./model.js";
import { bulkMenuItems, edgeItems, layoutOf, nodeMenuItems, tagItems, tagPillItems, useOrderOf } from "./nodemenu.js";
import { cssReady, protoEmbed } from "./proto.js";
import { manageTags } from "./tagsui.js";

const PAGE = 100;
/** Children a free layout loads at most (they are all drawn). */
const FREE_MAX = 5000;
const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------- state

await layr.ready;
// The panel's tests hand it tables of their own (test/harness): the same calls, in memory.
const supabase = window.conceptsTestTables
  ? { tables: window.conceptsTestTables, storage: window.conceptsTestStorage }
  : createSupabase({ session: () => layr.tools.run("supabase_session", {}, { plugin: "layr" }) });
const { tables, storage } = supabase;
const graph = new Graph();
const ops = new Ops(graph, tables, () => schedule());

const saved = layr.info.state ?? {};
const S = {
  mode: "loading", // loading | signedOut | error | ready
  error: "",
  viewId: saved.view ?? null,
  root: saved.root ?? null,
  selected: saved.selected ?? null, // the node whose details show
  side: saved.side ?? true,
  summaries: saved.summaries ?? true,
  tagFilter: Array.isArray(saved.tags) ? saved.tags : [], // tags whose nodes show as usual, the others dimmed
  lastType: saved.lastType ?? null, // the edge type used last: first in the list
  spots: saved.spots ?? {}, // pan and zoom of a root laid out freely, by `<view>/<root>`
  scrolls: saved.scrolls ?? {}, // where the view and its free layouts' scroll areas were scrolled, by `<view>/<root>`
  views: [],
  proposals: [],
  unplaced: { nodes: [], total: 0 },
  crumbs: [], // the groups the root is in
  path: [], // one way down to the root, from a view's root or a top node: the groups above it, outermost first
  back: Array.isArray(saved.back) ? saved.back.slice(-50) : [], // where Back goes: [{view, root}], the last first
  query: "",
  hits: null,
  types: [],
  adding: null, // {parent, index}: the row where a new node is typed
  adderText: "",
  editing: null, // the row whose text is typed in: a group conn, or "root" for the root's title
  cursor: null, // the row the keys work on while nothing is typed (a group conn)
  selection: [], // rows chosen with Ctrl or Shift+click, Shift+↑↓ or Select (group conns)
  anchor: null, // where Shift+click ranges start
  connecting: null, // {from: [nodes]}: connecting by clicking the other end
  editingEdge: null, // `<edge> <node>`: an edge chip whose label is typed in
  focus: null, // the row to type in after the next render
  pictures: new Map(), // node → {row, url}
  pages: new Map(), // prototype node → html (the details)
  threads: new Map(), // node → thread rows
  sizes: new Map(), // free layouts: measured box of each child, by group conn
  generated: new Map(), // free layouts arranged automatically: parent → Map(group conn → {x, y})
  plugins: { pipeline: false, claude: false }, // other plugins whose tools this panel can call
};
const narrow = () => window.innerWidth < 640;
if (narrow() && saved.side === undefined) S.side = false;

const remember = () =>
  void layr.panel
    .setState({
      view: S.viewId,
      root: S.root,
      selected: S.selected,
      side: S.side,
      summaries: S.summaries,
      tags: S.tagFilter,
      lastType: S.lastType,
      spots: S.spots,
      scrolls: S.scrolls,
      back: S.back,
    })
    .catch(() => {});
let rememberTimer;
const rememberSoon = () => {
  clearTimeout(rememberTimer);
  rememberTimer = setTimeout(remember, 400);
};

// ---------------------------------------------------------------- reads

const db = {
  view: (view) => tables.rpc("view", { view_id: view, page_size: PAGE }),
  level: (parents, skip = 0, size = PAGE) => tables.rpc("level", { parents, skip, page_size: size }),
  get: (ids) => tables.rpc("get", { ids }),
  search: (q, max = 30) => tables.rpc("search", { q, max_hits: max }),
  where: (id) => tables.rpc("where", { node_id: id }),
  tagCounts: () => tables.rpc("tag_counts", {}),
};
/** The plugin's read functions, for outlines made the way the AI reads (shared/read.js). */
const loader = { get: db.get, level: db.level, where: db.where };

/** Load the nodes `ids` that aren't loaded yet (an edge's other end, its type). */
async function need(ids) {
  const missing = [...new Set(ids.filter((id) => id && !graph.node(id)))];
  if (missing.length) applyBundle(graph, { ...(await db.get(missing)), edges: [] });
}

/** Edges' other ends and types among what is loaded. */
const edgeEnds = () =>
  [...graph.conns.values()]
    .filter((c) => c.data.type === "edge")
    .flatMap((c) => [c.data.from, c.data.to, c.data.relation]);

async function loadTags() {
  const [tags, sets] = await Promise.all([tables.select(TABLES.tags), tables.select(TABLES.tagSets)]);
  for (const row of sets) applyRow(graph, TABLES.tagSets, "insert", row);
  for (const row of tags) applyRow(graph, TABLES.tags, "insert", row);
}

async function loadSide() {
  const [views, proposals, unplaced] = await Promise.all([
    tables.select(TABLES.views),
    tables.select(TABLES.proposals),
    tables.rpc("unplaced", { max_nodes: 50 }),
  ]);
  for (const row of views) applyRow(graph, TABLES.views, "insert", row);
  await need(views.map((v) => v.root));
  S.views = views;
  S.proposals = proposals.sort((a, b) => a.created_at.localeCompare(b.created_at));
  S.unplaced = unplaced;
}

/** The children of `node` that are open in the view, deeper too, until all of them are loaded. */
async function loadOpen(nodes, depth = 0) {
  const open = nodes.filter((n) => graph.node(n) && isOpen(n) && graph.childCount(n) && !graph.expanded.has(n));
  if (open.length && depth < 12) applyBundle(graph, await db.level(open));
  const next = nodes.filter((n) => isOpen(n)).flatMap((n) => graph.children(n).map((g) => g.data.to));
  if (next.length && depth < 12) await loadOpen([...new Set(next)], depth + 1);
}

/** Everything again: the side, and the view (or node) shown with what is open in it. */
async function reload() {
  graph.clear();
  await Promise.all([loadSide(), loadTags()]);
  if (!S.viewId || !graph.views.has(S.viewId)) S.viewId = sortedViews()[0]?.id ?? null;
  const view = S.viewId ? graph.views.get(S.viewId) : null;
  if (view && (!S.root || S.root === view.data.root)) {
    S.root = view.data.root;
    applyBundle(graph, await db.view(S.viewId));
  } else if (S.root) {
    applyBundle(graph, await db.get([S.root]));
    if (!graph.node(S.root)) S.root = view?.data.root ?? null;
    else applyBundle(graph, await db.level([S.root]));
  }
  if (S.root) await loadOpen(graph.children(S.root).map((g) => g.data.to)).catch(() => {});
  await need(edgeEnds());
  S.types = (await tables.rpc("types", {})).types ?? [];
  if (S.selected && !graph.node(S.selected)) await need([S.selected]);
  const where = S.root ? await db.where(S.root).catch(() => null) : null;
  S.crumbs = where?.parents ?? [];
  S.path = where ? await pathUp(where) : [];
  const rows = new Set(graph.conns.keys());
  S.selection = S.selection.filter((c) => rows.has(c));
  S.mode = "ready";
}

let reloading = null;
async function refresh() {
  if (reloading) return reloading;
  reloading = (async () => {
    try {
      await reload();
    } catch (error) {
      if (/not signed in/i.test(error.message)) S.mode = "signedOut";
      else if (S.mode !== "ready") {
        S.mode = "error";
        S.error = error.message;
      } else layr.ui.notify(error.message, "error");
    } finally {
      reloading = null;
      schedule();
    }
  })();
  return reloading;
}

/** Load the first children of `node` unless they are loaded. */
async function expand(node) {
  if (graph.expanded.has(node)) return;
  applyBundle(graph, await db.level([node]));
  await need(edgeEnds());
  schedule();
}

/** Every child of `node` (up to FREE_MAX): a free layout draws all of them. */
const loadingAll = new Set();
async function loadAll(node) {
  if (loadingAll.has(node)) return;
  loadingAll.add(node);
  try {
    while (graph.children(node).length < Math.min(FREE_MAX, graph.childCount(node))) {
      const have = graph.children(node).length;
      applyBundle(graph, await db.level([node], have, 1000));
      if (graph.children(node).length === have) break;
    }
    await need(edgeEnds());
  } finally {
    loadingAll.delete(node);
    schedule();
  }
}

/** Run a write; show what went wrong instead of throwing, and read everything again then (the graph may be off). */
async function run(write) {
  try {
    const result = await write();
    schedule();
    return result;
  } catch (error) {
    layr.ui.notify(error.message ?? String(error), "error");
    await refresh();
    return undefined;
  }
}

const sortedViews = () =>
  [...graph.views.values()]
    .filter((v) => graph.node(v.data.root))
    .sort(
      (a, b) =>
        Number(!a.data.name) - Number(!b.data.name) ||
        (a.data.name || nodeLabel(graph, a.data.root)).localeCompare(b.data.name || nodeLabel(graph, b.data.root)) ||
        a.id.localeCompare(b.id),
    );

const label = (node) => nodeLabel(graph, node);
const look = (node) => (S.viewId ? graph.look(S.viewId, node) : undefined);
const isOpen = (node) => !!look(node)?.open;
/** How the view shown looks, for the menus (nodemenu.js). */
const menuCtx = () => ({ look, view: !!S.viewId, pipeline: S.plugins.pipeline, claude: S.plugins.claude });

/** Whether the children of `node` are on screen: it is the root, or open inside a group that shows its children. */
function showing(node, seen = new Set()) {
  if (node === S.root) return true;
  if (seen.has(node) || !graph.node(node) || !isOpen(node)) return false;
  seen.add(node);
  return graph.parents(node).some((g) => showing(g.data.from, seen));
}

/** Change how `node` looks in the view shown. */
const setLook = (node, patch) => (S.viewId ? run(() => ops.setLook(S.viewId, node, patch)) : undefined);

// ---------------------------------------------------------------- actions

async function newView(root) {
  let node = root;
  if (!node) {
    const text = await ask("New view", "", "Root concept, e.g. Recipes");
    if (!text) return;
    node = await run(() => ops.createNode(text));
    if (!node) return;
  }
  const view = await run(() => ops.addView(node));
  if (view) await openView(view);
}

async function renameView(id = S.viewId) {
  const v = id && graph.views.get(id);
  if (!v) return;
  const name = await ask("Name of this view (empty: no name)", v.data.name ?? "", "", { empty: true });
  if (name !== null) await run(() => ops.updateView(v.id, { name }));
}

/** Delete a view (asked); its nodes stay. Shown, another view opens. */
async function deleteView(id = S.viewId) {
  const v = id && graph.views.get(id);
  if (!v) return;
  const name = v.data.name || label(v.data.root);
  const ok = await confirmIt(`Delete the view "${name}"?`, "Its nodes stay, and so do the other views.", "Delete view");
  if (!ok) return;
  await run(() => ops.removeView(id));
  S.back = S.back.filter((b) => b.view !== id);
  if (S.viewId !== id) return void schedule();
  const next = sortedViews()[0];
  S.viewId = null;
  S.root = null;
  if (next) return openView(next.id);
  remember();
  await refresh();
}

/**
 * One way down to a node, from the top (outermost first), given where it is (`db.where`). The map gives none for a
 * view's root (and a view's root is what is shown): then up through its first group, as far as there are groups.
 */
async function pathUp(where) {
  if (where.path?.length || !where.parents?.length) return where.path ?? [];
  const out = [];
  const seen = new Set([S.root]);
  let at = where.parents[0];
  while (at && !seen.has(at.id) && out.length < 30) {
    seen.add(at.id);
    out.unshift(at);
    const up = await db.where(at.id).catch(() => null);
    if (up?.path?.length) {
      out.unshift(...up.path.filter((p) => !seen.has(p.id)));
      break;
    }
    at = up?.parents?.[0];
  }
  return out;
}

/** Before showing another view or root: where the panel is now becomes Back's next step. */
function pushBack(view, root) {
  if (!S.root || (view === S.viewId && root === S.root)) return;
  const last = S.back.at(-1);
  if (last?.view === S.viewId && last?.root === S.root) return;
  S.back = [...S.back, { view: S.viewId, root: S.root }].slice(-50);
}

/** Show `root` in the view `view`, saved as its root (as in layr_code: the view opens there next time). */
async function setRoot(view, root) {
  const v = view && graph.views.get(view);
  if (v && root && v.data.root !== root) await run(() => ops.updateView(v.id, { root }));
  S.viewId = v ? v.id : S.viewId;
  S.root = root;
}

/** Back to the view and root shown before (not up: where the panel was); that view's root is set back too. */
async function goBack() {
  const prev = S.back.at(-1);
  if (!prev) return;
  S.back = S.back.slice(0, -1);
  await setRoot(prev.view && graph.views.has(prev.view) ? prev.view : S.viewId, prev.root);
  S.selected = null;
  clearSelection();
  remember();
  await refresh();
}

async function openView(id) {
  pushBack(id, graph.views.get(id)?.data.root ?? null);
  S.viewId = id;
  S.root = graph.views.get(id)?.data.root ?? null;
  S.selected = null;
  clearSelection();
  if (narrow()) S.side = false;
  remember();
  await refresh();
}

/** Show `node` as the root of the view shown, saved with it; Back goes to the root it had. */
async function focusRoot(node) {
  pushBack(S.viewId, node);
  await setRoot(S.viewId, node);
  S.selected = null;
  clearSelection();
  if (narrow()) S.side = false;
  remember();
  await refresh();
}

/** The groups a node is in (its ×N): choosing one shows it as the root, the node pointed at in it. */
async function showPlaces(node) {
  const where = await db.where(node).catch((e) => void layr.ui.notify(e.message, "error"));
  if (!where) return;
  const chosen = await pick(
    `The groups "${label(node)}" is in`,
    where.parents.map((p) => ({
      label: firstLine(p.text ?? "") || "(empty)",
      description: p.id === S.root ? "shown now" : "",
      value: p.id,
    })),
    { empty: "In no group" },
  );
  if (!chosen) return;
  if (chosen !== S.root) await focusRoot(chosen);
  setTimeout(() => flash(node), 60);
}

/** What a thread's link is: a pipeline task, a Claude thread, an AI chat. */
function threadKind(href) {
  const plugin = parseLayrLink(href ?? "")?.plugin;
  return plugin === "pipeline" ? "Task" : plugin === "claude" ? "Claude thread" : plugin === "chat" ? "AI chat" : "";
}

/** The threads that linked, changed or mentioned a node (its ◷N), latest first: choosing one opens it. */
async function showThreads(node) {
  const rows = await tables.select(TABLES.threads, { node }).catch((e) => void layr.ui.notify(e.message, "error"));
  if (!rows) return;
  rows.sort((a, b) => b.at.localeCompare(a.at));
  const chosen = await pick(
    `Threads of "${label(node)}"`,
    rows.map((t) => ({
      label: t.title || "Untitled thread",
      description: [
        threadKind(t.href),
        [t.linked_at && "linked", t.changed_at && "changed it", t.mentioned_at && "mentioned it"]
          .filter(Boolean)
          .join(", "),
        new Date(t.at).toLocaleString(),
        t.note,
      ]
        .filter(Boolean)
        .join(" · "),
      value: t.id,
    })),
    { empty: "No threads" },
  );
  const row = chosen && rows.find((t) => t.id === chosen);
  if (row?.href) openLink(row.href);
}

/** A node's last 20 changes, newest first: what, what it was, when, and whether you or an AI made it. */
async function showHistory(node) {
  const changes = await tables
    .rpc("history", { node_id: node, max_changes: 20 })
    .catch((e) => void layr.ui.notify(e.message, "error"));
  if (!changes) return;
  await pick(
    `History of "${label(node)}"`,
    changes.map((ch, i) => ({
      label: [ch.what, ch.other_text != null ? `"${ch.other_text || "(empty)"}"` : "", ch.was ? `(was: ${ch.was})` : ""]
        .filter(Boolean)
        .join(" "),
      description: `${new Date(ch.at).toLocaleString()} · ${ch.actor === "ai" ? "AI" : "you"}`,
      value: String(i),
    })),
    { empty: "No changes recorded yet" },
  );
}

/** Show a node found anywhere: inside a group it is in (a view's root first), selected. */
async function reveal(node) {
  const where = await db.where(node);
  const scroll = () => setTimeout(() => flash(node), 60);
  // Already on screen (in the root, or in a group open below it): only picked.
  const shown = where.parents.find((p) => showing(p.id));
  if (shown || node === S.root) {
    await select(node);
    return scroll();
  }
  const roots = new Set(sortedViews().map((v) => v.data.root));
  if (roots.has(node)) {
    await openView(sortedViews().find((v) => v.data.root === node).id);
    return;
  }
  const parent = where.parents.find((p) => roots.has(p.id))?.id ?? where.parents[0]?.id;
  const view = parent && sortedViews().find((v) => v.data.root === parent);
  pushBack(view ? view.id : S.viewId, parent ?? node);
  await setRoot(view ? view.id : S.viewId, parent ?? node);
  S.selected = parent ? node : null;
  clearSelection();
  remember();
  await refresh();
  scroll();
}

/** Point at a node's row for a moment. */
function flash(node) {
  const head = $(`#main .item-head[data-node="${node}"]`);
  if (!head) return;
  head.scrollIntoView({ block: "center" });
  head.classList.add("flash");
  setTimeout(() => head.classList.remove("flash"), 2000);
}

async function toggle(node) {
  const open = !isOpen(node);
  if (S.viewId) await run(() => ops.setLook(S.viewId, node, { open }));
  if (open) await expand(node).catch((e) => layr.ui.notify(e.message, "error"));
}

/** Open (or close) `nodes` and everything below them that has children, in this view (at most 300 groups). */
async function openAll(nodes, open) {
  if (!S.viewId) return;
  let budget = 300;
  const seen = new Set();
  const walk = async (node) => {
    if (seen.has(node) || budget-- <= 0 || graph.childCount(node) === 0) return;
    seen.add(node);
    const was = isOpen(node);
    if (open) {
      if (!was) await ops.setLook(S.viewId, node, { open: true });
      await expand(node);
    }
    for (const k of graph.children(node)) await walk(k.data.to);
    if (!open && was) await ops.setLook(S.viewId, node, { open: false });
  };
  await run(async () => {
    for (const n of nodes) await walk(n);
  });
  if (budget <= 0) layr.ui.notify(open ? "Opened the first 300 groups" : "Closed the first 300 groups");
}

async function select(node) {
  S.selected = node;
  remember();
  schedule();
  if (!node) return;
  // What the details show beyond the graph: picture, prototype page, threads (read fresh each time).
  const n = graph.node(node);
  const [threads, page, pic] = await Promise.all([
    tables.select(TABLES.threads, { node }).catch(() => []),
    n?.data.prototype ? tables.select(TABLES.pages, { node }).catch(() => []) : [],
    n?.data.image ? tables.select(TABLES.images, { node }).catch(() => []) : [],
  ]);
  S.threads.set(
    node,
    threads.sort((a, b) => b.at.localeCompare(a.at)),
  );
  if (page[0]) S.pages.set(node, page[0].html);
  if (pic[0]) {
    const url = await storage.signedUrl(pic[0].path).catch(() => null);
    S.pictures.set(node, { row: pic[0], url, at: Date.now() });
  } else S.pictures.delete(node);
  schedule();
}

async function acceptProposal(p, skip = false) {
  try {
    await layr.tools.run("apply_proposal", { id: p.id, ...(skip ? { skip: true } : {}) });
    layr.ui.notify(`Done: ${p.title}`, "success");
  } catch (error) {
    const pc = error.code === layr.errors.NOT_AVAILABLE ? " (accepting runs on your PC: is it on?)" : "";
    layr.ui.notify(error.message + pc, "error");
  }
  await refresh();
}

async function declineProposal(p) {
  await run(() => tables.delete(TABLES.proposals, { id: p.id }));
  await refresh();
}

async function deleteNode(node) {
  const places = graph.parentCount(node);
  const ok = await confirmIt(
    `Delete "${label(node)}"?`,
    `It goes from ${places === 1 ? "its group" : `all ${places} groups`}; the nodes inside it stay.`,
    "Delete everywhere",
  );
  if (!ok) return;
  if (S.selected === node) S.selected = null;
  await run(() => ops.deleteNode(node));
  if (S.root === node) await focusRoot(graph.views.get(S.viewId)?.data.root ?? null);
}

/** Take rows out of their groups, or delete their nodes everywhere (several, or one in no other group): asked. */
async function removeRows(conns) {
  const rows = conns.filter((c) => graph.group(c));
  if (!rows.length) return;
  const nodes = [...new Set(rows.map((c) => graph.group(c).data.to))];
  const lonely = nodes.filter((n) => graph.parentCount(n) <= 1).length;
  if (rows.length === 1 && !lonely) return void run(() => ops.removeFromGroup(rows[0]));
  const what = rows.length > 1 ? `${rows.length} nodes` : `"${label(nodes[0])}"`;
  const answer = await modal((done) => [
    h("h3.modal-title", `Remove ${what}?`),
    h(
      "p.layr-muted",
      lonely
        ? `${
            lonely === nodes.length ? (nodes.length > 1 ? "They are" : "It is") : `${lonely} of them are`
          } in no other ` + "group: taken out, they will be in none (Not in any group lists them)."
        : "They stay in their other groups.",
    ),
    h(
      "div.modal-actions",
      h("button.layr-button", { onclick: () => done(null) }, "Cancel"),
      h("button.layr-button.danger", { onclick: () => done("delete") }, "Delete everywhere"),
      h(
        "button.layr-button.primary",
        { onclick: () => done("remove") },
        rows.length > 1 ? "Take them out" : "Take it out",
      ),
    ),
  ]);
  if (!answer) return;
  await run(async () => {
    if (answer === "remove") for (const c of rows) if (graph.group(c)) await ops.removeFromGroup(c);
    if (answer === "delete") for (const n of nodes) if (graph.node(n)) await ops.deleteNode(n);
  });
  clearSelection();
  schedule();
}

async function moveBy(groupId, delta) {
  const g = graph.group(groupId);
  if (!g) return false;
  const siblings = graph.children(g.data.from);
  const index = siblings.findIndex((c) => c.id === groupId) + delta;
  if (index < 0 || index >= siblings.length) return false;
  await run(() => ops.moveChild(groupId, delta > 0 ? index + 1 : index));
  return true;
}

/** Move (or with `copy`, also put) the rows `conns` into a node found by searching. */
async function moveBySearch(conns, copy) {
  const nodes = conns.map((c) => graph.group(c)?.data.to).filter(Boolean);
  if (!nodes.length) return;
  const what = nodes.length > 1 ? `${nodes.length} nodes` : `"${label(nodes[0])}"`;
  const to = await pickNode(`${copy ? "Also put" : "Move"} ${what} into…`, db.search, (id) => nodes.includes(id));
  if (!to) return;
  await run(() => need([to]));
  const t = { kind: "into", node: to };
  if (!acceptMove(graph, conns, t)) return layr.ui.notify("Not into itself or what is inside it", "error");
  await dropNodes(conns, t, copy);
}

/** Put `node` into a node found by searching too (`group`: the row it is shown through). */
async function alsoIn(node, group) {
  if (group) return moveBySearch([group], true);
  const target = await pickNode(`Also put "${label(node)}" into…`, db.search, (id) => id === node);
  if (!target) return;
  await run(async () => {
    await need([target]);
    applyBundle(graph, await db.level([target], 0, 1000));
    await ops.addChild(target, node);
  });
  await refresh();
}

/** Put an existing node (found by searching) inside `node`. */
async function putInside(node, group) {
  const picked = await pickNode(`Put inside "${label(node)}"…`, db.search, (id) => id === node);
  if (!picked) return;
  const added = await run(async () => {
    await need([picked]);
    return ops.addChild(node, picked);
  });
  if (added && group && !isOpen(node)) await toggle(node);
}

/**
 * Drop the rows `conns` on `t`: between two rows, into a node (last) or into a free layout (where it was dropped).
 * They move there, in their order; with `copy` (Ctrl), they are put there too and stay where they were.
 */
async function dropNodes(conns, t, copy) {
  const dest = t.kind === "into" ? t.node : t.parent;
  const moving = new Set(conns);
  // They land before this child of `dest` (none: last).
  const before =
    t.kind === "gap"
      ? graph
          .children(dest)
          .slice(t.index)
          .find((c) => !moving.has(c.id))?.id
      : undefined;
  const placed = [];
  await run(async () => {
    if (!graph.node(dest)) await need([dest]);
    for (const [i, conn] of conns.entries()) {
      const g = graph.group(conn);
      if (!g) continue;
      const at = () => {
        const index = before
          ? graph
              .children(dest)
              .filter((c) => c.id !== conn)
              .findIndex((c) => c.id === before)
          : -1;
        return index < 0 ? undefined : index;
      };
      let now = conn;
      if (g.data.from === dest) {
        if (t.kind === "gap") await ops.moveChild(conn, at() ?? Number.MAX_SAFE_INTEGER);
      } else if (copy) {
        if (graph.membership(dest, g.data.to)) continue;
        now = await ops.addChild(dest, g.data.to, at());
      } else {
        now = await ops.moveToGroup(conn, dest, at());
      }
      if (!now) continue;
      placed.push(now);
      if (t.kind === "free" && S.viewId) await ops.setLook(S.viewId, g.data.to, { x: t.x + i * 24, y: t.y + i * 24 });
    }
  });
  if (t.kind === "into" && t.group && !isOpen(dest)) await toggle(dest);
  if (placed.length > 1) S.selection = placed;
  S.cursor = placed[0] ?? S.cursor;
  if (t.kind === "into" && !t.group && dest !== S.root) {
    layr.ui.notify(`${copy ? "Also put in" : "Moved into"} "${label(dest)}"`);
  }
  schedule();
}

// ---------- selection

function clearSelection() {
  S.selection = [];
  S.anchor = null;
  S.connecting = null;
}

/** The rows shown in this view, top to bottom: what the arrow keys walk through. */
const visibleRows = () => [...document.querySelectorAll("#main .item-head[data-group]")].map((el) => el.dataset.group);
const rowHead = (conn) => $(`#main .item-head[data-group="${conn}"]`);
/** The selected rows in the order they show, or the cursor's row: what keys and menus act on. */
function targets() {
  const chosen = new Set(S.selection);
  if (chosen.size) return visibleRows().filter((c) => chosen.has(c));
  return S.cursor && graph.group(S.cursor) ? [S.cursor] : [];
}
const targetNodes = () => [
  ...new Set(
    targets()
      .map((c) => graph.group(c)?.data.to)
      .filter(Boolean),
  ),
];

function selectClick(conn, range) {
  if (document.activeElement?.isContentEditable) document.activeElement.blur();
  const next = clickSelect(S.selection, visibleRows(), S.anchor, conn, range);
  S.selection = next.selection;
  S.anchor = next.anchor;
  S.cursor = conn;
  schedule();
}

/** Wait (a second at most) until opened rows have drawn what `rows` finds: it stops growing, or reaches `want`. */
async function drawn(rows, want = Infinity) {
  let [last, still] = [-1, 0];
  for (let i = 0; i < 60; i++) {
    render();
    const n = rows().length;
    if (n >= want) break;
    still = n === last ? still + 1 : 0;
    if (still >= 6 && n > 0) break;
    last = n;
    await new Promise((done) => requestAnimationFrame(done));
  }
  return [...new Set(rows())];
}

/** The rows shown inside the row `conn` (none: the root), at any depth. */
const rowsInside = (conn) => {
  const box = conn ? rowHead(conn)?.closest(".item")?.querySelector(":scope > .item-children") : $("#body");
  return [...(box?.querySelectorAll(".item-head[data-group]") ?? [])].map((el) => el.dataset.group);
};

/**
 * Select rows related to the rows at `places` (group conns; null for the root) instead of them: their children or
 * everything inside them (closed ones are opened first), their parents, or them and their siblings.
 */
async function selectRelated(places, related) {
  if (related === "clear") {
    clearSelection();
    return schedule();
  }
  const nodeAt = (p) => (p ? graph.group(p)?.data.to : S.root);
  let rows = [];
  if (related === "children" || related === "inside") {
    const parents = places.filter((p) => graph.childCount(nodeAt(p) ?? "") > 0);
    if (!parents.length) return layr.ui.notify("Nothing is inside them");
    for (const p of parents) {
      const node = nodeAt(p);
      if (related === "inside") await openAll(p ? [node] : graph.children(node).map((k) => k.data.to), true);
      else if (p && !isOpen(node)) await toggle(node);
      else await expand(node).catch(() => {});
    }
    if (related === "children") {
      const wanted = new Set(parents.flatMap((p) => graph.children(nodeAt(p)).map((k) => k.id)));
      rows = await drawn(() => visibleRows().filter((c) => wanted.has(c)), wanted.size);
    } else rows = await drawn(() => parents.flatMap(rowsInside));
  } else if (related === "parents") {
    const up = (c) =>
      rowHead(c)?.closest(".item-children")?.closest(".item")?.querySelector(".item-head")?.dataset.group;
    rows = [...new Set(places.map((p) => (p ? up(p) : undefined)).filter(Boolean))];
    if (!rows.length) return layr.ui.notify("They are right below the root");
  } else {
    const wanted = new Set(
      places.flatMap((p) => {
        const from = p ? graph.group(p)?.data.from : undefined;
        return from ? graph.children(from).map((k) => k.id) : [];
      }),
    );
    rows = visibleRows().filter((c) => wanted.has(c));
  }
  if (!rows.length) return;
  S.selection = rows;
  S.cursor = rows[0];
  S.anchor = rows[0];
  schedule();
  setTimeout(() => rowHead(rows[0])?.scrollIntoView({ block: "nearest" }), 30);
}

// ---------- connecting and edges

/** Ask for an edge type: an existing one (the one used last first), a new one, or none. Undefined when cancelled. */
async function pickType(title, current) {
  const { types } = await tables.rpc("types", {}).catch(() => ({ types: S.types }));
  S.types = types ?? S.types;
  const choice = await pick(title, [
    ...sortTypes(S.types, S.lastType).map((t) => ({
      label: t.id === current ? `${t.text} (now)` : t.text || "(empty)",
      description: [t.id === S.lastType ? "Used last" : "", t.meaning ?? ""].filter(Boolean).join(" · "),
      value: `type:${t.id}`,
    })),
    { label: "New type…", value: "new", description: 'Added to "Edge types"' },
    { label: "No type", value: "none", description: "Only a free label" },
  ]);
  if (!choice) return undefined;
  if (choice === "none") return null;
  const remembered = (id) => {
    S.lastType = id;
    remember();
    return id;
  };
  if (choice.startsWith("type:")) return remembered(choice.slice(5));
  const name = await ask("New edge type", "", "e.g. is a, causes, made from");
  if (!name) return undefined;
  const made = await run(() => ops.addEdgeType(name));
  return made ? remembered(made) : undefined;
}

/** Edges from each of `from` to `to`: only their type is asked; they hold everywhere. */
async function connectTo(from, to) {
  const froms = from.filter((f) => f !== to);
  if (!froms.length) return;
  await run(() => need([to]));
  const what = froms.length > 1 ? `${froms.length} nodes` : `"${label(froms[0])}"`;
  const relation = await pickType(`Edge from ${what} to "${label(to)}": its type`);
  if (relation === undefined) return;
  // One edge per pair and type: those that have it already are left as they are.
  const has = (f) =>
    graph.edgesOf(f).some((e) => e.data.from === f && e.data.to === to && (e.data.relation ?? null) === relation);
  const skipped = froms.filter(has).length;
  await run(async () => {
    for (const f of froms) if (!has(f)) await ops.addEdge(f, to, { relation: relation ?? undefined });
  });
  if (skipped) layr.ui.notify(skipped === froms.length ? "That edge is there already" : `${skipped} had it already`);
}

/** Connect `from` to a node found by searching (the group's other children first). */
async function connectBySearch(from) {
  const parent = graph.parents(from[0])[0]?.data.from;
  const first = parent
    ? graph
        .children(parent)
        .map((g) => g.data.to)
        .filter((id) => !from.includes(id))
        .slice(0, 30)
        .map((id) => ({ id, label: label(id), description: "In this group" }))
    : [];
  const what = from.length > 1 ? `${from.length} nodes` : `"${label(from[0])}"`;
  const to = await pickNode(`Edge from ${what} to…`, db.search, (id) => from.includes(id), first);
  if (to) await connectTo(from, to);
}

/** Connect by clicking: the next node clicked is the other end (Esc cancels; Search… finds one). */
function startConnecting(from) {
  if (!from.length) return;
  S.connecting = { from };
  schedule();
}

const edgeActs = {
  show: (node) => void reveal(node).catch((e) => layr.ui.notify(e.message, "error")),
  editLabel: (edgeId) => {
    const e = graph.edge(edgeId);
    if (!e) return;
    const chip = $(`#main [data-edge="${edgeId}"]`);
    if (!chip) {
      return void ask("Edge label", e.data.label ?? "", "", { empty: true }).then(
        (text) => text !== null && run(() => ops.updateEdge(edgeId, { label: text })),
      );
    }
    S.editingEdge = `${edgeId} ${chip.dataset.from}`;
    schedule();
  },
  changeType: async (edgeId) => {
    const relation = await pickType("Type of the edge", graph.edge(edgeId)?.data.relation);
    if (relation !== undefined) await run(() => ops.updateEdge(edgeId, { relation }));
  },
  holdIn: (edgeId, parent) => void run(() => ops.updateEdge(edgeId, { in: parent })),
  deleteEdge: (edgeId) => void run(() => ops.deleteEdge(edgeId)),
};

function edgeMenu(edgeId, node, parent, at) {
  void showMenu(edgeItems(graph, edgeId, node, parent, edgeActs), at).catch((e) => layr.ui.notify(e.message, "error"));
}

// ---------- tags

async function setTag(nodes, tag, on) {
  await run(async () => {
    for (const n of nodes) {
      if (on && !graph.nodeTag(n, tag)) await ops.tag(n, tag);
      if (!on && graph.nodeTag(n, tag)) await ops.untag(n, tag);
    }
  });
}

/** A new tag (its set asked when there are sets), put on `nodes`. */
async function newTag(nodes = []) {
  const name = await ask("New tag", "", "e.g. Planned, mobile, breaking change");
  if (!name) return;
  let set = null;
  if (graph.tagSets.size) {
    const choice = await pick(`Put "${name}" in a set?`, [
      ...graph
        .sortedTagSets()
        .map((s) => ({ label: s.name, description: s.single ? "One tag per node" : "", value: s.id })),
      { label: "In no set", value: "-" },
    ]);
    if (choice === null) return;
    set = choice === "-" ? null : choice;
  }
  const tag = await run(() => ops.createTag({ name, tag_set: set }));
  if (tag && nodes.length) await setTag(nodes, tag, true);
}

const openTagManager = (focus) =>
  manageTags({
    graph,
    ops,
    run,
    focus,
    counts: () => db.tagCounts(),
    onDeleted: (tag) => setFilter(S.tagFilter.filter((t) => t !== tag)),
  }).then(() => schedule());

function setFilter(tags) {
  S.tagFilter = tags;
  remember();
  schedule();
}

const tagActs = {
  setTag: (nodes, tag, on) => void setTag(nodes, tag, on),
  filter: (tags) => setFilter(tags),
  tagColor: (tag, color) => void run(() => ops.updateTag(tag, { color })),
  manageTags: (focus) => void openTagManager(focus),
};

function tagPillMenu(node, tag, at) {
  void showMenu(tagPillItems(graph, node, tag, S.tagFilter, tagActs), at).catch((e) =>
    layr.ui.notify(e.message, "error"),
  );
}

/** The toolbar's Tags button: which tags the view shows only, and managing them. */
function tagsMenu(at) {
  const tags = graph.sortedTags();
  const items = [
    { label: "Show only nodes tagged…", disabled: true },
    ...tags.map((t) => ({
      label: graph.tagSets.get(t.tag_set)?.name ? `${t.name} (${graph.tagSets.get(t.tag_set).name})` : t.name,
      checked: S.tagFilter.includes(t.id),
      run: () => setFilter(S.tagFilter.includes(t.id) ? S.tagFilter.filter((x) => x !== t.id) : [...S.tagFilter, t.id]),
    })),
    S.tagFilter.length > 0 && "-",
    S.tagFilter.length > 0 && { label: "Show all nodes again", icon: "filter_alt_off", run: () => setFilter([]) },
    "-",
    { label: "Manage tags…", icon: "settings", run: () => void openTagManager() },
  ].filter(Boolean);
  void showMenu(items, at).catch((e) => layr.ui.notify(e.message, "error"));
}

// ---------- links to other plugins

const nodeLink = (node) => layrLink({ plugin: "concepts", kind: "node", id: node });
const nodeMarkdownLink = (node) => layrMarkdownLink(label(node), { plugin: "concepts", kind: "node", id: node });

/** A layr link clicked in a node's text: nodes and prototypes of this map open here, others where layr opens them. */
function openLink(href) {
  const link = parseLayrLink(href);
  if (link?.plugin === "concepts" && link.kind === "node") return void reveal(link.id).catch(() => {});
  if (link?.plugin === "concepts" && link.kind === "prototype") return openPrototypes([link.id]);
  if (typeof layr.links?.open === "function") {
    return void layr.links.open(href).catch((e) => layr.ui.notify(e.message ?? String(e), "error"));
  }
  // An older core: the link's plugin and kind as a panel's params, when it has the panel.
  void layr.call("links.open", { url: href }).catch(() => layr.ui.notify(`Can't open ${href} in this layr`, "error"));
}

/** A web link clicked in a node's text: outside layr. */
const openWeb = (href) => void window.open(href, "_blank", "noopener,noreferrer");

const openPrototypes = (nodes) =>
  void layr.panels.open("prototypes", { nodes }, { where: "tab" }).catch((e) => layr.ui.notify(e.message, "error"));

async function copyText(text, what = "Link") {
  try {
    await navigator.clipboard.writeText(text);
    layr.ui.notify(`${what} copied`, "success");
  } catch {
    await showText(`${what}: press Ctrl+C to copy it`, text);
  }
}

/** Call another plugin's tool; its value (structured content unwrapped). */
const otherTool = (plugin, tool, args = {}) => layr.tools.run(tool, args, { plugin });

/** Link another plugin's item (`thread`: its layr link) to the node: it shows among the node's threads. */
const linkThread = (node, thread, title) =>
  run(() =>
    tables.rpc("mark", {
      node_ids: [node],
      thread_key: thread,
      link: thread,
      thread_title: title,
      changed: false,
      note_text: null,
      linked: true,
    }),
  );

/** A pipeline task's link from its number. */
const taskLink = (number) => layrLink({ plugin: "pipeline", kind: "task", id: String(number) });

/** A pipeline task made from this node: its description is the node as an outline; linked both ways. */
async function sendToPipeline(node) {
  try {
    const { projects = [] } = (await otherTool("pipeline", "projects")) ?? {};
    const usable = projects.filter((p) => p.enabled !== false);
    if (!usable.length) return layr.ui.notify("The pipeline has no project to put a task in: add one there", "error");
    const projectId =
      usable.length === 1
        ? usable[0].projectId ?? usable[0].id
        : await pick(
            `Send "${label(node)}" to the pipeline: which project?`,
            usable.map((p) => ({
              label: p.title ?? p.name ?? p.projectId,
              description: p.path ?? "",
              value: p.projectId ?? p.id,
            })),
          );
    if (!projectId) return;
    const description = [
      await readOutline(loader, node, 4000),
      `This task comes from the concept node #${shortId(node)} in layr's concept map (${nodeLink(node)}); ` +
        "read more of it with the concepts tools (concepts__read).",
    ].join("\n\n");
    const args = { title: label(node), description, projectId, from: [nodeLink(node)] };
    let result = await otherTool("pipeline", "propose", args);
    if (!result?.proposed && result?.duplicates?.length) {
      const choice = await pick(
        "These tasks look like it",
        [
          { label: "Propose it anyway", description: "It is new", value: "new" },
          ...result.duplicates.map((d) => ({
            label: `#${d.number} ${d.title}`,
            description: `${d.column} · link it instead`,
            value: `task:${d.number}`,
          })),
        ],
        { note: "Link one of them to the node instead, or propose a new task." },
      );
      if (!choice) return;
      if (choice.startsWith("task:")) {
        const d = result.duplicates.find((x) => String(x.number) === choice.slice(5));
        await linkThread(node, taskLink(d.number), `#${d.number} ${d.title}`);
        return layr.ui.notify(`Linked to task #${d.number}`, "success");
      }
    }
    if (!result?.proposed) result = await otherTool("pipeline", "propose", { ...args, confirm: true });
    if (!result?.proposed) return layr.ui.notify("The pipeline didn't take the task", "error");
    await linkThread(node, taskLink(result.number), `#${result.number} ${result.title}`);
    layr.ui.notify(`Task #${result.number} proposed: it shows among this node's threads`, "success");
    if (S.selected === node) void select(node);
  } catch (error) {
    layr.ui.notify(`The pipeline couldn't take it: ${error.message ?? error}`, "error");
  }
}

async function linkTask(node) {
  try {
    const { tasks = [] } = (await otherTool("pipeline", "tasks", { limit: 300 })) ?? {};
    const number = await pick(
      `Link "${label(node)}" to the pipeline task…`,
      tasks.map((t) => ({ label: `#${t.number} ${t.title}`, description: t.column, value: String(t.number) })),
      { empty: "The pipeline has no tasks" },
    );
    const task = tasks.find((t) => String(t.number) === number);
    if (!task) return;
    await linkThread(node, taskLink(task.number), `#${task.number} ${task.title}`);
    layr.ui.notify(`Linked to task #${task.number}`, "success");
    if (S.selected === node) void select(node);
  } catch (error) {
    layr.ui.notify(`Couldn't read the pipeline's tasks: ${error.message ?? error}`, "error");
  }
}

/**
 * Take a linked task or thread off the node. A thread that also changed or mentioned it stays, as only that; one
 * that was only linked goes.
 */
async function unlink(node) {
  const rows = (await tables.select(TABLES.threads, { node }).catch(() => [])).filter((t) => t.linked_at);
  const id = await pick(
    `Unlink from "${label(node)}"…`,
    rows.map((t) => ({ label: t.title || "Untitled thread", description: t.href ?? t.thread, value: t.id })),
    { empty: "Nothing is linked to it" },
  );
  const row = rows.find((t) => t.id === id);
  if (!row) return;
  await run(async () => {
    if (row.changed_at || row.mentioned_at) await tables.update(TABLES.threads, { id: row.id }, { linked_at: null });
    else await tables.delete(TABLES.threads, { id: row.id });
  });
  if (S.selected === node) void select(node);
}

/** The prompt the idea helper starts with (layr_code task #179). */
const ideaPrompt = (node) =>
  [
    `Help me make an idea from ${nodeMarkdownLink(node)}.`,
    "Read it and what is inside it, find its project node (concepts__project) and search that project's Features",
    "for the same idea. Ask me, in numbered questions, what you can't tell. Then show me a draft: the area it goes in",
    "(Inbox when none fits), a short title, a one-sentence description as its first child, and the first spec lines",
    "(what, why, done when). Add it only after I say yes: tagged Idea and You, with a `leads to` edge from the note.",
    "Don't move or change the note itself.",
  ].join(" ");

/**
 * Ask Claude about a node: a new thread with the node as context, started here (`claude__thread_start`), or the
 * claude plugin's new-thread form with the text in it. `idea`: the idea helper's prompt.
 */
async function askClaude(node, idea = false) {
  let projects = [];
  try {
    projects = (await otherTool("claude", "projects_list"))?.projects ?? [];
  } catch {
    // The list can't be read (not allowed yet): the form can still be opened.
  }
  const text = idea ? ideaPrompt(node) : `About ${nodeMarkdownLink(node)}: `;
  const choice = await modal((done) => {
    const area = h("textarea.layr-textarea", { rows: 6, value: text, dataset: { first: "1" } });
    const project = h(
      "select.layr-select",
      { "aria-label": "Project" },
      ...projects.map((p) => h("option", { value: p.id ?? p.name }, p.name ?? p.id)),
    );
    setTimeout(() => {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    }, 0);
    return [
      h("h3.modal-title", idea ? `Make an idea from "${label(node)}"` : `Ask Claude about "${label(node)}"`),
      h("p.layr-muted.modal-note", "The node goes along as a link; Claude reads it with the concepts tools."),
      area,
      projects.length > 0 && h("label.layr-label", "Project"),
      projects.length > 0 && project,
      h(
        "div.modal-actions",
        h("button.layr-button", { onclick: () => done(null) }, "Cancel"),
        h("button.layr-button", { onclick: () => done({ form: true, text: area.value }) }, "Open the new-thread form"),
        projects.length > 0 &&
          h(
            "button.layr-button.primary",
            { onclick: () => done({ text: area.value, project: project.value }) },
            "Start the thread",
          ),
      ),
    ];
  });
  if (!choice) return;
  if (choice.form) {
    await layr.panels
      .open("threads", { new: true, prompt: choice.text, text: choice.text }, { plugin: "claude" })
      .catch((e) => layr.ui.notify(`The Claude plugin isn't there: ${e.message}`, "error"));
    return;
  }
  try {
    const title = idea ? `Idea: ${label(node)}` : label(node);
    const r = await otherTool("claude", "thread_start", { project: choice.project, prompt: choice.text, title });
    const id = r?.thread?.id ?? r?.id ?? r?.threadId;
    if (!id) return;
    await linkThread(node, layrLink({ plugin: "claude", kind: "thread", id }), title);
    await layr.panels.open("thread", { thread: id }, { plugin: "claude" }).catch(() => {});
  } catch (error) {
    layr.ui.notify(`Claude couldn't start it: ${error.message ?? error}`, "error");
  }
}

/** Which other plugins' tools this panel may call (feature detection: no tools, no menu items). */
async function detectPlugins() {
  const has = async (plugin, tool) => {
    try {
      return (await layr.tools.list({ plugin })).some((t) => t.name === tool || t.name === `${plugin}__${tool}`);
    } catch {
      return false;
    }
  };
  [S.plugins.pipeline, S.plugins.claude] = await Promise.all([
    has("pipeline", "propose"),
    has("claude", "thread_start"),
  ]);
  schedule();
}

// ---------- summaries and pictures

/** The summary dialog; `write`: Claude starts writing it right away (Summarize with Claude in a node's menu). */
async function editSummary(node, write = false) {
  const old = graph.summary(node)?.data.text ?? "";
  const text = await modal((done) => {
    const area = h("textarea.layr-textarea", { rows: 6, value: old, placeholder: "A short version of what is inside" });
    /** Claude (haiku, through the claude plugin) writes it from the node's children; the user can still edit it. */
    const writeIt = async () => {
      button.disabled = true;
      button.textContent = "Writing…";
      try {
        const r = await layr.tools.run("summarize", { node });
        area.value = r?.summary ?? r?.structuredContent?.summary ?? area.value;
      } catch (error) {
        layr.ui.notify(`Claude couldn't write it: ${error.message ?? error}`, "error");
      } finally {
        button.disabled = false;
        button.textContent = "Write with Claude";
      }
    };
    const button = h(
      "button.layr-button",
      { onclick: () => void writeIt(), title: "Needs the Claude Code plugin on the PC" },
      "Write with Claude",
    );
    if (write) setTimeout(() => void writeIt(), 0);
    return [
      h("h3.modal-title", `Summary of "${label(node)}"`),
      area,
      h(
        "div.modal-actions",
        old && h("button.layr-button.danger", { onclick: () => done("") }, "Remove"),
        button,
        h("span.layr-spacer"),
        h("button.layr-button", { onclick: () => done(null) }, "Cancel"),
        h("button.layr-button.primary", { onclick: () => done(area.value.trim()) }, "Save"),
      ),
    ];
  });
  if (text === null) return;
  await run(() => (text ? ops.setSummary(node, text) : ops.removeSummary(node)));
}

async function setPicture(node, file) {
  const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
  if (!TYPES[file.type]) return layr.ui.notify("A picture is a PNG, JPEG, WebP or GIF", "error");
  if (file.size > 3.5 * 1024 * 1024) return layr.ui.notify("That picture is over 3.5 MB", "error");
  const path = `images/${crypto.randomUUID()}.${TYPES[file.type]}`;
  await run(async () => {
    await storage.upload(path, new Uint8Array(await file.arrayBuffer()), file.type);
    const old = await pictureRow(node);
    if (old) {
      await tables.update(TABLES.images, { id: old.id }, { path, width: null, height: null });
      await storage.remove([old.path]).catch(() => {});
    } else await tables.insert(TABLES.images, { node, path, caption: "" });
    graph.node(node).data.image = true;
  });
  await select(node);
}

/** A node's picture row: the one its details read, else read now (a menu works without the details open). */
async function pictureRow(node) {
  if (S.pictures.get(node)?.row) return S.pictures.get(node).row;
  if (!graph.node(node)?.data.image) return undefined;
  return (await tables.select(TABLES.images, { node }))[0];
}

/** Choose a picture file for `node` (from its menu); its details show, with their own button if the browser balks. */
function choosePicture(node) {
  void select(node);
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  file.onchange = () => {
    if (file.files[0]) void setPicture(node, file.files[0]);
    file.remove();
  };
  document.body.append(file);
  file.click();
}

// ---------- pictures in the map (as in layr_code): icon sized under the row, wider by dragging, big on a click

const PICTURE_ICON = 32;
const PICTURE_WIDTH = { min: 16, max: 1600 };
const loadingPictures = new Set();

/** Read the pictures of `nodes` not read yet (or whose link is getting old), then draw again. */
async function loadPictures(nodes) {
  const old = Date.now() - 50 * 60 * 1000;
  const want = nodes.filter((n) => !loadingPictures.has(n) && !((S.pictures.get(n)?.at ?? 0) > old));
  if (!want.length) return;
  for (const n of want) loadingPictures.add(n);
  try {
    const rows = await tables.select(TABLES.images, { node: want });
    await Promise.all(
      rows.map(async (row) => {
        const url = await storage.signedUrl(row.path).catch(() => null);
        S.pictures.set(row.node, { row, url, at: Date.now() });
      }),
    );
    for (const n of want) {
      if (!rows.some((r) => r.node === n)) S.pictures.set(n, { row: null, url: null, at: Date.now() });
    }
  } catch {
    // Not now: tried again when the row is drawn again.
  } finally {
    for (const n of want) loadingPictures.delete(n);
  }
  schedule();
}

let picturesToLoad = new Set();
/** A node's picture under its row: icon sized, or as wide as dragged in this view; a click shows it big. */
function renderPicture(node) {
  const pic = S.pictures.get(node);
  if (!pic || Date.now() - pic.at > 50 * 60 * 1000) {
    if (!picturesToLoad.size)
      queueMicrotask(() => {
        const nodes = [...picturesToLoad];
        picturesToLoad = new Set();
        void loadPictures(nodes);
      });
    picturesToLoad.add(node);
  }
  if (!pic?.url) return null;
  const { width, height, caption } = pic.row;
  const ratio = width && height ? width / height : 1;
  const w = look(node)?.pic_w ?? Math.round(PICTURE_ICON * Math.min(1, ratio));
  const img = h("img", {
    src: pic.url,
    alt: caption ?? "",
    loading: "lazy",
    style: `width: ${w}px;${width && height ? ` aspect-ratio: ${ratio};` : ""}`,
  });
  return h(
    "figure.node-picture",
    { dataset: { key: `pic:${node}` } },
    h(
      "div.picture-frame",
      h("button.picture-open", { title: "Open it big", onclick: (e) => (e.stopPropagation(), showBig(pic)) }, img),
      h("span.picture-handle", {
        title: "Drag to make it bigger or smaller (double-click: icon sized)",
        onpointerdown: (e) => startPictureDrag(e, node),
        ondblclick: (e) => (e.stopPropagation(), void setLook(node, { pic_w: null })),
      }),
    ),
    caption && h("figcaption", caption),
  );
}

function startPictureDrag(e, node) {
  const frame = e.currentTarget.closest(".picture-frame");
  const img = frame.querySelector("img");
  const start = img.offsetWidth;
  let w = start;
  frame.classList.add("resizing");
  follow(
    e,
    (dx) => {
      w = Math.round(Math.min(PICTURE_WIDTH.max, Math.max(PICTURE_WIDTH.min, start + dx)));
      img.style.width = `${w}px`;
    },
    () => {
      frame.classList.remove("resizing");
      if (w !== start) void setLook(node, { pic_w: w });
    },
  );
}

/** A picture over everything, as big as fits; a click or Esc closes it. */
function showBig(pic) {
  const close = () => {
    layer.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const layer = h(
    "div.picture-big",
    { onclick: close },
    h(
      "figure",
      h("img", { src: pic.url, alt: pic.row.caption ?? "" }),
      pic.row.caption && h("figcaption", pic.row.caption),
    ),
  );
  window.addEventListener("keydown", onKey, true);
  document.body.append(layer);
}

async function removePicture(node) {
  const row = await pictureRow(node).catch(() => undefined);
  if (!row) return;
  await run(async () => {
    await tables.delete(TABLES.images, { id: row.id });
    await storage.remove([row.path]).catch(() => {});
    delete graph.node(node).data.image;
  });
  S.pictures.delete(node);
  schedule();
}

// ---------------------------------------------------------------- rendering

let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

/** How many times the panel was drawn (tests read it, to see it settles). */
let renders = 0;
Object.defineProperty(window, "conceptsRenders", { get: () => renders });

function render() {
  const app = $("#app");
  const showDetails = !!(S.selected && S.mode === "ready" && graph.node(S.selected));
  // Narrow, the side and the details both cover the outline: the details win while a node is picked.
  app.classList.toggle("no-side", !S.side || (narrow() && showDetails));
  app.classList.toggle("with-details", showDetails);
  app.classList.toggle("narrow", narrow());
  document.body.classList.toggle("connecting", !!S.connecting);
  renders++;
  morphChildren($("#side"), renderSide());
  morphChildren($("#main"), renderMain());
  placeEmbeds();
  const details = $("#details");
  details.hidden = !showDetails;
  if (!details.hidden) morphChildren(details, renderDetails(S.selected));
  const root = S.root && graph.node(S.root);
  void layr.panel.setTitle(root ? `Concepts · ${label(S.root)}` : "Concepts").catch(() => {});
  afterRender();
  if (S.focus) {
    const text = rowText(S.focus);
    S.focus = null;
    if (text) return caretAtEnd(text);
  }
  const focus = $("[data-autofocus]", $("#main"));
  if (focus && document.activeElement !== focus) {
    focus.focus();
    if (focus.select && focus.dataset.autofocus === "select") focus.select();
  }
}

/** What a region shows, without the `false` and `undefined` of parts left out. */
const clean = (parts) => parts.flat(Infinity).filter((p) => p !== null && p !== undefined && p !== false);

function renderSide() {
  const search = h("input.layr-input", {
    id: "search",
    type: "search",
    placeholder: "Search all nodes",
    value: S.query,
    autocomplete: "off",
  });
  let timer;
  search.oninput = () => {
    S.query = search.value;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = S.query.trim();
      S.hits = q ? await db.search(q, 30).catch((e) => (layr.ui.notify(e.message, "error"), [])) : null;
      schedule();
    }, 220);
  };
  const hits =
    S.hits === null
      ? []
      : S.hits.length
      ? S.hits.map((x) =>
          h(
            "div.hit",
            { onclick: () => void reveal(x.id), title: x.path.map((p) => p.text).join(" › "), dataset: { key: x.id } },
            h(
              "button.icon-button.hit-root",
              {
                title: "Show it as the root",
                "aria-label": "Show it as the root",
                onclick: (e) => (e.stopPropagation(), void focusRoot(x.id)),
              },
              icon("open", 13),
            ),
            h("div.hit-text", firstLine(x.text) || "(empty)"),
            h("div.hit-path", x.path.map((p) => p.text || "(empty)").join(" › ") || "in no group"),
          ),
        )
      : [h("div.layr-muted.pad-s", "Nothing found")];

  const views = sortedViews();
  return clean([
    h(
      "div.side-head",
      h(
        "button.layr-button.primary",
        { onclick: () => void newView(), title: "A new root concept with a view" },
        icon("plus", 14),
        " New view",
      ),
      h("span.layr-spacer"),
      iconButton("refresh", "Read everything again", () => void refresh()),
      narrow() &&
        iconButton("close", "Hide the side", () => {
          S.side = false;
          remember();
          schedule();
        }),
    ),
    h("div.side-search", search),
    h("div.hits", { id: "hits" }, hits),
    h(
      "div.side-scroll",
      S.proposals.length > 0 && [
        h("h3.section-title", `Proposed by AI · ${S.proposals.length}`),
        ...S.proposals.map(renderProposal),
      ],
      h("h3.section-title", `Views · ${views.length}`),
      views.length
        ? views.map((v) =>
            h(
              "div.view-row",
              {
                class: v.id === S.viewId ? "active" : "",
                onclick: () => void openView(v.id),
                dataset: { view: v.id, key: v.id },
              },
              h("span.view-title", v.data.name || label(v.data.root)),
              v.data.name && h("span.view-of", viewRootLabel(graph, v.data.root)),
              h("span.count", String(graph.childCount(v.data.root) || "")),
              h(
                "span.view-tools",
                h(
                  "button.icon-button",
                  {
                    title: "Rename this view",
                    "aria-label": "Rename",
                    onclick: (e) => (e.stopPropagation(), void renameView(v.id)),
                  },
                  icon("edit", 13),
                ),
                h(
                  "button.icon-button",
                  {
                    title: "Delete this view (its nodes stay)",
                    "aria-label": "Delete",
                    onclick: (e) => (e.stopPropagation(), void deleteView(v.id)),
                  },
                  icon("trash", 13),
                ),
              ),
            ),
          )
        : h("p.layr-muted.pad-s", "No views yet: make one with New view."),
      S.unplaced.nodes.length > 0 && [
        h("h3.section-title", `Not in any group · ${S.unplaced.total}`),
        ...S.unplaced.nodes.map((n) =>
          h(
            "div.view-row",
            { onclick: () => void focusRoot(n.id), title: "Show it as the root", dataset: { key: n.id } },
            h("span.view-title", n.text || "(empty)"),
          ),
        ),
      ],
    ),
  ]);
}

function renderProposal(p) {
  const done = p.changes.filter((c) => c.done || c.skipped).length;
  const stopped = p.changes.findIndex((c) => c.error && !c.skipped);
  const started = done > 0 || stopped >= 0;
  const by = p.changes.find((c) => c.by)?.by;
  return h(
    "div.proposal",
    { dataset: { proposal: p.id, key: p.id } },
    h("div.proposal-title", p.title),
    by && h("div.proposal-by", `by ${by.title || by.thread}`),
    stopped >= 0 && h("div.proposal-error", `Stopped: ${p.changes[stopped].error}`),
    p.changes.length > 1 &&
      h(
        "details.proposal-changes",
        h("summary", `${p.changes.length} changes${done ? `, ${done} done` : ""}`),
        h(
          "ol",
          p.changes.map((c) =>
            h("li", { class: c.done || c.skipped ? "done" : c.error ? "failed" : "" }, c.title ?? c.tool),
          ),
        ),
      ),
    h(
      "div.proposal-row",
      h(
        "button.layr-button.primary.small",
        { onclick: () => void acceptProposal(p), title: started ? "Go on from where it stopped" : "Make this change" },
        started ? "Continue" : "Accept",
      ),
      stopped >= 0 &&
        h(
          "button.layr-button.small",
          { onclick: () => void acceptProposal(p, true), title: "Leave out the change it stopped at and go on" },
          "Skip",
        ),
      h(
        "button.layr-button.small",
        { onclick: () => void declineProposal(p), title: started ? "Leave the rest undone" : "Don't make it" },
        "Decline",
      ),
    ),
  );
}

function renderMain() {
  const ready = S.mode === "ready" && S.root && graph.node(S.root);
  const filterNames = S.tagFilter.map((id) => graph.tags.get(id)?.name).filter(Boolean);
  const toolbar = h(
    "div.layr-toolbar.main-bar",
    { dataset: { key: "bar" } },
    iconButton(
      "side",
      S.side ? "Hide the side" : "Views and proposals",
      () => {
        S.side = !S.side;
        if (S.side && narrow()) S.selected = null;
        remember();
        schedule();
      },
      S.side ? ".active" : "",
    ),
    h("span.bar-title", ready ? label(S.root) : "Concepts"),
    h("span.layr-spacer"),
    ready && renderLayoutSwitch(S.root),
    ready &&
      h(
        "button.layr-button.ghost.small.tags-button",
        {
          class: filterNames.length ? "active" : "",
          title: "Show only nodes with some tags, and manage tags",
          onclick: (e) => tagsMenu(below(e.currentTarget)),
        },
        icon("tag", 14),
        filterNames.length ? ` Only: ${filterNames.join(", ")}` : narrow() ? "" : " Tags",
      ),
    ready &&
      iconButton(
        "summary",
        S.summaries ? "Hide summaries" : "Show summaries",
        () => {
          S.summaries = !S.summaries;
          remember();
          schedule();
        },
        S.summaries ? ".active" : "",
      ),
  );
  if (S.mode === "loading") return [toolbar, h("div.layr-empty", h("span.layr-spinner"), " Loading the concept map…")];
  if (S.mode === "signedOut") {
    return [
      toolbar,
      h(
        "div.layr-empty.signed-out",
        h("h3", "Sign in to see your concept map"),
        h("p.layr-muted", "The map lives in your layr account. Sign in under Settings › Account, then try again."),
        h("button.layr-button.primary", { onclick: () => void refresh() }, "Try again"),
      ),
    ];
  }
  if (S.mode === "error") {
    return [
      toolbar,
      h(
        "div.layr-empty",
        h("p.layr-error", S.error),
        h("button.layr-button", { onclick: () => void refresh() }, "Try again"),
      ),
    ];
  }
  if (!ready) {
    return [
      toolbar,
      h(
        "div.layr-empty",
        h("p", "No view open."),
        h("button.layr-button.primary", { onclick: () => void newView() }, "New view"),
      ),
    ];
  }
  const free = layoutOf(menuCtx(), S.root) === "free" && graph.childCount(S.root) > 0;
  return clean([
    toolbar,
    renderHead(S.root),
    S.connecting && renderConnectBar(),
    S.selection.length > 1 && renderSelectionBar(),
    h(
      "div.view-body",
      {
        id: "body",
        class: free ? "canvas" : "",
        dataset: { key: `body:${S.viewId}:${S.root}`, scroll: "body" },
        onclick: (e) => {
          // A click on nothing in particular clears the selection.
          if (e.target.closest(".item-head, .edge-chips, .summary, .proto, button, a, .free-item, .canvas-tools"))
            return;
          if (!S.selection.length && !S.cursor) return;
          S.selection = [];
          S.cursor = null;
          schedule();
        },
      },
      graph.childCount(S.root) === 0
        ? h("p.layr-muted.empty-note", "Empty. Press Enter in the title, or Add a node.")
        : free
        ? renderCanvas(S.root)
        : renderList(S.root, [S.root]),
      !free &&
        S.adding?.parent !== S.root &&
        h(
          "button.add-row",
          { onclick: () => startAdding(S.root, graph.children(S.root).length) },
          icon("plus", 14),
          " Add a node",
        ),
      !free && S.adding?.parent === S.root && graph.childCount(S.root) === 0 && renderAdder(S.root),
    ),
  ]);
}

/** How a node's children are laid out in this view: three buttons. */
function renderLayoutSwitch(node) {
  if (!S.viewId) return null;
  const now = layoutOf(menuCtx(), node);
  return h(
    "span.layout-switch",
    { title: "How its children are laid out in this view" },
    Object.entries(LAYOUT_INFO).map(([id, info]) =>
      h(
        "button",
        {
          class: now === id ? "active" : "",
          title: `${info.label}: ${info.description}`,
          "aria-label": info.label,
          onclick: () => void setLayouts([node], id),
        },
        icon(info.icon, 14),
      ),
    ),
  );
}

function renderConnectBar() {
  const from = S.connecting.from;
  return h(
    "div.connect-bar",
    { dataset: { key: "connect" } },
    h(
      "span",
      "Click the node to connect ",
      h("b", from.length > 1 ? `${from.length} nodes` : `"${label(from[0])}"`),
      " to",
    ),
    h("span.layr-spacer"),
    h(
      "button.layr-button.small",
      {
        onclick: () => {
          S.connecting = null;
          void connectBySearch(from);
        },
      },
      "Search…",
    ),
    h("button.layr-button.small", { onclick: () => ((S.connecting = null), schedule()) }, "Cancel (Esc)"),
  );
}

/** What several selected rows can do, above the view. */
function renderSelectionBar() {
  const prototypes = targetNodes().filter((n) => graph.node(n)?.data.prototype);
  return h(
    "div.selection-bar",
    { dataset: { key: "selection" } },
    h("span.sel-count", `${S.selection.length} selected`),
    h("button.layr-button.small", { onclick: () => void moveBySearch(targets(), false) }, "Move to…"),
    h("button.layr-button.small", { onclick: () => void moveBySearch(targets(), true) }, "Also put in…"),
    h("button.layr-button.small", { onclick: () => startConnecting(targetNodes()) }, "Connect…"),
    h(
      "button.layr-button.small",
      { onclick: (e) => void showMenu(nodeMenuTags(targetNodes()), below(e.currentTarget)) },
      "Tags…",
    ),
    h(
      "button.layr-button.small",
      {
        title: "Select their children instead (closed ones are opened)",
        onclick: () => void selectRelated(targets(), "children"),
      },
      "Children",
    ),
    prototypes.length > 1 &&
      h("button.layr-button.small", { onclick: () => openPrototypes(prototypes) }, "Compare side by side"),
    h("button.layr-button.small.danger", { onclick: () => void removeRows(targets()) }, "Remove…"),
    h("span.layr-spacer"),
    h(
      "button.layr-button.ghost.icon",
      {
        title: "Clear the selection (Esc)",
        "aria-label": "Clear the selection",
        onclick: () => selectRelated([], "clear"),
      },
      icon("close", 14),
    ),
  );
}

/** The root: the groups it is in, its title, tags, summary, picture or page, and edges. */
function renderHead(root) {
  const view = S.viewId && graph.views.get(S.viewId);
  const crumb = (id, text, cls = "", title = "A group above it: show it as the root. Drop a node here to move it in") =>
    h(
      `button.crumb${cls}`,
      { onclick: () => void focusRoot(id), title, dataset: { drop: "into", node: id, key: `crumb:${cls}${id}` } },
      text || "(empty)",
    );
  // The groups above it, outermost first (one way down to it); the view's root first when that way doesn't pass it;
  // the other groups it is directly in after them.
  const path = S.path.filter((p) => p.id !== root);
  const onPath = new Set(path.map((p) => p.id));
  const home = view && view.data.root !== root && !onPath.has(view.data.root);
  const others = S.crumbs.filter((p) => !onPath.has(p.id) && p.id !== view?.data.root && p.id !== root);
  const prev = S.back.at(-1);
  const crumbs = [
    prev &&
      h(
        "button.icon-button.back",
        {
          title: `Back to ${prev.root && graph.node(prev.root) ? label(prev.root) : "where it was before"} (Alt+←)`,
          "aria-label": "Back",
          onclick: () => void goBack(),
        },
        icon("back", 14),
      ),
    home && crumb(view.data.root, label(view.data.root), ".home", "This view's root: show it as the root"),
    path.map((p) => crumb(p.id, firstLine(p.text ?? ""))),
    others.length > 0 &&
      h(
        "span.crumbs-also",
        "also in ",
        others.map((p) => crumb(p.id, firstLine(p.text ?? ""), ".also", "Another group it is in: show it as the root")),
      ),
  ].filter(Boolean);
  const summary = graph.summary(root);
  const n = graph.node(root);
  return h(
    "div.view-head",
    { dataset: { key: `head:${root}` } },
    crumbs.length > 0 && h("div.crumbs", crumbs),
    h(
      "div.root-row",
      {
        dataset: { node: root, drop: "into", own: "", color: n?.data.color ?? "" },
        class: dimmed(graph, root, S.tagFilter) ? "dimmed" : "",
        oncontextmenu: (e) => rowMenu(e, { node: root, root: true }),
      },
      nodeText(root, "root", "root-text", rootKey),
      typeBadges(root),
      tagPills(root),
      view && view.data.name && h("span.layr-badge", view.data.name),
      h(
        "span.row-tools",
        h(
          "button.icon-button",
          {
            title: "More (right-click the title)",
            onclick: (e) => void nodeMenu({ node: root, root: true }, below(e.currentTarget)),
          },
          "⋯",
        ),
      ),
    ),
    n?.data.image && renderPicture(root),
    S.summaries && summary && renderSummary(root, summary),
    n?.data.prototype && renderProto(root, "root"),
    renderEdgeChips(root),
  );
}

function renderSummary(node, summary) {
  return h(
    "div.summary",
    {
      class: summary.data.outdated ? "outdated" : "",
      onclick: () => void editSummary(node),
      title: summary.data.outdated
        ? "Outdated: something inside changed after this summary was written. Click to edit."
        : "A short version of what is inside. Click to edit.",
    },
    summary.data.outdated ? "⚠ " : "",
    summary.data.text,
  );
}

/** A node's tags as coloured pills; a click opens the tag's menu (switch, take off, filter, colour, edit). */
function tagPills(node) {
  return graph.tagsOf(node).map((t) =>
    h(
      "button.tag-pill",
      {
        dataset: { color: t.color ?? "gray", tag: t.id },
        title: [graph.tagSets.get(t.tag_set)?.name, t.description].filter(Boolean).join(": ") || "Tag",
        onclick: (e) => {
          e.stopPropagation();
          tagPillMenu(node, t.id, below(e.currentTarget));
        },
      },
      t.name,
    ),
  );
}

/** "is a" edges as `[Type]` badges next to the node. */
function typeBadges(node) {
  return edgesHere(graph, node)
    .filter((e) => isTypeBadge(graph, e, node))
    .map((e) =>
      h(
        "button.type-badge",
        {
          title: "is a (click: the edge)",
          dataset: { edge: e.id },
          onclick: (ev) => {
            ev.stopPropagation();
            edgeMenu(e.id, node, undefined, below(ev.currentTarget));
          },
          oncontextmenu: (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            edgeMenu(e.id, node, undefined, ev);
          },
        },
        label(e.data.to),
      ),
    );
}

/**
 * A node's edges as chips; a click opens the edge's menu, a click on its label (✎ when it has none) types in it.
 * `drawn`: its group is laid out freely, so edges to its siblings are arrows there and aren't repeated.
 */
function renderEdgeChips(node, parent, drawnHere = false) {
  const edges = edgesHere(graph, node, parent).filter(
    (e) => !isTypeBadge(graph, e, node) && (!drawnHere || !parent || !graph.membership(parent, otherEnd(e, node))),
  );
  if (!edges.length) return null;
  return h(
    "div.edge-chips",
    edges.map((e) => edgeChip(e, node, parent)),
  );
}

function edgeChip(e, node, parent) {
  const out = e.data.from === node;
  const type = e.data.relation ? label(e.data.relation) : "";
  const text = e.data.label ?? "";
  const editing = S.editingEdge === `${e.id} ${node}`;
  let labelPart;
  if (editing) {
    const input = h("input.chip-input", { value: text, placeholder: "label", dataset: { autofocus: "select" } });
    const save = () => {
      if (S.editingEdge !== `${e.id} ${node}`) return;
      S.editingEdge = null;
      if (input.value.trim() !== text) void run(() => ops.updateEdge(e.id, { label: input.value.trim() }));
      // Done with it: the chip (kept while its field has the focus) is drawn anew.
      input.blur();
      schedule();
    };
    input.onclick = (ev) => ev.stopPropagation();
    input.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") save();
      else if (ev.key === "Escape") {
        S.editingEdge = null;
        input.blur();
        schedule();
      }
    };
    input.onblur = save;
    labelPart = input;
  } else {
    labelPart = h(
      text ? "span.chip-label" : "span.chip-add-label",
      {
        title: text ? "Click to edit the label" : "Add a label",
        onclick: (ev) => {
          ev.stopPropagation();
          S.editingEdge = `${e.id} ${node}`;
          schedule();
        },
      },
      text || "✎",
    );
  }
  const sep = type && (text || editing) ? " · " : " ";
  return h(
    "span.edge-chip",
    {
      role: "button",
      class: e.data.in ? "only" : "",
      dataset: { edge: e.id, from: node, key: `edge:${e.id}`, own: "" },
      title: e.data.in ? `Only in "${label(e.data.in)}"` : "Holds wherever these nodes are",
      onclick: (ev) => !editing && edgeMenu(e.id, node, parent, below(ev.currentTarget)),
      oncontextmenu: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        edgeMenu(e.id, node, parent, ev);
      },
    },
    out
      ? [type && h("span.edge-type", type), sep, labelPart, " → ", h("b", label(e.data.to))]
      : [h("b", label(e.data.from)), " ", type && h("span.edge-type", type), sep, labelPart, " →"],
  );
}

/** A prototype's page under its node, folded or not as saved in the view (an island: built once, then updated). */
function renderProto(node, place) {
  const l = look(node);
  const current = { open: !!l?.proto_open, height: l?.proto_h ?? null, zoom: l?.proto_zoom ?? null };
  const key = `proto:${node}:${place}`;
  let el = embeds.get(key);
  if (!el) {
    el = protoEmbed({
      ids: [node],
      name: label(node),
      look: current,
      load: loadPrototypePages,
      openBig: openPrototypes,
      onLook: ({ open, height, zoom }) => void setLook(node, { proto_open: open, proto_h: height, proto_zoom: zoom }),
    });
    el.dataset.key = key;
    el.dataset.island = key;
    embeds.set(key, el);
  } else el.update(current);
  // The page keeps the embed where morph finds it in its place; elsewhere `placeEmbeds` puts it in this stand-in's.
  return h("div.proto", { dataset: { island: key, key, standin: "" } });
}

/** The prototype embeds, by their place: built once, kept while they are on the page. */
const embeds = new Map();
/** Each stand-in that morph put on the page (a new place) gets its embed; embeds no longer shown are forgotten. */
function placeEmbeds() {
  for (const standin of document.querySelectorAll("#main [data-standin]")) {
    const el = embeds.get(standin.dataset.island);
    if (el) standin.replaceWith(el);
    else standin.remove();
  }
  for (const [key, el] of embeds) if (!el.isConnected) embeds.delete(key);
}

async function loadPrototypePages(ids) {
  const [nodes, pages] = await Promise.all([
    tables.select(TABLES.nodes, { id: ids }),
    tables.select(TABLES.pages, { node: ids }),
  ]);
  return ids.flatMap((id) => {
    const page = pages.find((p) => p.node === id);
    const text = nodes.find((n) => n.id === id)?.text ?? "";
    return page ? [{ id, title: firstLine(text) || "Prototype", html: page.html }] : [];
  });
}

/** The children of `parent` as its layout in this view says (vertical, horizontal; free: renderFree). */
function renderList(parent, path) {
  const layout = layoutOf(menuCtx(), parent);
  if (layout === "free") return renderFree(parent, path);
  const kids = graph.children(parent);
  const list = h("div.list", { class: layout, dataset: { key: `list:${parent}` } });
  kids.forEach((g, i) => {
    list.append(gap(parent, i), renderItem(g, parent, path));
  });
  list.append(gap(parent, kids.length));
  const total = graph.childCount(parent);
  if (kids.length < total) {
    list.append(
      h(
        "button.more",
        {
          onclick: async () => {
            applyBundle(graph, await db.level([parent], kids.length));
            await need(edgeEnds());
            schedule();
          },
        },
        `${total - kids.length} more…`,
      ),
    );
  }
  if (S.adding?.parent === parent) list.append(renderAdder(parent));
  return list;
}

/** Between two rows: where a dragged row lands; hovering shows ＋ that adds a node there. */
function gap(parent, index) {
  return h(
    "div.gap",
    { dataset: { key: `gap:${parent}:${index}` } },
    h(
      "div.gap-zone",
      {
        dataset: { drop: "gap", parent, index: String(index) },
        title: "Add a node here",
        onclick: (e) => {
          e.stopPropagation();
          void addFresh(parent, index);
        },
      },
      h("span.gap-plus", "＋"),
    ),
  );
}

function startAdding(parent, index) {
  S.adding = { parent, index };
  S.adderText = "";
  schedule();
}

function renderAdder(parent) {
  const input = h("input.layr-input.adder", {
    placeholder: "New node: Enter adds it, Esc stops",
    value: S.adderText,
    dataset: { autofocus: "1", key: `adder:${parent}` },
  });
  input.oninput = () => (S.adderText = input.value);
  input.onkeydown = async (e) => {
    if (e.key === "Escape") {
      S.adding = null;
      schedule();
    } else if (e.key === "Enter" && input.value.trim()) {
      e.preventDefault();
      const text = input.value.trim();
      input.value = S.adderText = "";
      const index = S.adding.index;
      S.adding = { parent, index: index + 1 };
      await run(() => ops.addNewChild(parent, text, index));
    }
  };
  input.onblur = () =>
    setTimeout(() => {
      // A render puts a new input in its place (and focus there): only a real blur away from it stops adding.
      if (!input.isConnected || document.activeElement?.classList.contains("adder")) return;
      if (S.adding?.parent === parent && !S.adderText.trim()) {
        S.adding = null;
        schedule();
      }
    }, 150);
  return h("div.adder-row", { dataset: { key: `adder-row:${parent}` } }, input);
}

/**
 * One child in its group: its row (grip, toggle, text, badges, tags, tools), summary, page, edges, and its children
 * when it is open. `free`: in a free layout (`order`: its place, when the order counts; `movable`: dragged there).
 */
function renderItem(g, parent, path, { free = false, order, movable = false } = {}) {
  const node = g.data.to;
  const n = graph.node(node);
  const count = graph.childCount(node);
  const open = count > 0 && isOpen(node);
  if (open && !graph.expanded.has(node)) void expand(node);
  const places = graph.parentCount(node);
  const threads = graph.threadCount(node);
  const summary = graph.summary(node);
  const layout = count > 0 ? layoutOf(menuCtx(), node) : "vertical";
  const at = { node, group: g.id, open };
  const selected = S.selection.includes(g.id);

  const head = h(
    "div.item-head",
    {
      class: [
        S.selected === node ? "picked" : "",
        selected ? "selected" : "",
        S.cursor === g.id && !S.selection.length ? "cursor" : "",
        n?.data.color ? "colored" : "",
        dimmed(graph, node, S.tagFilter) ? "dimmed" : "",
      ].join(" "),
      dataset: { node, group: g.id, color: n?.data.color ?? "", drop: "into", own: "" },
      // Ctrl or Shift+click anywhere on the row selects instead of typing; a click beside the text: the keys' row. In
      // a free layout a click selects the row (its text too; the innermost row clicked); a click on the text of the
      // row selected alone types in it.
      onmousedown: (e) => (several(e) || selectsFirst(e, g.id)) && e.preventDefault(),
      onclick: (e) => {
        if (e.target.closest("button, .grip")) return;
        if (several(e)) return selectClick(g.id, e.shiftKey);
        if (selectsFirst(e, g.id) || (e.currentTarget.closest(".free") && !e.target.closest(".node-text")))
          return selectRow(g.id);
        if (e.target.closest(".node-text")) return;
        S.cursor = g.id;
        S.selection = [];
        if (document.activeElement?.isContentEditable) document.activeElement.blur();
        schedule();
      },
      oncontextmenu: (e) => rowMenu(e, at),
    },
    h(
      "span.grip",
      {
        class: free ? "" : "hover-only",
        title:
          "Drag: move it (between rows, onto a node, onto a group above); Ctrl+drag: put it there too. " +
          "Click: select it (more rows: add it); double-click: its details",
        onpointerdown: (e) => (free && movable ? startFreeDrag(e, g.id, parent) : startMove(e, g.id)),
        ondblclick: () => void select(node),
      },
      "⠿",
    ),
    free && order !== undefined && h("span.order-badge", String(order)),
    h(
      "button.toggle",
      {
        class: count ? "" : "invisible",
        title: open ? "Close (Alt+click: everything inside)" : `Open (${count} inside; Alt+click: everything inside)`,
        "aria-label": open ? "Close" : "Open",
        onclick: (e) => {
          e.stopPropagation();
          void (e.altKey ? openAll([node], !open) : toggle(node));
        },
      },
      open ? "▾" : "▸",
    ),
    nodeText(node, g.id, "node-text", (e, typed) => rowKey(e, typed, g, parent)),
    count > 0 && !open && h("span.inside", String(count)),
    typeBadges(node),
    n?.data.prototype && h("span.badge-icon", { title: "A prototype: its page folds out below it" }, icon("proto", 13)),
    count > 0 &&
      layout !== "vertical" &&
      h("span.layout-mark", { title: `${LAYOUT_INFO[layout].label} in this view` }, LAYOUT_INFO[layout].mark),
    places > 1 &&
      h(
        "button.places",
        { title: `In ${places} groups: which ones`, onclick: (e) => (e.stopPropagation(), void showPlaces(node)) },
        `×${places}`,
      ),
    threads > 0 &&
      h(
        "button.places.threads",
        {
          title: "Threads that changed, mentioned or linked it: which ones",
          onclick: (e) => (e.stopPropagation(), void showThreads(node)),
        },
        `◷${threads}`,
      ),
    tagPills(node),
    h(
      "span.row-tools",
      h(
        "button.icon-button",
        { title: "Add a node inside", onclick: (e) => (e.stopPropagation(), void addInside(node)) },
        "+",
      ),
      h(
        "button.icon-button",
        {
          title: "More (right-click the row)",
          onclick: (e) => (e.stopPropagation(), void nodeMenu(at, below(e.currentTarget))),
        },
        "⋯",
      ),
    ),
  );
  longPress(head, at);
  const cycle = path.includes(node);
  return h(
    "div.item",
    { dataset: { key: g.id } },
    head,
    n?.data.image && renderPicture(node),
    S.summaries && summary && renderSummary(node, summary),
    n?.data.prototype && renderProto(node, g.id),
    renderEdgeChips(node, parent, free),
    open && cycle && h("div.layr-muted.small.cycle", "↻ shown above"),
    open && !cycle && h("div.item-children", renderList(node, [...path, node])),
    !open && S.adding?.parent === node && h("div.item-children", renderList(node, [...path, node])),
  );
}

/** Ctrl, ⌘ or Shift + click: selecting rows instead of typing in them. */
const several = (e) => (e.ctrlKey || e.metaKey || e.shiftKey) && e.button === 0;

/**
 * A plain click on the row `conn` (its head is `e.currentTarget`) in a free layout selects it before anything else:
 * unless it is selected alone already (a click on its text then types), or its text is being typed in.
 */
function selectsFirst(e, conn) {
  if (e.button !== 0 || several(e) || S.connecting) return false;
  const head = e.currentTarget;
  if (!head.closest(".free") || head.contains(document.activeElement)) return false;
  if (e.target.closest("button, .grip, [data-layr-link], a[data-web-link]")) return false;
  return !(S.selection.length === 1 && S.selection[0] === conn);
}

/** Select the row `conn` alone (what a click does in a free layout). */
function selectRow(conn) {
  if (document.activeElement?.isContentEditable) document.activeElement.blur();
  S.selection = [conn];
  S.cursor = conn;
  S.anchor = conn;
  schedule();
}

async function addInside(node) {
  if (S.viewId && !isOpen(node) && graph.childCount(node)) await toggle(node);
  else await expand(node);
  startAdding(node, graph.children(node).length);
}

// ---------- free layouts

/** Pan and zoom of the root laid out freely, as this panel left it there. */
const spotKey = () => `${S.viewId}/${S.root}`;
const spot = () => S.spots[spotKey()] ?? { x: 0, y: 0, zoom: 1 };
function setSpot(next) {
  S.spots[spotKey()] = { x: Math.round(next.x), y: Math.round(next.y), zoom: next.zoom };
  const keys = Object.keys(S.spots);
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete S.spots[k];
  const content = $("#main .canvas-content");
  if (content) content.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.zoom})`;
  const percent = $("#main .canvas-zoom");
  if (percent) percent.textContent = `${Math.round(next.zoom * 100)}%`;
  rememberSoon();
}
/** The root's canvas zoom (1 when it isn't free): dragging inside it divides by it. */
const canvasZoom = () => (layoutOf(menuCtx(), S.root) === "free" ? spot().zoom : 1);

/**
 * The root's children laid out freely, zoomed and panned: drag the background or scroll to pan, Ctrl + scroll (or
 * pinch) to zoom at the pointer, "Show all" to fit.
 */
function renderCanvas(root) {
  const s = spot();
  const zoomBy = (factor) => {
    const area = $("#main .canvas-area");
    const cur = spot();
    setSpot(zoomAt(cur, cur.zoom * factor, area.clientWidth / 2, area.clientHeight / 2));
  };
  return h(
    "div.canvas-area",
    {
      dataset: { key: `canvas:${root}` },
      onwheel: (e) => {
        e.preventDefault();
        const cur = spot();
        if (e.ctrlKey || e.metaKey) {
          const r = e.currentTarget.getBoundingClientRect();
          setSpot(zoomAt(cur, cur.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top));
        } else setSpot({ ...cur, x: cur.x - e.deltaX, y: cur.y - e.deltaY });
      },
      onpointerdown: (e) => startPan(e),
    },
    h(
      "div.canvas-content",
      { style: `transform: translate(${s.x}px, ${s.y}px) scale(${s.zoom})` },
      renderFree(root, [root]),
    ),
    h(
      "div.canvas-tools",
      h("button.icon-button", { title: "Zoom out (Ctrl + scroll)", onclick: () => zoomBy(1 / 1.25) }, "−"),
      h(
        "button.icon-button.canvas-zoom",
        {
          title: "Actual size",
          onclick: () => {
            const area = $("#main .canvas-area");
            setSpot(zoomAt(spot(), 1, area.clientWidth / 2, area.clientHeight / 2));
          },
        },
        `${Math.round(s.zoom * 100)}%`,
      ),
      h("button.icon-button", { title: "Zoom in (Ctrl + scroll)", onclick: () => zoomBy(1.25) }, "+"),
      h(
        "button.icon-button.fit",
        {
          title: "Show all",
          onclick: () => {
            const area = $("#main .canvas-area");
            const free = $("#main .canvas-content > .free");
            if (area && free) setSpot(fitAll(free.offsetWidth, free.offsetHeight, area.clientWidth, area.clientHeight));
          },
        },
        icon("fit", 14),
        " Show all",
      ),
    ),
  );
}

/**
 * Pointers down on the canvas: one pans, two pinch (zoom at their middle). The window hears the moves, as in
 * layr_code: in layr's Windows web views (input forwarded by the app) pointer capture loses the drag.
 */
const pointers = new Map();
let panEnd = null;
function startPan(e) {
  const area = e.currentTarget;
  if (e.target.closest(".free-item, .canvas-tools, button, a, [contenteditable], input")) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  e.preventDefault();
  // A mouse is one pointer: a pan whose release was missed (let go outside the panel) ends here.
  if (e.pointerType === "mouse") panEnd?.();
  if (!panEnd) pointers.clear();
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  area.classList.add("panning");
  document.body.classList.add("panning");
  let last = { pan: spot(), points: new Map(pointers) };
  const onMove = (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    if (ev.pointerType === "mouse" && !(ev.buttons & 1)) return end(); // let go where the panel didn't hear it
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const now = [...pointers.values()];
    const was = [...last.points.values()];
    if (now.length >= 2 && was.length >= 2) {
      const mid = (p) => ({ x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 });
      const dist = (p) => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1;
      const r = area.getBoundingClientRect();
      const [m0, m1] = [mid(was), mid(now)];
      const zoomed = zoomAt(last.pan, last.pan.zoom * (dist(now) / dist(was)), m0.x - r.left, m0.y - r.top);
      setSpot({ ...zoomed, x: zoomed.x + m1.x - m0.x, y: zoomed.y + m1.y - m0.y });
    } else if (now.length === 1 && was.length >= 1) {
      const [a] = now;
      const b = last.points.get(ev.pointerId) ?? a;
      setSpot({ ...last.pan, x: last.pan.x + a.x - b.x, y: last.pan.y + a.y - b.y });
    }
    last = { pan: spot(), points: new Map(pointers) };
  };
  const onUp = (ev) => {
    if (!pointers.delete(ev.pointerId)) return;
    last = { pan: spot(), points: new Map(pointers) };
    if (!pointers.size) end();
  };
  const end = () => {
    pointers.clear();
    panEnd = null;
    area.classList.remove("panning");
    document.body.classList.remove("panning");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  if (pointers.size === 1) {
    panEnd = end;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }
}

/** How the free layout of `parent` arranges its children: automatically (a kind), or by hand (null). */
const arrangeOf = (parent) => look(parent)?.arrange ?? null;

/** Where a child of a free layout sits: where it was put by hand, else a first place in three columns. */
function handPos(parent, conn, i) {
  const l = look(graph.group(conn)?.data.to);
  const first = firstPlace(i);
  return { x: l?.x ?? first.x, y: l?.y ?? first.y };
}

/** Where each child of the free layout of `parent` is drawn (top lefts, by group conn). */
function freePositions(parent, kids) {
  const auto = arrangeOf(parent);
  const made = auto ? S.generated.get(parent) : null;
  return new Map(kids.map((g, i) => [g.id, made?.get(g.id) ?? handPos(parent, g.id, i)]));
}

/**
 * The children of `parent` placed where they were dragged (by hand) or by an automatic arrangement, with the edges
 * between them and (when it counts) their order drawn as arrows. Below the root they sit in a scroll area of a size
 * set by dragging its corner, or in an area that grows to fit (`overflow`).
 */
function renderFree(parent, path) {
  if (graph.children(parent).length < Math.min(FREE_MAX, graph.childCount(parent))) void loadAll(parent);
  const kids = graph.children(parent);
  const auto = arrangeOf(parent);
  const movable = !auto || auto === "tidy";
  const ordered = !graph.node(parent)?.data.unordered;
  const pos = freePositions(parent, kids);
  if (freeDrag?.parent === parent && pos.has(freeDrag.conn)) pos.set(freeDrag.conn, { x: freeDrag.x, y: freeDrag.y });
  const boxes = new Map(
    kids.map((g) => {
      const s = S.sizes.get(g.id);
      return [g.id, { ...pos.get(g.id), w: s?.w ?? 200, h: s?.h ?? 40 }];
    }),
  );
  const size = areaSize([...boxes.values()]);
  const marker = `m${parent.slice(0, 8)}`;
  const at = (node) => boxes.get(graph.membership(parent, node)?.id);
  const lines = [];
  if (ordered && useOrderOf(graph, menuCtx(), parent)) {
    kids.slice(1).forEach((g, i) => {
      const [a, b] = [boxes.get(kids[i].id), boxes.get(g.id)];
      const s = segment(a, b);
      lines.push(
        h("line.order-line", {
          x1: s.a.x,
          y1: s.a.y,
          x2: s.b.x,
          y2: s.b.y,
          "marker-end": `url(#${marker}-o)`,
          dataset: { a: kids[i].id, b: g.id },
        }),
      );
    });
  }
  for (const e of graph.edgesBetween(parent)) {
    const [a, b] = [at(e.data.from), at(e.data.to)];
    if (!a || !b) continue;
    const s = segment(a, b);
    const name = edgeName(graph, e);
    const ends = { a: graph.membership(parent, e.data.from).id, b: graph.membership(parent, e.data.to).id };
    lines.push(
      h(
        "g",
        { dataset: ends },
        h("line.edge-line", { x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y, "marker-end": `url(#${marker}-e)` }),
        name &&
          h("text.edge-label", { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 - 4, "text-anchor": "middle" }, name),
      ),
    );
  }
  const arrow = (id, size, cls) =>
    h(
      "marker",
      { id, viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: size, markerHeight: size, orient: "auto" },
      h("path", { d: "M0,0 L10,5 L0,10 z", class: cls }),
    );
  const area = h(
    "div.free",
    {
      class: auto && !S.generated.get(parent) ? "pending" : "",
      dataset: { drop: "free", parent, key: `free:${parent}` },
      style: `width: ${size.w}px; height: ${size.h}px`,
    },
    h(
      "svg.free-svg",
      { width: size.w, height: size.h },
      h("defs", arrow(`${marker}-o`, 6, "order-head"), arrow(`${marker}-e`, 7, "edge-head")),
      lines,
    ),
    kids.map((g, i) => {
      const p = pos.get(g.id);
      const w = look(g.data.to)?.w ?? (freeDrag?.conn === g.id ? freeDrag.w : undefined);
      return h(
        "div.free-item",
        {
          class: `${w ? "sized" : ""} ${freeDrag?.conn === g.id ? "dragging" : ""}`.trim(),
          dataset: { group: g.id, key: `free-item:${g.id}`, color: graph.node(g.data.to)?.data.color ?? "" },
          style: `left: ${p.x}px; top: ${p.y}px;${w ? ` width: ${w}px;` : ""}`,
          // A click in the box beside its rows selects it.
          onclick: (e) => {
            const inner =
              ".item-head, button, a, input, textarea, [contenteditable], .width-handle, .edge-chip, .proto, .node-picture";
            if (e.button === 0 && !several(e) && !S.connecting && !e.target.closest(inner)) selectRow(g.id);
          },
        },
        renderItem(g, parent, path, { free: true, order: ordered ? i + 1 : undefined, movable }),
        h("span.width-handle", {
          title: "Drag to set its width; double-click: as wide as its text",
          onpointerdown: (e) => startWidthDrag(e, g.id),
          ondblclick: () => void setLook(g.data.to, { w: null }),
        }),
      );
    }),
  );
  if (parent === S.root) return area;
  const l = look(parent);
  const grow = l?.overflow === "grow";
  return h(
    "div.free-wrap",
    { dataset: { key: `free-wrap:${parent}` } },
    h(
      "div.free-bar",
      h("button.arrange-button", { title: "Add a node here", onclick: () => void addFresh(parent) }, "＋ Add"),
      auto && h("span.layr-muted.small", `Arranged: ${auto}`),
    ),
    grow
      ? h("div.free-grow", area)
      : h(
          "div.free-scroll",
          {
            dataset: { parent },
            style: `width: ${l?.area_w ?? AREA.w}px; height: ${l?.area_h ?? AREA.h}px`,
          },
          h("div.free-scroll-inner", { dataset: { scroll: parent } }, area),
          h("span.corner-handle", { title: "Drag to resize", onpointerdown: (e) => startAreaDrag(e, parent) }),
        ),
  );
}

/** Follow the pointer from `e`, in the free layout's own pixels (the canvas zoom undone). */
function follow(e, move, done) {
  e.preventDefault();
  e.stopPropagation();
  const [sx, sy] = [e.clientX, e.clientY];
  const scale = canvasZoom();
  const onMove = (ev) => move((ev.clientX - sx) / scale, (ev.clientY - sy) / scale, ev);
  const onUp = (ev) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    done(ev);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

function startWidthDrag(e, conn) {
  const item = e.currentTarget.closest(".free-item");
  const start = item.offsetWidth;
  let w = start;
  follow(
    e,
    (dx) => {
      w = Math.round(Math.min(WIDTH.max, Math.max(WIDTH.min, start + dx)));
      item.style.width = `${w}px`;
    },
    () => w !== start && void setLook(graph.group(conn)?.data.to, { w }),
  );
}

function startAreaDrag(e, parent) {
  const frame = e.currentTarget.closest(".free-scroll");
  const shown = { w: frame.offsetWidth, h: frame.offsetHeight };
  let size = shown;
  follow(
    e,
    (dx, dy) => {
      size = { w: Math.round(Math.max(AREA_MIN.w, shown.w + dx)), h: Math.round(Math.max(AREA_MIN.h, shown.h + dy)) };
      frame.style.width = `${size.w}px`;
      frame.style.height = `${size.h}px`;
    },
    () => (size.w !== shown.w || size.h !== shown.h) && void setLook(parent, { area_w: size.w, area_h: size.h }),
  );
}

/** The child of a free layout being dragged: where it is drawn meanwhile (a render on the way keeps it there). */
let freeDrag = null;

/** Draw the lines of a free layout (its element `area`) that touch the child `conn` where its box is now. */
function redrawLines(area, conn) {
  const box = (id) => {
    const el = area.querySelector(`:scope > .free-item[data-group="${CSS.escape(id)}"]`);
    if (!el) return null;
    const s = S.sizes.get(id);
    return { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: s?.w ?? 200, h: s?.h ?? 40 };
  };
  const id = CSS.escape(conn);
  for (const line of area.querySelectorAll(`:scope > svg [data-a="${id}"], :scope > svg [data-b="${id}"]`)) {
    const [a, b] = [box(line.dataset.a), box(line.dataset.b)];
    if (!a || !b) continue;
    const s = segment(a, b);
    const l = line.tagName === "line" ? line : line.querySelector("line");
    for (const [k, v] of Object.entries({ x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y })) l?.setAttribute(k, v);
    const text = line.querySelector?.("text");
    text?.setAttribute("x", (s.a.x + s.b.x) / 2);
    text?.setAttribute("y", (s.a.y + s.b.y) / 2 - 4);
  }
}

/**
 * Drag a child of a free layout: where it is put in this layout (saved once dropped), or, dropped on another node,
 * a list or another free layout, into that group (Ctrl: put there too). Without moving, a click selects it. The box
 * follows each move right away (as in layr_code), keeping its width, with its lines.
 */
function startFreeDrag(e, conn, parent) {
  const item = e.currentTarget.closest(".free-item");
  const area = item.parentElement;
  const start = { x: parseFloat(item.style.left) || 0, y: parseFloat(item.style.top) || 0 };
  const startWidth = item.style.width;
  const grab = targetAt(e.clientX, e.clientY);
  const offset = grab?.target.kind === "free" ? { x: grab.target.x - start.x, y: grab.target.y - start.y } : null;
  const scale = canvasZoom();
  const [sx, sy] = [e.clientX, e.clientY];
  let here = null;
  const conns = dragged(conn);
  const own = (t) => !t || (t.kind === "free" && t.parent === parent);
  const put = (p) => {
    item.style.left = `${p.x}px`;
    item.style.top = `${p.y}px`;
    redrawLines(area, conn);
  };
  dragFrom(e, {
    label: conns.length > 1 ? `${conns.length} nodes` : label(graph.group(conn)?.data.to),
    accept: (t) => (t.kind === "free" && t.parent === parent) || acceptMove(graph, conns, t),
    quiet: (t) => conns.length === 1 && own(t),
    move: (x, y, t) => {
      if (!freeDrag) {
        // Its width stays as it is: near the layout's right edge a box would otherwise get narrower as it moves.
        freeDrag = { conn, parent, ...start, w: item.offsetWidth };
        item.style.width = `${freeDrag.w}px`;
        item.classList.add("dragging");
      }
      // It follows the pointer everywhere (as in layr_code); over another node or group the label says it goes there.
      const p =
        t?.kind === "free" && t.parent === parent && offset
          ? { x: t.x - offset.x, y: t.y - offset.y }
          : { x: start.x + (x - sx) / scale, y: start.y + (y - sy) / scale };
      here = { x: Math.max(0, Math.round(p.x)), y: Math.max(0, Math.round(p.y)) };
      Object.assign(freeDrag, here);
      put(here);
    },
    end: (dropped, cancelled) => {
      freeDrag = null;
      item.classList.remove("dragging");
      item.style.width = startWidth;
      if (cancelled) return put(start);
      // Let go past the layout's edge: where it was dragged to.
      if (!dropped && here && conns.length === 1) void setLook(graph.group(conn)?.data.to, { x: here.x, y: here.y });
    },
    click: () => selectOnly(conn),
    drop: (t, copy) => {
      if (t.kind === "free" && t.parent === parent && here) {
        if (conns.length > 1)
          return void dropNodes(
            conns.filter((c) => c !== conn),
            t,
            copy,
          );
        return void setLook(graph.group(conn)?.data.to, { x: here.x, y: here.y });
      }
      void dropNodes(conns, t, copy);
    },
  });
}

/** Measure free layouts' children; arrange those laid out automatically again when what they depend on changes. */
const layoutKeys = new Map();
const observer = new ResizeObserver(() => measureFree());
function measureFree() {
  let changed = false;
  for (const el of document.querySelectorAll("#main .free-item")) {
    observer.observe(el);
    const s = { w: el.offsetWidth, h: el.offsetHeight };
    const old = S.sizes.get(el.dataset.group);
    if (!old || old.w !== s.w || old.h !== s.h) {
      S.sizes.set(el.dataset.group, s);
      changed = true;
    }
  }
  for (const el of document.querySelectorAll("#main .free")) arrangeFree(el.dataset.parent);
  if (changed) schedule();
}

/** Arrange the children of `parent` automatically, off the main thread, when their sizes, edges or settings changed. */
function arrangeFree(parent) {
  const kind = arrangeOf(parent);
  if (!kind) {
    S.generated.delete(parent);
    layoutKeys.delete(parent);
    return;
  }
  const input = layoutInput(parent, kind, kind === "tidy");
  if (!input) return;
  const key = JSON.stringify(input);
  if (layoutKeys.get(parent) === key) return;
  layoutKeys.set(parent, key);
  const kids = graph.children(parent).map((g) => g.id);
  void layOut(input).then((at) => {
    if (layoutKeys.get(parent) !== key) return;
    S.generated.set(parent, new Map(kids.map((id, i) => [id, at[i]])));
    schedule();
  });
}

/** What an arrangement needs: the children's sizes, the edges between them, their order; `fromHand`: where they are. */
function layoutInput(parent, kind, fromHand = false, now) {
  const kids = graph.children(parent);
  if (kids.some((g) => !S.sizes.get(g.id))) return null;
  const index = new Map(kids.map((g, i) => [g.data.to, i]));
  const edges = graph.edgesBetween(parent).flatMap((e) => {
    const [a, z] = [index.get(e.data.from), index.get(e.data.to)];
    return a !== undefined && z !== undefined ? [[a, z]] : [];
  });
  return {
    arrange: kind,
    useOrder: useOrderOf(graph, menuCtx(), parent),
    edges,
    boxes: kids.map((g, i) => {
      const s = S.sizes.get(g.id);
      const at = now?.get(g.id) ?? (fromHand ? handPos(parent, g.id, i) : { x: 0, y: 0 });
      return { w: step(s.w), h: step(s.h), ...at };
    }),
  };
}

/** Arrange the children of `parent` once and save where they end up: by hand from then on. */
async function arrangeOnce(parent, kind) {
  if (!S.viewId) return;
  await loadAll(parent);
  const kids = graph.children(parent);
  const input = layoutInput(parent, kind, false, freePositions(parent, kids));
  if (!input) return layr.ui.notify("Show it first: open it, laid out freely, then try again", "error");
  const at = await layOut(input);
  await run(async () => {
    await ops.placeAll(
      S.viewId,
      kids.map((g, i) => ({ node: g.data.to, ...at[i] })),
    );
    if (arrangeOf(parent)) await ops.setLook(S.viewId, parent, { arrange: null });
  });
}

function afterRender() {
  requestAnimationFrame(measureFree);
  restoreScrolls();
}

// ---------- where things were scrolled (as in layr_code): the view, and each free layout's scroll area

const scrollKey = () => `${S.viewId}/${S.root}`;

/** Each scroller (`data-scroll`: "body", or a free layout's parent) shown anew goes back where it was left. */
function restoreScrolls() {
  const key = scrollKey();
  for (const el of document.querySelectorAll("#main [data-scroll]")) {
    if (el.__scroll !== key) {
      el.__scroll = key;
      el.__want = S.scrolls[key]?.[el.dataset.scroll] ?? null;
      el.__until = Date.now() + 2000;
    }
    if (!el.__listening) {
      el.__listening = true;
      el.addEventListener("scroll", () => !el.__want && keepScroll(el), { passive: true });
      // The user scrolls first: what was left gives way.
      for (const type of ["wheel", "pointerdown", "keydown", "touchstart"])
        el.addEventListener(type, () => (el.__want = null), { passive: true });
    }
    const want = el.__want;
    if (!want) continue;
    el.scrollLeft = want[0];
    el.scrollTop = want[1];
    // Rows still loading: tried again on the next renders, for two seconds.
    const there = Math.abs(el.scrollLeft - want[0]) < 2 && Math.abs(el.scrollTop - want[1]) < 2;
    if (there || Date.now() > el.__until) el.__want = null;
  }
}

function keepScroll(el) {
  const key = el.__scroll;
  if (!key || (el.dataset.scroll === "body" && el.classList.contains("canvas"))) return;
  const at = { ...S.scrolls[key], [el.dataset.scroll]: [Math.round(el.scrollLeft), Math.round(el.scrollTop)] };
  delete S.scrolls[key];
  S.scrolls[key] = at;
  const keys = Object.keys(S.scrolls);
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete S.scrolls[k];
  rememberSoon();
}

// ---------- dragging rows

/** The rows a drag of `conn` takes along: the selection when it is part of it, else only it. */
const dragged = (conn) => (S.selection.includes(conn) && S.selection.length > 1 ? targets() : [conn]);

/** A click on ⠿: that row selected, or, while rows are selected, it joins them or leaves (a phone has no Ctrl). */
function selectOnly(conn) {
  if (S.selection.length && !(S.selection.length === 1 && S.selection[0] === conn)) return selectClick(conn, false);
  S.selection = [conn];
  S.cursor = conn;
  S.anchor = conn;
  schedule();
}

/** Drag rows from ⠿ (anywhere they aren't placed by hand); a click selects the row. */
function startMove(e, conn) {
  const conns = dragged(conn);
  dragFrom(e, {
    label: conns.length > 1 ? `${conns.length} nodes` : label(graph.group(conn)?.data.to),
    accept: (t) => acceptMove(graph, conns, t),
    drop: (t, copy) => void dropNodes(conns, t, copy),
    click: () => selectOnly(conn),
  });
}

// ---------------------------------------------------------------- typing in a row (as in layr_code's view.tsx)

/** Nodes this panel just made empty for typing (Enter, Ctrl+Enter): one still empty when typing leaves it goes away. */
const fresh = new Set();

/** The text of the row `key` (a group conn, or "root"). */
const rowText = (key) => $(key === "root" ? "#main .root-text" : `#main .item-head[data-group="${key}"] .node-text`);
/** What is typed in a node's text: its lines, without the empty last line the browser keeps after a line break. */
const textOf = (el) => el.innerText.replace(/\n$/, "");

function caretAtEnd(el) {
  el.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  el.scrollIntoView({ block: "nearest" });
}

/** Type in the row `key` after the next render (it may only be there then), the caret at the end. */
function focusRow(key) {
  S.focus = key;
  schedule();
}

/** A new empty child of `parent` at `index` (none: last), typed in right away. */
async function addFresh(parent, index) {
  if (S.viewId && parent !== S.root && graph.childCount(parent) && !isOpen(parent)) await toggle(parent);
  const made = await run(() => ops.addNewChild(parent, "", index));
  if (!made) return;
  fresh.add(made.node);
  S.adding = null;
  focusRow(made.group);
  return made;
}

/** A new empty child of `node`, last; the row `group` it shows through opens to show it (Ctrl+Enter). */
async function addChildFresh(node, group) {
  if (group && !S.viewId) return addInside(node); // no view keeps it open: the adder below it
  if (group && !isOpen(node)) await run(() => ops.setLook(S.viewId, node, { open: true }));
  await expand(node).catch((e) => layr.ui.notify(e.message, "error"));
  await addFresh(node);
}

/** Show a node's stored text in its element: Markdown formatted (links as chips), or plain. */
function showStored(el, text) {
  const t = (text ?? "").trim();
  if (hasMarkdown(t)) {
    el.innerHTML = renderMarkdown(t);
    el.classList.add("markdown");
  } else {
    el.textContent = t;
    el.classList.remove("markdown");
  }
}

/**
 * A node's text in its row (or the root's title), typed in place: a click puts the caret there, and what is typed is
 * saved shortly after typing stops, and when typing leaves it. It shows as Markdown until it is typed in (layr links
 * as chips that open, web links opening outside). `onKey(e, typed)` gets its keys, `typed` = {el, flush, text}.
 */
function nodeText(node, key, cls, onKey) {
  const stored = () => graph.node(node)?.data.text ?? "";
  const el = h(`div.${cls}`, { contentEditable: "plaintext-only", dataset: { node } });
  el.spellcheck = false;
  showStored(el, stored());
  let timer;
  let pendingText;
  const flush = () => {
    clearTimeout(timer);
    if (pendingText === undefined) return;
    const text = textToSave(pendingText, stored());
    pendingText = undefined;
    if (text !== null && graph.node(node)) void run(() => ops.updateNode(node, { text }));
  };
  el.addEventListener("mousedown", (e) => {
    // A link chip or a web link in the text opens instead of putting the caret there.
    const chip = document.activeElement !== el && e.target.closest("[data-layr-link], a[data-web-link]");
    if (chip && e.button === 0 && !several(e)) {
      e.preventDefault();
      if (chip.dataset.layrLink) openLink(chip.dataset.layrLink);
      else openWeb(chip.getAttribute("href"));
      return;
    }
    // A right-click on a text that isn't typed in opens the node's menu without putting the caret in it first.
    if (e.button === 2 && document.activeElement !== el) e.preventDefault();
  });
  el.addEventListener("click", (e) => e.target.closest("a") && e.preventDefault());
  el.addEventListener("focus", () => {
    S.editing = key;
    if (key !== "root") {
      S.cursor = key;
      S.selection = [];
    }
    if (S.adding && !S.adderText.trim()) S.adding = null;
    const raw = stored();
    if (el.classList.contains("markdown") || el.textContent !== raw) {
      // Typed as it is stored (Markdown, links), the caret at its end (as layr_code did).
      el.classList.remove("markdown");
      el.textContent = raw;
      setTimeout(() => document.activeElement === el && caretAtEnd(el), 0);
    }
  });
  el.addEventListener("input", () => {
    pendingText = textOf(el);
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  });
  el.addEventListener("keydown", (e) => void onKey(e, { el, flush, text: textOf(el).trim() }));
  el.addEventListener("paste", (e) => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    fresh.delete(node);
    void setPicture(node, file);
  });
  el.addEventListener("blur", (e) => {
    flush();
    if (S.editing === key) S.editing = null;
    // Gone (Tab moved it: typing goes on elsewhere), or another window took the focus (it comes back here).
    if (!el.isConnected || !document.hasFocus()) return;
    const empty = !textOf(el).trim();
    if (fresh.has(node)) {
      // A button on its own row (+, ⋯): it is still being worked on.
      if (e.relatedTarget && el.closest(".item-head, .root-row")?.contains(e.relatedTarget)) return;
      fresh.delete(node);
      const bare = !graph.childCount(node) && !graph.node(node)?.data.image && graph.parentCount(node) <= 1;
      if (empty && bare) {
        if (key !== "root") el.closest(".item")?.remove();
        return void run(() => ops.deleteNode(node));
      }
    }
    // Emptied: it keeps its text (Backspace in an empty node deletes it).
    showStored(el, stored());
    schedule();
  });
  return el;
}

/** Keys while a child's text is typed in its row `g` (a group conn of `parent`). */
async function rowKey(e, { el, flush, text }, g, parent) {
  const node = g.data.to;
  const deletable =
    !graph.childCount(node) &&
    graph.parentCount(node) <= 1 &&
    !graph.node(node)?.data.image &&
    !graph.summary(node) &&
    !graph.edgesOf(node).length;
  const action = editAction(e, { empty: !text, deletable });
  if (!action) return;
  e.preventDefault();
  flush();
  if (text) fresh.delete(node);
  const siblings = graph.children(parent);
  const index = siblings.findIndex((c) => c.id === g.id);
  if (action === "stop") {
    // Stop typing; the row stays the one the keys work on.
    S.cursor = g.id;
    el.blur();
  } else if (action === "sibling") {
    // Enter in a new node still empty: done adding (it goes away), else a new node below.
    if (!text && fresh.has(node)) return el.blur();
    const made = await addFresh(parent, index + 1);
    // A new sibling in a free layout by hand goes right below the one Enter was pressed in.
    if (made && layoutOf(menuCtx(), parent) === "free" && !arrangeOf(parent)) {
      const item = el.closest(".free-item");
      if (item) {
        const x = parseFloat(item.style.left) || 0;
        const y = (parseFloat(item.style.top) || 0) + item.offsetHeight + 12;
        void setLook(made.node, { x, y });
      }
    }
  } else if (action === "child") {
    await addChildFresh(node, g.id);
  } else if (action === "indent") {
    // Into the node above, as its last child.
    const above = siblings[index - 1]?.data.to;
    if (!above) return;
    if (S.viewId && !isOpen(above)) await run(() => ops.setLook(S.viewId, above, { open: true }));
    await expand(above).catch(() => {});
    const moved = await run(() => ops.moveToGroup(g.id, above));
    if (moved) focusRow(moved);
  } else if (action === "outdent") {
    // Out of its group, right after it in the group above.
    const parentConn = el.closest(".item-children")?.closest(".item")?.querySelector(".item-head")?.dataset.group;
    const grand = parentConn && graph.group(parentConn)?.data.from;
    if (!grand) return;
    const at = graph.children(grand).findIndex((c) => c.id === parentConn) + 1;
    const moved = await run(() => ops.moveToGroup(g.id, grand, at));
    if (moved) focusRow(moved);
  } else if (action === "delete") {
    fresh.delete(node);
    el.blur();
    await run(() => ops.deleteNode(node));
    if (siblings[index - 1]) focusRow(siblings[index - 1].id);
  } else if (action === "up" || action === "down") {
    await moveBy(g.id, action === "up" ? -1 : 1);
    focusRow(g.id);
  }
}

/** Keys while the root's title is typed: Enter adds a first child, Ctrl+Enter a last one; Esc stops. */
async function rootKey(e, { el, flush }) {
  const action = editAction(e);
  if (action !== "stop" && action !== "sibling" && action !== "child") return;
  e.preventDefault();
  flush();
  if (action === "stop") el.blur();
  else await addFresh(S.root, action === "sibling" ? 0 : undefined);
}

/** Keys on the outline while nothing is typed: walking and selecting rows, and what a row's menu does. */
function onViewKey(e) {
  if (e.defaultPrevented || modalOpen() || S.mode !== "ready" || $(".menu-layer")) return;
  const t = e.target;
  if (t.isContentEditable || t.closest?.("input, textarea, select")) return;
  if (e.altKey && e.key === "ArrowLeft" && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
    e.preventDefault();
    return void goBack();
  }
  if (t.closest?.(".side, .details")) return;
  const action = rowAction(e);
  if (!action || (t.closest?.("button") && ["edit", "toggle", "child"].includes(action))) return;
  if (action === "clear") {
    if (!S.cursor && !S.selection.length && !S.connecting) return;
    if (S.connecting) S.connecting = null;
    else {
      S.cursor = null;
      S.selection = [];
    }
    schedule();
    return e.preventDefault();
  }
  const rows = visibleRows();
  const c = rows.includes(S.cursor) ? S.cursor : null;
  const go = (key) => {
    if (!key) return;
    S.cursor = key;
    S.selection = [];
    S.anchor = key;
    schedule();
    rowHead(key)?.scrollIntoView({ block: "nearest" });
  };
  if (action === "prev" || action === "next") {
    e.preventDefault();
    if (!c) return go(rows[action === "next" ? 0 : rows.length - 1]);
    return go(rows[rows.indexOf(c) + (action === "next" ? 1 : -1)]);
  }
  if (action === "extend-up" || action === "extend-down") {
    e.preventDefault();
    if (!c) return go(rows[action === "extend-down" ? 0 : rows.length - 1]);
    const next = extendSelection(rows, S.anchor ?? c, c, action === "extend-down" ? 1 : -1);
    if (!next) return;
    Object.assign(S, next);
    schedule();
    return rowHead(next.cursor)?.scrollIntoView({ block: "nearest" });
  }
  if (action === "select-children" || action === "select-parents") {
    e.preventDefault();
    const from = targets();
    if (from.length) void selectRelated(from, action === "select-children" ? "children" : "parents");
    return;
  }
  const g = c && graph.group(c);
  if (!g) return;
  e.preventDefault();
  const head = rowHead(c);
  const node = g.data.to;
  const count = graph.childCount(node);
  const open = count > 0 && isOpen(node);
  if (action === "right") {
    if (count && !open) void toggle(node);
    else if (open) go(head.parentElement.querySelector(".item-children .item-head[data-group]")?.dataset.group);
  } else if (action === "left") {
    if (open) void toggle(node);
    else go(head.closest(".item-children")?.closest(".item")?.querySelector(".item-head")?.dataset.group);
  } else if (action === "up" || action === "down") void moveBy(c, action === "up" ? -1 : 1);
  else if (action === "child") void addChildFresh(node, c);
  else if (action === "edit") focusRow(c);
  else if (action === "details") void select(node);
  else if (action === "toggle") count && void toggle(node);
  else if (action === "remove") void removeRows(targets());
  else if (action === "connect") startConnecting(targetNodes());
  else if (action === "tags") void showMenu(nodeMenuTags(targetNodes()), below(head));
  else if (action === "move") void moveBySearch(targets(), false);
  else if (action === "menu") void nodeMenu({ node, group: c, open }, below(head.querySelector(".node-text") ?? head));
}
document.addEventListener("keydown", onViewKey);

/** Connecting by clicking: a click on a node (its row, the root's title, a breadcrumb) ends it there. */
document.addEventListener(
  "mousedown",
  (e) => S.connecting && e.target.closest("#main [data-node]") && !e.target.closest(".toggle") && e.preventDefault(),
  true,
);
document.addEventListener(
  "click",
  (e) => {
    const c = S.connecting;
    if (!c || e.target.closest(".connect-bar, .toggle, .menu-layer")) return;
    const el = e.target.closest("#main [data-node]");
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const to = el.dataset.node;
    if (c.from.includes(to)) return;
    S.connecting = null;
    schedule();
    void connectTo(c.from, to);
  },
  true,
);

// ---------------------------------------------------------------- menus

/** Where a menu opens for an element (a ⋯ button, a row from the keys): below it, at its left edge. */
const below = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2 };
};

/** Lay out the children of `nodes` this way in the view. */
async function setLayouts(nodes, layout) {
  if (!S.viewId) return;
  await run(async () => {
    for (const n of nodes) await ops.setLook(S.viewId, n, { layout });
  });
  if (layout === "free") for (const n of nodes) void loadAll(n);
}

/** What the items of the menus (panels/nodemenu.js) do. */
const menuActions = {
  ...edgeActs,
  ...tagActs,
  edit: (node) => void select(node),
  addInside: (node, group) => void (group ? addChildFresh(node, group) : addFresh(node)),
  addBelow: (group) => {
    const g = graph.group(group);
    if (g) void addFresh(g.data.from, graph.children(g.data.from).findIndex((c) => c.id === group) + 1);
  },
  putInside: (node, group) => void putInside(node, group),
  toggle: (node) => void toggle(node),
  focusRoot: (node) => void focusRoot(node),
  protoOpen: (node, open) => void setLook(node, { proto_open: open }),
  openPrototypes: (nodes) => openPrototypes(nodes),
  select: (related) => void selectRelated(S.menuPlaces ?? targets(), related),
  summary: (node) => void editSummary(node),
  summarize: (node) => void editSummary(node, true),
  newTag: (nodes) => void newTag(nodes),
  setColor: (nodes, color) =>
    void run(async () => {
      for (const n of nodes) if ((graph.node(n)?.data.color ?? null) !== color) await ops.updateNode(n, { color });
    }),
  setUnordered: (node, unordered) => void run(() => ops.updateNode(node, { unordered })),
  setLayout: (nodes, layout) => void setLayouts(nodes, layout),
  arrange: (nodes, kind) =>
    void run(async () => {
      for (const n of nodes) await ops.setLook(S.viewId, n, { arrange: kind });
    }),
  arrangeOnce: (nodes, kind) =>
    void (async () => {
      for (const n of nodes) await arrangeOnce(n, kind);
    })(),
  useOrder: (nodes, on) =>
    void run(async () => {
      for (const n of nodes) await ops.setLook(S.viewId, n, { use_order: on });
    }),
  overflow: (nodes, overflow) =>
    void run(async () => {
      for (const n of nodes) await ops.setLook(S.viewId, n, { overflow });
    }),
  openAll: (nodes, open) => void openAll(nodes, open),
  connect: (nodes) => startConnecting(nodes),
  move: (group, delta) => void moveBy(group, delta),
  moveTo: (conns) => void moveBySearch(conns, false),
  alsoIn: (node, group) => void alsoIn(node, group),
  alsoInMany: (conns) => void moveBySearch(conns, true),
  copyLink: (node, kind) =>
    void copyText(
      graph.node(node)?.data.prototype && kind !== "node" ? prototypeLink(label(node), node) : nodeMarkdownLink(node),
    ),
  sendToPipeline: (node) => void sendToPipeline(node),
  linkTask: (node) => void linkTask(node),
  unlink: (node) => void unlink(node),
  askClaude: (node) => void askClaude(node),
  makeIdea: (node) => void askClaude(node, true),
  picture: (node) => choosePicture(node),
  removePicture: (node) => void removePicture(node),
  newViewOf: (node) => void newView(node),
  renameView: () => void renameView(),
  history: (node) => void showHistory(node),
  deleteView: () => void deleteView(),
  takeOut: (conns) => void removeRows(conns),
  delete: (node) => void deleteNode(node),
};

/** The tags submenu's items for `nodes` (the selection bar's Tags…, the T key). */
const nodeMenuTags = (nodes) => tagItems(graph, nodes, menuActions);

/**
 * A node's menu at `where` (a mouse event, or {x, y} in the page), drawn by the shell (layr.ui.contextMenu, which runs
 * the picked item), else our own. On one of several selected rows, the menu for all of them.
 */
async function nodeMenu(at, where) {
  const bulk = at.group && S.selection.length > 1 && S.selection.includes(at.group);
  S.menuPlaces = bulk ? targets() : [at.group ?? null];
  const items = bulk
    ? bulkMenuItems(graph, targets(), menuActions, menuCtx())
    : nodeMenuItems(
        graph,
        { ...at, parent: at.root ? undefined : graph.group(at.group)?.data.from },
        menuActions,
        menuCtx(),
      );
  if (!items.length) return;
  try {
    await showMenu(items, where);
  } catch (error) {
    layr.ui.notify(error.message ?? String(error), "error");
  }
}

/**
 * Right-click on a row: its menu. While its text is typed in, the browser's own menu (copy, paste); a long-press on a
 * phone that already opened the menu only keeps the browser's away.
 */
function rowMenu(e, at) {
  const t = e.target;
  if (t.isContentEditable && document.activeElement === t) return;
  if (t.closest(".edge-chip, .type-badge, .tag-pill")) return;
  e.preventDefault();
  if (Date.now() - longPressed < 1000) return;
  void nodeMenu(at, e);
}

/** When a long-press last opened a menu (its click and the phone's own contextmenu event that follow are skipped). */
let longPressed = 0;
/** A finger held on a row for half a second: its menu, at the finger. */
function longPress(head, at) {
  let timer;
  let start;
  const cancel = () => clearTimeout(timer);
  head.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    if (e.target.isContentEditable && document.activeElement === e.target) return; // selecting text
    if (e.target.closest("button, .grip")) return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => {
      longPressed = Date.now();
      void nodeMenu(at, start);
    }, 500);
  });
  head.addEventListener("pointermove", (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) head.addEventListener(type, cancel);
  head.addEventListener(
    "click",
    (e) => {
      if (Date.now() - longPressed > 1000) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

// ---------------------------------------------------------------- details

function section(title, ...body) {
  return h("section.d-section", h("h4.d-title", title), ...body);
}

function renderDetails(node) {
  const n = graph.node(node);
  if (!n) return [];
  const groups = graph.incoming(node, "group");
  const here = groups.find((g) => g.data.from === S.root) ?? groups.find((g) => graph.node(g.data.from));
  const summary = graph.summary(node);
  const title = h("textarea.layr-textarea.d-text", { rows: 2, value: n.data.text, "aria-label": "Text" });
  title.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      title.blur();
    }
  };
  title.onblur = () => {
    const value = title.value.trim();
    if (value && value !== n.data.text) void run(() => ops.updateNode(node, { text: value }));
  };
  const color = h(
    "select.layr-select.small-select",
    { "aria-label": "Colour" },
    h("option", { value: "" }, "No colour"),
    ...TAG_COLORS.filter((c) => c !== "gray").map((c) => h("option", { value: c, selected: n.data.color === c }, c)),
  );
  color.onchange = () => void run(() => ops.updateNode(node, { color: color.value || null }));
  const pic = S.pictures.get(node);
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", hidden: true });
  file.onchange = () => file.files[0] && void setPicture(node, file.files[0]);
  const edges = graph.edgesOf(node);
  const threads = S.threads.get(node) ?? [];
  const html = S.pages.get(node);

  return clean([
    h(
      "div.d-head",
      h("span.d-kicker", n.data.prototype ? "Prototype" : "Node"),
      h("span.layr-spacer"),
      node !== S.root && iconButton("open", "Show it as the root", () => void focusRoot(node)),
      iconButton(
        "more",
        "More",
        (e) => void nodeMenu({ node, root: node === S.root, group: here?.id }, below(e.currentTarget)),
      ),
      iconButton("close", "Close", () => void select(null)),
    ),
    title,
    hasMarkdown(n.data.text) &&
      h("div.d-preview.markdown", { innerHTML: renderMarkdown(n.data.text), onclick: previewClick }),
    h(
      "div.d-row",
      tagPills(node),
      h(
        "button.layr-button.small",
        { onclick: (e) => void showMenu(nodeMenuTags([node]), below(e.currentTarget)) },
        "+ Tag",
      ),
    ),
    section(
      "Summary",
      summary
        ? renderSummary(node, summary)
        : h("button.layr-button.small", { onclick: () => void editSummary(node) }, "Write a summary"),
    ),
    n.data.prototype &&
      section(
        "Page",
        h(
          "div.d-actions",
          S.viewId &&
            h(
              "button.layr-button.small",
              { onclick: () => void setLook(node, { proto_open: !look(node)?.proto_open }) },
              look(node)?.proto_open ? "Fold it away in the map" : "Show it under the node",
            ),
          h("button.layr-button.small", { onclick: () => openPrototypes([node]) }, "Open it big"),
          html !== undefined && h("span.layr-muted", `${Math.round(html.length / 1000)} k characters`),
        ),
      ),
    n.data.image &&
      section(
        "Picture",
        pic?.url
          ? h("img.d-picture", { src: pic.url, alt: pic.row.caption || "Picture" })
          : h("span.layr-muted", "Loading…"),
        pic?.row.caption && h("div.layr-muted", pic.row.caption),
      ),
    section(
      `Edges · ${edges.length}`,
      edges.length > 0 &&
        h(
          "ul.d-edges",
          edges.map((e) =>
            h(
              "li",
              { dataset: { key: e.id } },
              h(
                "button.link",
                {
                  title: "The edge's menu",
                  onclick: (ev) => edgeMenu(e.id, node, here?.data.from, below(ev.currentTarget)),
                },
                edgeText(graph, e, node),
              ),
              e.data.in && h("span.layr-muted", ` only in ${label(e.data.in)}`),
            ),
          ),
        ),
      h("button.layr-button.small", { onclick: () => startConnecting([node]) }, "Connect to…"),
    ),
    section(
      `In ${groups.length} group${groups.length === 1 ? "" : "s"}`,
      h(
        "ul.d-places",
        groups.map((g) =>
          h(
            "li",
            h(
              "button.link",
              { onclick: () => void focusRoot(g.data.from) },
              graph.node(g.data.from) ? label(g.data.from) : "…",
            ),
          ),
        ),
      ),
      h(
        "div.d-actions",
        here && iconButton("up", "Move up", () => void moveBy(here.id, -1)),
        here && iconButton("down", "Move down", () => void moveBy(here.id, 1)),
        here && h("button.layr-button.small", { onclick: () => void moveBySearch([here.id], false) }, "Move to…"),
        h("button.layr-button.small", { onclick: () => void alsoIn(node) }, "Also in…"),
      ),
    ),
    section(
      `Threads · ${threads.length}`,
      threads.length > 0 &&
        h(
          "ul.d-threads",
          threads.map((t) =>
            h(
              "li",
              { dataset: { key: t.id } },
              h(
                "button.link",
                { onclick: () => t.href && openLink(t.href), title: t.href ?? "" },
                t.title || "Untitled thread",
              ),
              h(
                "div.layr-muted",
                [t.linked_at && "linked", t.changed_at && "changed it", t.mentioned_at && "mentioned it"]
                  .filter(Boolean)
                  .join(", ") + (t.note ? `: ${t.note}` : ""),
              ),
            ),
          ),
        ),
      h(
        "div.d-actions",
        S.plugins.pipeline &&
          h("button.layr-button.small", { onclick: () => void sendToPipeline(node) }, "Send to the pipeline…"),
        S.plugins.claude && h("button.layr-button.small", { onclick: () => void askClaude(node) }, "Ask Claude…"),
      ),
    ),
    section(
      "More",
      h(
        "div.d-actions",
        h("button.layr-button.small", { onclick: () => void addInside(node) }, "Add inside"),
        h(
          "label.check",
          h("input", {
            type: "checkbox",
            checked: !!n.data.unordered,
            onchange: (e) => void run(() => ops.updateNode(node, { unordered: e.target.checked })),
          }),
          " Order doesn't matter",
        ),
        color,
        h("button.layr-button.small", { onclick: () => file.click() }, pic ? "Change picture" : "Add picture"),
        pic && h("button.layr-button.small", { onclick: () => void removePicture(node) }, "Remove picture"),
        file,
      ),
      h(
        "div.d-actions.danger-zone",
        here && h("button.layr-button.small", { onclick: () => void removeRows([here.id]) }, "Take out of this group"),
        h("button.layr-button.small.danger", { onclick: () => void deleteNode(node) }, "Delete everywhere"),
      ),
    ),
  ]);
}

/** A click in the details' Markdown preview: links open. */
function previewClick(e) {
  const chip = e.target.closest("[data-layr-link], a[data-web-link]");
  if (!chip) return;
  e.preventDefault();
  if (chip.dataset.layrLink) openLink(chip.dataset.layrLink);
  else openWeb(chip.getAttribute("href"));
}

// ---------------------------------------------------------------- start

await cssReady;
layr.events.on("concepts:changed", () => {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(() => void refresh(), 400);
});
let changedTimer;
layr.events.on("concepts:refresh", () => void refresh());
document.addEventListener("visibilitychange", () => !document.hidden && S.mode !== "loading" && void refresh());
window.addEventListener("resize", () => schedule());
window.addEventListener("pagehide", () => rememberTimer && remember());

async function onParams(params = {}) {
  if (params.newView) await newView();
  if (params.search) {
    S.side = true;
    schedule();
    setTimeout(() => $("#search")?.focus(), 50);
  }
  const node = params.node ?? params.prototype;
  if (node) await reveal(node).catch((e) => layr.ui.notify(e.message, "error"));
}
layr.panel.onParams?.((params) => void onParams(params));

render();
await refresh();
if (S.selected) void select(S.selected);
void detectPlugins();
await onParams(layr.info.params ?? {});
// For tests: the panel is ready once this is set.
document.body.dataset.ready = S.mode;
