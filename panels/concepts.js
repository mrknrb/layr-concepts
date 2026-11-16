// The concept map panel: views and proposals on the side, a view's nodes as an outline in the middle, and the node
// you pick on the right (its text, summary, tags, edges, places, threads, picture or prototype page). It reads and
// writes the user's tables itself, as the signed-in user, with the same shared code the backend uses (shared/graph.js,
// shared/ops.js) on the Supabase session layr gives it (layr__supabase_session); accepting a proposal runs on the
// backend (the PC). Ported from layr_code's plugins/concepts/panels (views.tsx, view.tsx, store.ts), simplified: an
// outline instead of laid-out boxes.
import { firstLine, Graph } from "../shared/graph.js";
import { prototypeDocument } from "../shared/links.js";
import { Ops } from "../shared/ops.js";
import { edgeName, nodeLabel, viewRootLabel } from "../shared/outline.js";
import { applyBundle, applyRow, TABLES, TAG_COLORS } from "../shared/rows.js";
import { createSupabase } from "../shared/supabase.js";
import { editAction, rowAction, shownText, textToSave } from "./keys.js";
import { nodeMenuItems } from "./nodemenu.js";

const PAGE = 100;
const $ = (sel, root = document) => root.querySelector(sel);

/** `h("div.a.b", {onclick}, children…)`: an element. Strings become text; null/false are skipped. */
function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += ` ${v}`;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") el.style.cssText = v;
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  plus: "M11 5h2v14h-2zM5 11h14v2H5z",
  refresh: "M17.6 6.4A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z",
  side: "M3 5h18v14H3zm2 2v10h4V7z",
  close: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z",
  search: "M10 4a6 6 0 0 1 4.8 9.6l4.6 4.6-1.4 1.4-4.6-4.6A6 6 0 1 1 10 4zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  up: "M12 7l6 6-1.4 1.4L12 9.8l-4.6 4.6L6 13z",
  down: "M12 17l-6-6 1.4-1.4 4.6 4.6 4.6-4.6L18 11z",
  picture: "M4 5h16v14H4zm2 2v8l4-4 3 3 2-2 3 3V7zm9 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
  proto: "M3 4h18v16H3zm2 4v10h14V8zm2 2h6v2H7zm0 3h10v2H7z",
  summary: "M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z",
  open: "M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14zM5 5h6v2H7v10h10v-4h2v6H5z",
};
const icon = (name, size = 16) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
};
const iconButton = (name, title, onclick, extra = "") =>
  h(`button.layr-button.ghost.icon${extra}`, { title, "aria-label": title, onclick }, icon(name));

// ---------------------------------------------------------------- state

await layr.ready;
const supabase = createSupabase({ session: () => layr.tools.run("supabase_session", {}, { plugin: "layr" }) });
const { tables, storage } = supabase;
const graph = new Graph();
const ops = new Ops(graph, tables, () => schedule());

const saved = layr.info.state ?? {};
const S = {
  mode: "loading", // loading | signedOut | error | ready
  error: "",
  viewId: saved.view ?? null,
  root: saved.root ?? null,
  selected: saved.selected ?? null,
  side: saved.side ?? true,
  summaries: saved.summaries ?? true,
  views: [],
  proposals: [],
  unplaced: { nodes: [], total: 0 },
  query: "",
  hits: null,
  types: [],
  adding: null, // {parent, index}: the row where a new node is typed
  adderText: "",
  editing: null, // the row whose text is typed in: a group conn, or "root" for the root's title
  cursor: null, // the row the keys work on while nothing is typed (a group conn)
  focus: null, // the row to type in after the next render
  pages: new Map(), // prototype node → html
  pictures: new Map(), // node → {row, url}
  threads: new Map(), // node → thread rows
  zoom: 100,
};
const narrow = () => window.innerWidth < 640;
if (narrow() && saved.side === undefined) S.side = false;

const remember = () =>
  void layr.panel
    .setState({ view: S.viewId, root: S.root, selected: S.selected, side: S.side, summaries: S.summaries })
    .catch(() => {});

// ---------------------------------------------------------------- reads

const db = {
  view: (view) => tables.rpc("view", { view_id: view, page_size: PAGE }),
  level: (parents, skip = 0, size = PAGE) => tables.rpc("level", { parents, skip, page_size: size }),
  get: (ids) => tables.rpc("get", { ids }),
  search: (q, max = 30) => tables.rpc("search", { q, max_hits: max }),
};

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
  await need(edgeEnds());
  S.types = (await tables.rpc("types", {})).types ?? [];
  if (S.selected && !graph.node(S.selected)) await need([S.selected]);
  S.mode = "ready";
}

