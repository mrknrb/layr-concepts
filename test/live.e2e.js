// The backend's tools against the real Supabase, signed in as the TEST account (LAYR_TEST_EMAIL, LAYR_TEST_PASSWORD;
// never the user's), on nodes it makes under a root of its own, "layr_flutter test (delete me) …". Everything it made
// is deleted at the end: nodes (with their groups, edges, views, summaries, tags on them, thread links, pages), and the
// tags, tag sets, "Edge types" node and picture files that weren't there before.
//   node test/live.e2e.js            (skipped without the two variables)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTools, toolContent } from "../backend/server.js";
import { createSupabase } from "../shared/supabase.js";

// The project and its public key, as the core has them (core/layr_core/src/config.rs).
const config = readFileSync(new URL("../../../core/layr_core/src/config.rs", import.meta.url), "utf8");
const SUPABASE = /SUPABASE_URL: &'static str = "([^"]+)"/.exec(config)[1];
const KEY = /SUPABASE_KEY: &'static str = "([^"]+)"/.exec(config)[1];
const { LAYR_TEST_EMAIL: email, LAYR_TEST_PASSWORD: password } = process.env;
if (!email || !password) {
  console.log("skipped: set LAYR_TEST_EMAIL and LAYR_TEST_PASSWORD (the test account)");
  process.exit(0);
}

async function signIn() {
  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`sign-in failed (${res.status}): ${body.error_description ?? body.msg}`);
  return { url: SUPABASE, key: KEY, accessToken: body.access_token, expiresAt: body.expires_at, userId: body.user.id };
}

const session = await signIn();
assert.equal(session.userId && typeof session.userId, "string");
const supabase = createSupabase({ session: async () => session, headers: { "x-layr-actor": "ai" } });
const store = new Map();
const events = [];
const hub = {
  async call(name, args) {
    if (name === "layr__data_get") return store.get(args.key) ?? null;
    if (name === "claude__thread_status") throw new Error("not allowed to call claude's tools");
    throw new Error(`fake hub: no ${name}`);
  },
  emit: (topic, data) => events.push({ topic, data }),
};
const { call } = buildTools({ hub, supabase, onWrite: (tool) => events.push({ tool }) });
const { tables, storage } = supabase;
const text = (result) => (typeof result === "string" ? result : JSON.stringify(result));
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try {
    await fn();
    steps.push(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    steps.push(`FAIL ${name}: ${error.message}`);
    throw error;
  }
};

// What was there before, so only what the test made goes at the end.
const before = {
  tags: new Set((await tables.select("tags")).map((t) => t.id)),
  sets: new Set((await tables.select("tag_sets")).map((t) => t.id)),
  settings: (await tables.select("settings"))[0] ?? null,
  types: new Set(((await tables.rpc("types", {})).types ?? []).map((t) => t.id)),
  files: new Set((await storage.list("images").catch(() => [])).map((f) => f.path)),
};
const made = new Set();
const pictures = [];
const ROOT = `layr_flutter test (delete me) ${new Date().toISOString().slice(0, 19)}`;
let root;
const idOf = async (title) => {
  const hits = await call("search", { query: title, under: root });
  const hit = hits.find((h) => h.text === title);
  assert.ok(hit, `no node "${title}" in ${text(hits)}`);
  return hit.id;
};