let reloading = null;
async function refresh() {
  if (reloading) return reloading;
  reloading = (async () => {
    try {
      await reload();
    } catch (error) {
      if (/Not signed in|not signed in/.test(error.message)) S.mode = "signedOut";
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

const isOpen = (node) => !!(S.viewId && graph.look(S.viewId, node)?.open);

/** Whether the children of `node` are on screen: it is the root, or open inside a group that shows its children. */
function showing(node, seen = new Set()) {
  if (node === S.root) return true;
  if (seen.has(node) || !graph.node(node) || !isOpen(node)) return false;
  seen.add(node);
  return graph.parents(node).some((g) => showing(g.data.from, seen));
}

// ---------------------------------------------------------------- dialogs (layr.js has no pickers: these are ours)

function modal(build) {
  const back = $("#modal");
  return new Promise((resolve) => {
    const done = (value) => {
      back.hidden = true;
      back.replaceChildren();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    back.onclick = (e) => e.target === back && done(null);
    back.replaceChildren(h("div.modal.layr-card", { role: "dialog" }, build(done)));
    back.hidden = false;
    setTimeout(() => $("input, textarea, select, button.primary", back)?.focus(), 0);
  });
}

const ask = (title, value = "", placeholder = "") =>
  modal((done) => {
    const input = h("input.layr-input", { value, placeholder });
    input.onkeydown = (e) => e.key === "Enter" && done(input.value.trim() || null);
    return [
      h("h3.modal-title", title),
      input,
      h(
        "div.modal-actions",
        h("button.layr-button", { onclick: () => done(null) }, "Cancel"),
        h("button.layr-button.primary", { onclick: () => done(input.value.trim() || null) }, "OK"),
      ),
    ];
  });

const confirmIt = (title, text, action, danger = true) =>
  modal((done) => [
    h("h3.modal-title", title),
    text && h("p.layr-muted", text),
    h(
      "div.modal-actions",
      h("button.layr-button", { onclick: () => done(false) }, "Cancel"),
      h(`button.layr-button${danger ? ".danger" : ".primary"}`, { onclick: () => done(true) }, action),
    ),
  ]);

/** Pick any node: what you type searches all of them. */
const pickNode = (title, exclude = () => false) =>
  modal((done) => {
    const input = h("input.layr-input", { placeholder: "Type to search", type: "search" });
    const list = h("ul.layr-list.pick-list");
    let timer;
    input.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) return list.replaceChildren();
        const hits = (await db.search(q, 30).catch(() => [])).filter((x) => !exclude(x.id));
        list.replaceChildren(
          ...hits.map((x) =>
            h(
              "li",
              { onclick: () => done(x.id) },
              h("div.pick-label", firstLine(x.text) || "(empty)"),
              h("div.pick-path.layr-muted", x.path.map((p) => p.text || "(empty)").join(" › ")),
            ),
          ),
          hits.length ? null : h("li.layr-muted", "Nothing found"),
        );
      }, 200);
    };
    return [h("h3.modal-title", title), input, list];
  });

// ---------------------------------------------------------------- actions

async function newView() {
  const text = await ask("New view", "", "Root concept, e.g. Recipes");
  if (!text) return;
  const view = await run(async () => ops.addView(await ops.createNode(text)));
  if (view) await openView(view);
}

async function openView(id) {
  S.viewId = id;
  S.root = graph.views.get(id)?.data.root ?? null;
  S.selected = null;
  if (narrow()) S.side = false;
  remember();
  await refresh();
}

/** Show `node` as the root, inside the current view's looks (not saved to the view). */
async function focusRoot(node) {
  S.root = node;
  S.selected = null;
  if (narrow()) S.side = false;
  remember();
  await refresh();
}

/** Show a node found anywhere: inside a group it is in (a view's root first), selected. */
async function reveal(node) {
  const where = await tables.rpc("where", { node_id: node });
  // Already on screen (in the root, or in a group open below it): only picked.
  const shown = where.parents.find((p) => showing(p.id));
  if (shown) {
    await select(node);
    setTimeout(() => $(`.item-head[data-node="${node}"]`)?.scrollIntoView({ block: "center" }), 50);
    return;
  }
  const roots = new Set(sortedViews().map((v) => v.data.root));
  if (roots.has(node)) {
    const view = sortedViews().find((v) => v.data.root === node);
    await openView(view.id);
    return;
  }
  const parent = where.parents.find((p) => roots.has(p.id))?.id ?? where.parents[0]?.id;
  const view = parent && sortedViews().find((v) => v.data.root === parent);
  if (view) {
    S.viewId = view.id;
    S.root = parent;
  } else {
    S.root = parent ?? node;
  }
  S.selected = parent ? node : null;
  remember();
  await refresh();
  setTimeout(() => $(`.item-head[data-node="${node}"]`)?.scrollIntoView({ block: "center" }), 50);
}

async function toggle(node) {
  const open = !isOpen(node);
  if (S.viewId) await run(() => ops.setLook(S.viewId, node, { open }));
  if (open) await expand(node).catch((e) => layr.ui.notify(e.message, "error"));
}

async function addNode(parent, text, index) {
  const made = await run(() => ops.addNewChild(parent, text, index));
  return made?.node;
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
  S.threads.set(node, threads.sort((a, b) => b.at.localeCompare(a.at)));
  if (page[0]) S.pages.set(node, page[0].html);
  if (pic[0]) {
    const url = await storage.signedUrl(pic[0].path).catch(() => null);
    S.pictures.set(node, { row: pic[0], url });
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
    `Delete "${nodeLabel(graph, node)}"?`,
    `It goes from ${places === 1 ? "its group" : `all ${places} groups`}; the nodes inside it stay.`,
    "Delete everywhere",
  );
  if (!ok) return;
  if (S.selected === node) S.selected = null;
  await run(() => ops.deleteNode(node));
  if (S.root === node) await focusRoot(graph.views.get(S.viewId)?.data.root ?? null);
}

async function removeFromGroup(groupId) {
  const g = graph.group(groupId);
  if (!g) return;
  if (graph.parentCount(g.data.to) <= 1) {
    const ok = await confirmIt(
      `Take "${nodeLabel(graph, g.data.to)}" out of "${nodeLabel(graph, g.data.from)}"?`,
      "It is in no other group, so it will be in none (Not in any group lists it).",
      "Take it out",
    );
    if (!ok) return;
  }
  await run(() => ops.removeFromGroup(groupId));
}

async function moveBy(groupId, delta) {
  const g = graph.group(groupId);
  const siblings = graph.children(g.data.from);
  const index = siblings.findIndex((c) => c.id === groupId) + delta;
  if (index < 0 || index >= siblings.length) return;
  await run(() => ops.moveChild(groupId, delta > 0 ? index + 1 : index));
}

async function moveTo(groupId) {
  const g = graph.group(groupId);
  const target = await pickNode(`Move "${nodeLabel(graph, g.data.to)}" into…`, (id) => id === g.data.to);
  if (!target) return;
  await run(async () => {
    await need([target]);
    applyBundle(graph, await db.level([target], 0, 1000));
    await ops.moveToGroup(groupId, target);
  });
  await refresh();
}

async function alsoIn(node) {
  const target = await pickNode(`Also put "${nodeLabel(graph, node)}" into…`, (id) => id === node);
  if (!target) return;
  await run(async () => {
    await need([target]);
    applyBundle(graph, await db.level([target], 0, 1000));
    await ops.addChild(target, node);
  });
  await refresh();
}

async function addEdge(from) {
  const to = await pickNode(`Connect "${nodeLabel(graph, from)}" to…`, (id) => id === from);
  if (!to) return;
  await need([to]);
  const choice = await modal((done) => {
    const type = h(
      "select.layr-select",
      h("option", { value: "" }, "No type"),
      ...S.types.map((t) => h("option", { value: t.id }, t.text || "(empty)")),
      h("option", { value: "new" }, "New type…"),
    );
    const label = h("input.layr-input", { placeholder: "Label (optional), e.g. sometimes" });
    return [
      h("h3.modal-title", `${nodeLabel(graph, from)} → ${nodeLabel(graph, to)}`),
      h("label.layr-label", "Type"),
      type,
      h("label.layr-label", "Label"),
      label,
      h(
        "div.modal-actions",
        h("button.layr-button", { onclick: () => done(null) }, "Cancel"),
        h("button.layr-button.primary", { onclick: () => done({ type: type.value, label: label.value }) }, "Connect"),
      ),
    ];
  });
  if (!choice) return;
  let relation = choice.type || undefined;
  if (relation === "new") {
    const name = await ask("New edge type", "", "e.g. causes, needs, is a");
    if (!name) return;
    relation = await run(() => ops.addEdgeType(name));
    if (!relation) return;
  }
  await run(() => ops.addEdge(from, to, { relation, label: choice.label }));
  await refresh();
}

async function addTag(node, value) {
  if (value === "new") {
    const name = await ask("New tag", "", "e.g. Planned, mobile");
    if (!name) return;
    const tag = await run(() => ops.createTag({ name }));
    if (tag) await run(() => ops.tag(node, tag));
  } else if (value) await run(() => ops.tag(node, value));
}

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
      h("h3.modal-title", `Summary of "${nodeLabel(graph, node)}"`),
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

/** A region keeps what is typed in it: it isn't rebuilt while one of its fields has focus. */
const typing = (region) => region.contains(document.activeElement) && document.activeElement.matches("input, textarea");

/** What a region shows, without the `false` and `undefined` of parts left out (replaceChildren would print them). */
const clean = (parts) => parts.flat(Infinity).filter((p) => p !== null && p !== undefined && p !== false);
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
  renders++;
  const side = $("#side");
  if (!typing(side)) side.replaceChildren(...clean(renderSide()));
  const main = $("#main");
  // A node's text being typed in its row stays, unless typing goes on in another row (S.focus: Enter, Tab…); a new
  // node being typed in the adder is kept by S.adderText.
  const active = document.activeElement;
  const typingText = main.contains(active) && active.isContentEditable;
  if (!typingText || S.focus) {
    rebuilding = typingText;
    try {
      main.replaceChildren(...clean(renderMain()));
    } finally {
      rebuilding = false;
    }
  }
  const details = $("#details");
  details.hidden = !showDetails;
  if (!details.hidden && !typing(details)) details.replaceChildren(...clean(renderDetails(S.selected)));
  const root = S.root && graph.node(S.root);
  void layr.panel.setTitle(root ? `Concepts · ${nodeLabel(graph, S.root)}` : "Concepts").catch(() => {});
  if (S.focus) {
    const text = rowText(S.focus);
    S.focus = null;
    if (text) return caretAtEnd(text);
  }
  const focus = $("[data-autofocus]", main);
  if (focus && document.activeElement !== focus) {
    focus.focus();
    if (focus.select && focus.dataset.autofocus === "select") focus.select();
  }
}

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
      renderHits();
    }, 220);
  };
  const hits = h("div.hits", { id: "hits" });
  const renderHits = () => {
    hits.replaceChildren(
      ...(S.hits === null
        ? []
        : S.hits.length
          ? S.hits.map((x) =>
              h(
                "div.hit",
                { onclick: () => void reveal(x.id), title: x.path.map((p) => p.text).join(" › ") },
                h("div.hit-text", firstLine(x.text) || "(empty)"),
                h("div.hit-path", x.path.map((p) => p.text || "(empty)").join(" › ") || "in no group"),
              ),
            )
          : [h("div.layr-muted.pad-s", "Nothing found")]),
    );
  };
  renderHits();

  const views = sortedViews();
  return [
    h(
      "div.side-head",
      h("button.layr-button.primary", { onclick: () => void newView(), title: "A new root concept with a view" }, icon("plus", 14), " New view"),
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
    hits,
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
              { class: v.id === S.viewId ? "active" : "", onclick: () => void openView(v.id), dataset: { view: v.id } },
              h("span.view-title", v.data.name || nodeLabel(graph, v.data.root)),
              v.data.name && h("span.view-of", viewRootLabel(graph, v.data.root)),
              h("span.count", String(graph.childCount(v.data.root) || "")),
            ),
          )
        : h("p.layr-muted.pad-s", "No views yet: make one with New view."),
      S.unplaced.nodes.length > 0 && [
        h("h3.section-title", `Not in any group · ${S.unplaced.total}`),
        ...S.unplaced.nodes.map((n) =>
          h(
            "div.view-row",
            { onclick: () => void focusRoot(n.id), title: "Show it as the root" },
            h("span.view-title", n.text || "(empty)"),
          ),
        ),
      ],
    ),
  ];
}