try {
  await step("guide", async () => {
    const guide = await call("guide");
    assert.match(guide, /concepts__read/);
    assert.match(guide, /proposals/);
  });

  await step("create_view makes the test root", async () => {
    const r = await call("create_view", { text: ROOT });
    assert.equal(r.text, ROOT);
    root = (await tables.rpc("find", { prefix: r.id }))[0];
    made.add(root);
    const views = await call("views");
    assert.ok(views.views.some((v) => v.text === ROOT), text(views));
  });

  await step("add a tree, read it", async () => {
    const r = await call("add", {
      parent: root,
      texts: ["Alpha", { text: "Beta", children: ["Beta one", "Beta two"] }, "Gamma"],
    });
    assert.deepEqual(
      r.added.map((a) => a.text),
      ["Alpha", "Beta", "Gamma"],
    );
    for (const a of r.added) made.add((await tables.rpc("find", { prefix: a.id }))[0]);
    for (const c of r.added[1].children) made.add((await tables.rpc("find", { prefix: c.id }))[0]);
    const outline = await call("read", { node: root, budget: 2000 });
    for (const t of ["Alpha", "Beta", "Beta one", "Gamma"]) assert.match(outline, new RegExp(t));
    const kids = await call("children", { node: root });
    assert.match(kids, /Alpha/);
  });

  await step("search, by title and under", async () => {
    const hits = await call("search", { query: "Beta one", under: root });
    assert.equal(hits[0].text, "Beta one");
    assert.match(hits[0].path, /Beta/);
  });

  await step("update text and order flag, summary", async () => {
    const gamma = await idOf("Gamma");
    const r = await call("update", { node: gamma, text: "Gamma renamed", unordered: true });
    assert.equal(r.text, "Gamma renamed");
    const beta = await idOf("Beta");
    await call("summary", { node: beta, text: "Two sub-points about Beta." });
    assert.match(await call("read", { node: beta }), /Two sub-points about Beta/);
  });

  await step("tags: define, put on, list, search by tag, take off", async () => {
    const r = await call("define_tag", { tag: "lf-test tag", set: "lf-test set", description: "test only", color: "teal" });
    assert.match(r, /Made tag "lf-test tag" in "lf-test set"/);
    const alpha = await idOf("Alpha");
    const tagged = await call("tag", { node: alpha, add: ["lf-test tag"] });
    assert.match(tagged[0], /lf-test tag/);
    const tags = await call("tags");
    const set = tags.sets.find((s) => s.set === "lf-test set");
    assert.equal(set.tags[0].nodes, 1);
    const hits = await call("search", { tags: ["lf-test tag"], under: root });
    assert.deepEqual(
      hits.map((h) => h.text),
      ["Alpha"],
    );
    await call("tag", { node: alpha, remove: ["lf-test tag"] });
    assert.equal((await call("search", { tags: ["lf-test tag"], under: root })).length, 0);
  });

  await step("connect with a new type, neighbors, edges, check, follow", async () => {
    const [alpha, gamma] = [await idOf("Alpha"), await idOf("Gamma renamed")];
    const r = await call("connect", { from: alpha, to: gamma, type: "lf-test causes", newType: true, label: "often" });
    assert.match(text(r), /lf-test causes/);
    const types = await call("types");
    const type = types.find((t) => t.type === "lf-test causes");
    assert.ok(type, text(types));
    made.add((await tables.rpc("find", { prefix: type.id }))[0]);
    const n = await call("neighbors", { node: alpha });
    assert.equal(n.total, 1);
    assert.match(n.edges[0], /--lf-test causes · often--> Gamma renamed/);
    assert.match(text(await call("edges", { group: root })), /lf-test causes/);
    assert.ok(await call("check", { group: root, acyclic: ["lf-test causes"] }));
    assert.match(text(await call("follow", { node: alpha, type: "lf-test causes" })), /Gamma renamed/);
    const preview = await call("connect", { from: alpha, to: gamma, type: "lf-test causes", remove: true, preview: true });
    assert.match(text(preview), /remove|delete/i);
  });

  await step("move inside a group right away; to another group as a proposal, accepted", async () => {
    const gamma = await idOf("Gamma renamed");
    const moved = await call("move", { parent: root, child: gamma, first: true });
    assert.match(moved.split("\n")[1], /Gamma renamed/);
    const [alpha, beta] = [await idOf("Alpha"), await idOf("Beta")];
    const proposed = await call("move", { parent: root, child: alpha, to: beta });
    assert.match(proposed, /^Proposed, not done yet: "Move "Alpha" from/);
    const views = await call("views");
    const p = views.proposals.find((x) => x.title.includes('"Alpha"'));
    assert.ok(p, text(views.proposals));
    const decided = await call("decide", { proposal: p.id, accept: true });
    assert.match(decided.accepted, /Alpha/);
    assert.match(await call("read", { node: beta }), /Alpha/);
  });

  await step("remove as a proposal, declined", async () => {
    const [two, beta] = [await idOf("Beta two"), await idOf("Beta")];
    const proposed = await call("remove", { node: two, parent: beta });
    assert.match(proposed, /Proposed, not done yet/);
    const p = (await call("views")).proposals.find((x) => x.title.includes("Beta two"));
    assert.deepEqual(await call("decide", { proposal: p.id, accept: false }), { declined: p.title });
    assert.match(await call("read", { node: beta }), /Beta two/);
  });

  await step("proposals off in settings: a removal is made right away", async () => {
    store.set("settings", { proposals: false });
    const [two, beta] = [await idOf("Beta two"), await idOf("Beta")];
    const r = await call("remove", { node: two, parent: beta });
    assert.deepEqual(r, { ok: true });
    assert.doesNotMatch(await call("read", { node: beta }), /Beta two/);
    store.delete("settings");
  });

  await step("prototype: new, page, developed with edits", async () => {
    const r = await call("prototype", { title: "lf-test proto", html: "<button>Hi</button>", parent: root });
    assert.match(r.link, /^\[lf-test proto\]\(layr:\/\/concepts\/prototype\/[0-9a-f-]{36}\)$/);
    made.add((await tables.rpc("find", { prefix: r.id }))[0]);
    assert.deepEqual(await call("prototype_page", { node: r.id }), { html: "<button>Hi</button>" });
    const next = await call("prototype", { title: "lf-test proto 2", from: r.id, edits: [{ find: "Hi", replace: "Hello" }] });
    made.add((await tables.rpc("find", { prefix: next.id }))[0]);
    assert.deepEqual(await call("prototype_page", { node: next.id }), { html: "<button>Hello</button>" });
    assert.match((await call("neighbors", { node: next.id })).edges[0], /developed from/);
  });

  await step("picture: set from a file, look at it, caption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lf-concepts-"));
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const file = join(dir, "dot.png");
    writeFileSync(file, png);
    const alpha = await idOf("Alpha");
    await call("set_image", { node: alpha, path: file });
    const [row] = await tables.select("images", { node: (await tables.rpc("find", { prefix: alpha }))[0] });
    pictures.push(row.path);
    const seen = await call("image", { node: alpha });
    assert.equal(seen.image.mimeType, "image/png");
    assert.equal(toolContent(seen)[0].type, "image");
    await call("set_image", { node: alpha, caption: "a single dot" });
    const hits = await call("search", { query: "single dot", under: root });
    assert.equal(hits[0].picture, "a single dot");
    const files = await storage.list("images");
    assert.ok(files.some((f) => f.path === row.path));
  });

  await step("history, mention, threads", async () => {
    const alpha = await idOf("Alpha");
    const history = await call("history", { node: alpha });
    assert.ok(history.some((h) => /created/.test(h)), text(history));
    const recent = await call("history", { since: "1h", limit: 5 });
    assert.ok(recent.length > 0);
    const linked = await call("mention", { node: alpha, note: "a test link", thread: "layr://pipeline/task/lf-test" });
    assert.match(linked, /Linked your thread to "Alpha"/);
    const threads = await call("threads", { node: alpha });
    assert.match(text(threads), /a test link/);
    const nodes = await call("threads", { thread: "layr://pipeline/task/lf-test" });
    assert.match(text(nodes), /Alpha/);
  });

  await step("project map: set up, read, file an idea", async () => {
    const r = await call("add", { parent: root, texts: ["lf-test project"] });
    const project = (await tables.rpc("find", { prefix: r.added[0].id }))[0];
    made.add(project);
    await call("setup_project_map", { node: project });
    const map = await call("project", { node: project });
    assert.ok(map.sections.features, text(map));
    for (const id of Object.values(map.sections)) made.add(id);
    const filed = await call("file", {
      features: project,
      kind: "idea",
      title: "lf-test idea about pancakes",
      description: "Only a test.",
      confirm: true,
    });
    assert.equal(filed.filed, true, text(filed));
    assert.deepEqual(filed.tags, ["Idea", "Feature", "Agent"]);
    const ideas = await call("filed_ideas", { node: project });
    assert.match(text(ideas), /pancakes/);
  });

  await step("commands as tools: nodes, tagged, linked_nodes", async () => {
    const picks = await call("nodes", { query: "Beta one" });
    assert.ok(picks.some((p) => p.label === "Beta one"));
    const linked = await call("linked_nodes", { prefix: "layr://pipeline/task/lf-test" });
    assert.ok(Object.values(linked).flat().some((n) => n.text === "Alpha"));
  });

  await step("the panels hear about writes", async () => {
    assert.ok(events.some((e) => e.tool === "add"));
    assert.ok(!events.some((e) => e.tool === "read"));
  });
} finally {
  // Everything below the root (any depth) plus what was tracked, then the tags and sets the test made.
  const below = new Set(made);
  if (root) below.add(root);
  // Down from every node the test knows (sections of the project map have children of their own).
  let frontier = [...below];
  while (frontier.length) {
    const groups = await tables.select("groups", { parent: frontier });
    frontier = groups.map((g) => g.child).filter((c) => !below.has(c));
    for (const c of frontier) below.add(c);
  }
  // Edge types the tools made on the way ("developed from", the project map's "needs" and "see also").
  for (const t of (await tables.rpc("types", {})).types ?? []) if (!before.types.has(t.id)) below.add(t.id);
  const settings = (await tables.select("settings"))[0];
  if (!before.settings && settings?.edge_types) below.add(settings.edge_types);
  if (below.size) await tables.delete("nodes", { id: [...below] });
  if (!before.settings && settings) await tables.delete("settings", { id: settings.id });
  const tags = (await tables.select("tags")).filter((t) => !before.tags.has(t.id));
  if (tags.length) await tables.delete("tags", { id: tags.map((t) => t.id) });
  const sets = (await tables.select("tag_sets")).filter((t) => !before.sets.has(t.id));
  if (sets.length) await tables.delete("tag_sets", { id: sets.map((t) => t.id) });
  const files = (await storage.list("images").catch(() => [])).map((f) => f.path).filter((f) => !before.files.has(f));
  if (files.length || pictures.length) await storage.remove([...new Set([...files, ...pictures])]);
  const stale = (await tables.select("proposals")).filter((p) => p.title.includes("layr_flutter test (delete me)"));
  if (stale.length) await tables.delete("proposals", { id: stale.map((p) => p.id) });
  const left = root ? await tables.select("nodes", { id: [...below] }) : [];
  steps.push(`cleanup: deleted ${below.size} nodes, ${tags.length} tags, ${sets.length} sets; ${left.length} left`);
  console.log(steps.join("\n"));
}