function renderProposal(p) {
  const done = p.changes.filter((c) => c.done || c.skipped).length;
  const stopped = p.changes.findIndex((c) => c.error && !c.skipped);
  const started = done > 0 || stopped >= 0;
  const by = p.changes.find((c) => c.by)?.by;
  return h(
    "div.proposal",
    { dataset: { proposal: p.id } },
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
  const toolbar = h(
    "div.layr-toolbar.main-bar",
    iconButton("side", S.side ? "Hide the side" : "Views and proposals", () => {
      S.side = !S.side;
      if (S.side && narrow()) S.selected = null;
      remember();
      schedule();
    }, S.side ? ".active" : ""),
    h("span.bar-title", S.root && graph.node(S.root) ? nodeLabel(graph, S.root) : "Concepts"),
    h("span.layr-spacer"),
    S.mode === "ready" &&
      S.root &&
      iconButton("summary", S.summaries ? "Hide summaries" : "Show summaries", () => {
        S.summaries = !S.summaries;
        remember();
        schedule();
      }, S.summaries ? ".active" : ""),
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
  if (!S.root || !graph.node(S.root)) {
    return [
      toolbar,
      h(
        "div.layr-empty",
        h("p", "No view open."),
        h("button.layr-button.primary", { onclick: () => void newView() }, "New view"),
      ),
    ];
  }
  return [toolbar, renderHead(S.root), h("div.view-body", { id: "body" }, renderList(S.root))];
}

/** The root: the way up to its view's root, its title, tags, summary and edges. */
function renderHead(root) {
  const view = S.viewId && graph.views.get(S.viewId);
  const crumbs = [];
  if (view && view.data.root !== root) {
    crumbs.push(h("button.crumb", { onclick: () => void focusRoot(view.data.root) }, nodeLabel(graph, view.data.root)));
    const parent = graph.parents(root)[0]?.data.from;
    if (parent && parent !== view.data.root && graph.node(parent)) {
      crumbs.push(h("button.crumb", { onclick: () => void focusRoot(parent) }, nodeLabel(graph, parent)));
    }
  }
  const summary = graph.summary(root);
  return h(
    "div.view-head",
    crumbs.length > 0 && h("div.crumbs", crumbs),
    h(
      "div.root-row",
      {
        dataset: { node: root },
        onmousedown: (e) => modifierClick(e) && e.preventDefault(),
        onclick: (e) => modifierClick(e) && void select(root),
        oncontextmenu: (e) => rowMenu(e, { node: root, root: true }),
      },
      nodeText(root, "root", "root-text", rootKey),
      ...tagPills(root),
      view && view.data.name && h("span.layr-badge", view.data.name),
    ),
    S.summaries && summary && renderSummary(root, summary),
    renderEdgeChips(root),
  );
}

function renderSummary(node, summary) {
  return h(
    "div.summary",
    { class: summary.data.outdated ? "outdated" : "", onclick: () => void editSummary(node), title: "Edit the summary" },
    summary.data.text,
    summary.data.outdated ? " (outdated)" : "",
  );
}

function tagPills(node, onRemove) {
  return graph.tagsOf(node).map((t) =>
    h(
      "span.tag-pill",
      { dataset: { color: t.color ?? "gray" }, title: t.description || t.name },
      t.name,
      onRemove && h("button.pill-x", { title: `Take "${t.name}" off`, onclick: () => void onRemove(t.id) }, "×"),
    ),
  );
}

function renderEdgeChips(node, parent) {
  const edges = graph.edgesOf(node).filter((e) => !e.data.in || e.data.in === parent);
  if (!edges.length) return null;
  return h(
    "div.edge-chips",
    edges.map((e) => {
      const out = e.data.from === node;
      const other = out ? e.data.to : e.data.from;
      const name = edgeName(graph, e);
      return h(
        "button.edge-chip",
        {
          class: e.data.in ? "only" : "",
          title: `${out ? "To" : "From"} ${nodeLabel(graph, other)}${e.data.in ? " (only in this group)" : ""}`,
          onclick: (ev) => {
            ev.stopPropagation();
            if (graph.node(other)) void select(other);
          },
        },
        out ? "→ " : "← ",
        name && h("span.edge-type", `${name}: `),
        h("b", nodeLabel(graph, other)),
      );
    }),
  );
}

function renderList(parent) {
  const kids = graph.children(parent);
  const list = h("div.list");
  kids.forEach((g) => list.append(renderItem(g, parent)));
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
  else if (parent === S.root) {
    list.append(
      h("button.add-row", { onclick: () => startAdding(parent, kids.length) }, icon("plus", 14), " Add a node"),
    );
  }
  return list;
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
    dataset: { autofocus: "1" },
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
      await addNode(parent, text, index);
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
  return h("div.adder-row", input);
}

function renderItem(g, parent) {
  const node = g.data.to;
  const n = graph.node(node);
  const count = graph.childCount(node);
  const open = count > 0 && isOpen(node);
  if (open && !graph.expanded.has(node)) void expand(node);
  const places = graph.parentCount(node);
  const threads = graph.threadCount(node);
  const summary = graph.summary(node);
  const at = { node, group: g.id, open };

  const head = h(
    "div.item-head",
    {
      class: [
        S.selected === node ? "selected" : "",
        S.cursor === g.id ? "cursor" : "",
        n?.data.color ? "colored" : "",
      ].join(" "),
      dataset: { node, group: g.id, color: n?.data.color ?? "" },
      // Ctrl+click: its details (the editor) instead of typing; a click beside the text: the row the keys work on.
      onmousedown: (e) => modifierClick(e) && e.preventDefault(),
      onclick: (e) => {
        if (e.target.closest("button")) return;
        if (modifierClick(e)) return void select(node);
        if (e.target.closest(".node-text")) return;
        S.cursor = g.id;
        if (document.activeElement?.isContentEditable) document.activeElement.blur();
        schedule();
      },
      oncontextmenu: (e) => rowMenu(e, at),
    },
    h(
      "button.toggle",
      {
        class: count ? "" : "invisible",
        title: open ? "Close" : `Open (${count} inside)`,
        "aria-label": open ? "Close" : "Open",
        onclick: (e) => {
          e.stopPropagation();
          void toggle(node);
        },
      },
      open ? "▾" : "▸",
    ),
    nodeText(node, g.id, "node-text", (e, typed) => rowKey(e, typed, g, parent)),
    count > 0 && !open && h("span.inside", String(count)),
    n?.data.prototype && h("span.badge-icon", { title: "A prototype: its page shows in the details" }, icon("proto", 13)),
    n?.data.image && h("span.badge-icon", { title: n.data.caption || "Has a picture" }, icon("picture", 13)),
    places > 1 && h("span.places", { title: `In ${places} groups` }, `×${places}`),
    threads > 0 && h("span.places.threads", { title: "Threads changed, mentioned or linked it" }, `◷${threads}`),
    ...tagPills(node),
    h(
      "span.row-tools",
      h("button.icon-button", { title: "Add a node inside", onclick: (e) => (e.stopPropagation(), void addInside(node)) }, "+"),
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
  return h(
    "div.item",
    head,
    S.summaries && summary && renderSummary(node, summary),
    renderEdgeChips(node, parent),
    open && h("div.item-children", renderList(node)),
    !open && S.adding?.parent === node && h("div.item-children", renderList(node)),
  );
}

async function addInside(node) {
  if (S.viewId && !isOpen(node) && graph.childCount(node)) await toggle(node);
  else await expand(node);
  startAdding(node, graph.children(node).length);
}

// ---------------------------------------------------------------- typing in a row (as in layr_code's view.tsx)

/** Nodes this panel just made empty for typing (Enter, Ctrl+Enter): one still empty when typing leaves it goes away. */
const fresh = new Set();
/** While render() rebuilds the outline: a text losing the focus to that isn't left by the user. */
let rebuilding = false;

/** The text of the row `key` (a group conn, or "root"). */
const rowText = (key) => $(key === "root" ? "#main .root-text" : `#main .item-head[data-group="${key}"] .node-text`);
/** What is typed in a node's text: its lines, without the empty last line the browser keeps after a line break. */
const textOf = (el) => el.innerText.replace(/\n$/, "");
/** Ctrl (⌘) + click: a node's details instead of typing in it. */
const modifierClick = (e) => (e.ctrlKey || e.metaKey) && e.button === 0;

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
  const made = await run(() => ops.addNewChild(parent, "", index));
  if (!made) return;
  fresh.add(made.node);
  S.adding = null;
  focusRow(made.group);
}

/** A new empty child of `node`, last; the row `group` it shows through opens to show it (Ctrl+Enter). */
async function addChildFresh(node, group) {
  if (group && !S.viewId) return addInside(node); // no view keeps it open: the adder below it
  if (group && !isOpen(node)) await run(() => ops.setLook(S.viewId, node, { open: true }));
  await expand(node).catch((e) => layr.ui.notify(e.message, "error"));
  await addFresh(node);
}

/**
 * A node's text in its row (or the root's title), typed in place: a click puts the caret there, and what is typed is
 * saved shortly after typing stops, and when typing leaves it. All of its lines show; links show as their label until
 * it is typed in. `onKey(e, typed)` gets its keys, `typed` = {el, flush, text}.
 */
function nodeText(node, key, cls, onKey) {
  const stored = () => graph.node(node)?.data.text ?? "";
  const el = h(`div.${cls}`, { contentEditable: "plaintext-only", dataset: { node } });
  el.spellcheck = false;
  el.textContent = shownText(stored());
  let timer;
  let pending;
  const flush = () => {
    clearTimeout(timer);
    if (pending === undefined) return;
    const text = textToSave(pending, stored());
    pending = undefined;
    if (text !== null && graph.node(node)) void run(() => ops.updateNode(node, { text }));
  };
  // A right-click on a text that isn't typed in opens the node's menu without putting the caret in it first.
  el.addEventListener("mousedown", (e) => e.button === 2 && document.activeElement !== el && e.preventDefault());
  el.addEventListener("focus", () => {
    S.editing = key;
    if (key !== "root") S.cursor = key;
    if (S.adding && !S.adderText.trim()) S.adding = null;
    const raw = stored();
    if (el.textContent !== raw) {
      // Links typed as Markdown: the text as it is stored, the caret at its end (as layr_code did).
      el.textContent = raw;
      setTimeout(() => document.activeElement === el && caretAtEnd(el), 0);
    }
  });
  el.addEventListener("input", () => {
    pending = textOf(el);
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
    // Rebuilt (Enter, Tab…: typing goes on elsewhere), or another window took the focus (it comes back here).
    if (rebuilding || !el.isConnected || !document.hasFocus()) return;
    const empty = !textOf(el).trim();
    if (fresh.has(node)) {
      // A button on its own row (+, ⋯): it is still being worked on.
      if (e.relatedTarget && el.closest(".item-head, .root-row")?.contains(e.relatedTarget)) return;
      fresh.delete(node);
      const bare = !graph.childCount(node) && !graph.node(node)?.data.image && graph.parentCount(node) <= 1;
      if (empty && bare) {
        // Gone from the outline now: typing in another row keeps the outline from being drawn again.
        if (key !== "root") el.closest(".item")?.remove();
        return void run(() => ops.deleteNode(node));
      }
    }
    // Emptied: it keeps its text (Backspace in an empty node deletes it).
    el.textContent = shownText(stored());
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
    if (!text && fresh.has(node)) el.blur();
    else await addFresh(parent, index + 1);
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

/** Keys on the outline while nothing is typed: walking the rows (the cursor), and what a row's menu does. */
function onViewKey(e) {
  if (e.defaultPrevented || !$("#modal").hidden || S.mode !== "ready") return;
  const t = e.target;
  if (t.isContentEditable || t.closest?.("input, textarea, select, .side, .details")) return;
  const action = rowAction(e);
  if (!action || (t.closest?.("button") && ["edit", "toggle", "child"].includes(action))) return;
  if (action === "clear") {
    if (!S.cursor) return;
    S.cursor = null;
    schedule();
    return e.preventDefault();
  }
  const rows = [...document.querySelectorAll("#main .item-head[data-group]")];
  const keys = rows.map((r) => r.dataset.group);
  const c = keys.includes(S.cursor) ? S.cursor : null;
  const go = (key) => {
    if (!key) return;
    S.cursor = key;
    schedule();
    rows[keys.indexOf(key)]?.scrollIntoView({ block: "nearest" });
  };
  if (action === "prev" || action === "next") {
    e.preventDefault();
    if (!c) return go(keys[action === "next" ? 0 : keys.length - 1]);
    return go(keys[keys.indexOf(c) + (action === "next" ? 1 : -1)]);
  }
  const g = c && graph.group(c);
  if (!g) return;
  e.preventDefault();
  const head = rows[keys.indexOf(c)];
  const node = g.data.to;
  const count = graph.childCount(node);
  const open = count > 0 && isOpen(node);
  if (action === "right") {
    if (count && !open) void toggle(node);
    else if (open) go(head.parentElement.querySelector(".item-children .item-head[data-group]")?.dataset.group);
  } else if (action === "left") {
    if (open) void toggle(node);
    else go(head.parentElement.parentElement.closest(".item")?.querySelector(".item-head")?.dataset.group);
  } else if (action === "up" || action === "down") void moveBy(c, action === "up" ? -1 : 1);
  else if (action === "child") void addChildFresh(node, c);
  else if (action === "edit") focusRow(c);
  else if (action === "toggle") count && void toggle(node);
  else if (action === "remove") void removeFromGroup(c);
  else if (action === "menu") void nodeMenu({ node, group: c, open }, below(head.querySelector(".node-text") ?? head));
}
document.addEventListener("keydown", onViewKey);

// ---------------------------------------------------------------- a node's menu

/** Where a menu opens for an element (a ⋯ button, a row from the keys): below it, at its left edge. */
const below = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2 };
};

/** What the items of a node's menu (panels/nodemenu.js) do. */
const menuActions = {
  edit: (node) => void select(node),
  addInside: (node, group) => void (group ? addChildFresh(node, group) : addFresh(node)),
  addBelow: (group) => {
    const g = graph.group(group);
    if (g) void addFresh(g.data.from, graph.children(g.data.from).findIndex((c) => c.id === group) + 1);
  },
  toggle: (node) => void toggle(node),
  focusRoot: (node) => void focusRoot(node),
  summary: (node) => void editSummary(node),
  summarize: (node) => void editSummary(node, true),
  setTag: (node, tag, on) => void run(() => (on ? ops.tag(node, tag) : ops.untag(node, tag))),
  newTag: (node) => void addTag(node, "new"),
  setColor: (node, color) => void run(() => ops.updateNode(node, { color })),
  setUnordered: (node, unordered) => void run(() => ops.updateNode(node, { unordered })),
  connect: (node) => void addEdge(node),
  move: (group, delta) => void moveBy(group, delta),
  moveTo: (group) => void moveTo(group),
  alsoIn: (node) => void alsoIn(node),
  picture: (node) => choosePicture(node),
  removePicture: (node) => void removePicture(node),
  takeOut: (group) => void removeFromGroup(group),
  delete: (node) => void deleteNode(node),
};

/**
 * A node's menu at `where` (a mouse event, or {x, y} in the page), drawn by the shell (layr.ui.contextMenu, which runs
 * the picked item). Without the shell's menu (a plain browser) Edit's own action: the node's details.
 */
async function nodeMenu(at, where) {
  const items = nodeMenuItems(graph, at, menuActions);
  if (!items.length) return;
  if (typeof layr.ui.contextMenu === "function") {
    try {
      await layr.ui.contextMenu(items, where);
      return;
    } catch (error) {
      if (error?.code !== layr.errors.NOT_AVAILABLE) {
        return void layr.ui.notify(error.message ?? String(error), "error");
      }
    }
  }
  void select(at.node);
}

/**
 * Right-click on a row: its menu. While its text is typed in, the browser's own menu (copy, paste); a long-press on a
 * phone that already opened the menu only keeps the browser's away.
 */
function rowMenu(e, at) {
  const t = e.target;
  if (t.isContentEditable && document.activeElement === t) return;
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
    if (e.target.closest("button")) return;
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
  const tagChoice = h(
    "select.layr-select.small-select",
    { "aria-label": "Add a tag" },
    h("option", { value: "" }, "+ Tag"),
    ...graph
      .sortedTags()
      .filter((t) => !graph.nodeTag(node, t.id))
      .map((t) => h("option", { value: t.id }, graph.tagSets.get(t.tag_set)?.name ? `${t.name} (${graph.tagSets.get(t.tag_set).name})` : t.name)),
    h("option", { value: "new" }, "New tag…"),
  );
  tagChoice.onchange = () => void addTag(node, tagChoice.value);
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

  return [
    h(
      "div.d-head",
      h("span.d-kicker", n.data.prototype ? "Prototype" : "Node"),
      h("span.layr-spacer"),
      graph.childCount(node) > 0 &&
        iconButton("open", "Show it as the root", () => void focusRoot(node)),
      iconButton("close", "Close", () => void select(null)),
    ),
    title,
    h(
      "div.d-row",
      ...tagPills(node, (tag) => run(() => ops.untag(node, tag))),
      tagChoice,
    ),
    section(
      "Summary",
      summary
        ? renderSummary(node, summary)
        : h("button.layr-button.small", { onclick: () => void editSummary(node) }, "Write a summary"),
    ),
    html !== undefined && section("Page", renderPrototype(node, html)),
    n.data.image &&
      section(
        "Picture",
        pic?.url ? h("img.d-picture", { src: pic.url, alt: pic.row.caption || "Picture" }) : h("span.layr-muted", "Loading…"),
        pic?.row.caption && h("div.layr-muted", pic.row.caption),
      ),
    section(
      `Edges · ${edges.length}`,
      edges.length > 0 &&
        h(
          "ul.d-edges",
          edges.map((e) => {
            const out = e.data.from === node;
            const other = out ? e.data.to : e.data.from;
            const name = edgeName(graph, e);
            return h(
              "li",
              h("span.edge-dir", out ? "→" : "←"),
              name && h("span.edge-type", name),
              h("button.link", { onclick: () => graph.node(other) && void select(other) }, nodeLabel(graph, other)),
              e.data.in && h("span.layr-muted", `only in ${nodeLabel(graph, e.data.in)}`),
              h("button.pill-x", { title: "Delete this edge", onclick: () => void run(() => ops.deleteEdge(e.id)) }, "×"),
            );
          }),
        ),
      h("button.layr-button.small", { onclick: () => void addEdge(node) }, "Connect to…"),
    ),
    section(
      `In ${groups.length} group${groups.length === 1 ? "" : "s"}`,
      h(
        "ul.d-places",
        groups.map((g) =>
          h(
            "li",
            h("button.link", { onclick: () => void focusRoot(g.data.from) }, graph.node(g.data.from) ? nodeLabel(graph, g.data.from) : "…"),
          ),
        ),
      ),
      h(
        "div.d-actions",
        here && iconButton("up", "Move up", () => void moveBy(here.id, -1)),
        here && iconButton("down", "Move down", () => void moveBy(here.id, 1)),
        here && h("button.layr-button.small", { onclick: () => void moveTo(here.id) }, "Move to…"),
        h("button.layr-button.small", { onclick: () => void alsoIn(node) }, "Also in…"),
      ),
    ),
    threads.length > 0 &&
      section(
        `Threads · ${threads.length}`,
        h(
          "ul.d-threads",
          threads.map((t) =>
            h(
              "li",
              h("div", t.title || "Untitled thread"),
              h(
                "div.layr-muted",
                [t.linked_at && "linked", t.changed_at && "changed it", t.mentioned_at && "mentioned it"]
                  .filter(Boolean)
                  .join(", ") + (t.note ? `: ${t.note}` : ""),
              ),
            ),
          ),
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
        here && h("button.layr-button.small", { onclick: () => void removeFromGroup(here.id) }, "Take out of this group"),
        h("button.layr-button.small.danger", { onclick: () => void deleteNode(node) }, "Delete everywhere"),
      ),
    ),
  ];
}

/** A prototype's page in a locked-down frame: no origin, no network, inline scripts only (links.js). */
function renderPrototype(node, html) {
  const style = getComputedStyle(document.documentElement);
  const names = ["--bg", "--bg-2", "--bg-3", "--fg", "--fg-dim", "--border", "--accent", "--accent-fg", "--danger",
    "--radius", "--font", "--font-mono"];
  const theme = Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]).filter(([, v]) => v));
  const mode = document.documentElement.getAttribute("data-theme");
  if (mode === "dark" || mode === "light") theme["color-scheme"] = mode;
  const frame = h("iframe.proto-frame", {
    sandbox: "allow-scripts",
    title: nodeLabel(graph, node),
    srcdoc: prototypeDocument(html, theme, layrCss),
  });
  const scale = S.zoom / 100;
  frame.style.transform = `scale(${scale})`;
  frame.style.width = `${100 / scale}%`;
  const box = h("div.proto-box", frame);
  const onMessage = (event) => {
    if (event.source !== frame.contentWindow) return;
    const height = event.data?.layrPrototypeHeight;
    if (typeof height === "number") {
      frame.style.height = `${Math.min(2000, Math.max(80, Math.ceil(height)))}px`;
      box.style.height = `${Math.min(2000, Math.max(80, Math.ceil(height))) * scale}px`;
    }
  };
  window.addEventListener("message", onMessage);
  const zoom = (d) => {
    S.zoom = Math.min(200, Math.max(25, S.zoom + d));
    schedule();
  };
  return h(
    "div.proto",
    h(
      "div.proto-bar",
      h("button.layr-button.small", { onclick: () => zoom(-25), title: "Smaller" }, "−"),
      h("span.layr-muted", `${S.zoom}%`),
      h("button.layr-button.small", { onclick: () => zoom(25), title: "Larger" }, "+"),
    ),
    box,
  );
}

// layr.css for prototype pages, so a suggestion can look like the app (inline: the frame has no origin).
const layrCss = await fetch("/_layr/layr.css")
  .then((r) => (r.ok ? r.text() : ""))
  .catch(() => "");

// ---------------------------------------------------------------- start

layr.events.on("concepts:changed", () => {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(() => void refresh(), 400);
});
let changedTimer;
layr.events.on("concepts:refresh", () => void refresh());
document.addEventListener("visibilitychange", () => !document.hidden && S.mode !== "loading" && void refresh());
window.addEventListener("resize", () => schedule());

async function onParams(params = {}) {
  if (params.newView) await newView();
  if (params.search) {
    S.side = true;
    schedule();
    setTimeout(() => $("#search")?.focus(), 50);
  }
  const reveal_ = params.node ?? params.prototype;
  if (reveal_) await reveal(reveal_).catch((e) => layr.ui.notify(e.message, "error"));
}
layr.panel.onParams?.((params) => void onParams(params));

render();
await refresh();
if (S.selected) void select(S.selected);
await onParams(layr.info.params ?? {});
// For tests: the panel is ready once this is set.
document.body.dataset.ready = S.mode;
