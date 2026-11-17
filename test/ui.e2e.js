// The Concepts panel's 0.2.0 parts in headless Chromium, without a core or an account: a small server gives the
// plugin's files and a stand-in layr.js with the tables in memory (test/harness/fake-layr.js), filled with a sample
// map. It clicks, drags and types through layouts, selection, dragging, Markdown, prototypes, tags, edges and the
// link actions, checks what was written, and takes screenshots into screenshots/.
//   node test/ui.e2e.js
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const SHOTS = join(PLUGIN, "screenshots");
const CSS = join(PLUGIN, "..", "..", "core", "layr_core", "assets", "layr.css");
const require = createRequire(join(process.env.PWTOOLS ?? "C:/Users/mrknr/pwtools", "package.json"));
const { chromium } = require("playwright");
mkdirSync(SHOTS, { recursive: true });

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file =
    path === "/_layr/layr.js"
      ? join(HERE, "harness", "fake-layr.js")
      : path === "/_layr/layr.css"
      ? CSS
      : join(PLUGIN, normalize(path));
  try {
    const body = readFileSync(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- a sample map

const at = "2026-11-01T00:00:00Z";
const N = (id, text, extra = {}) => ({ id, text, unordered: false, created_at: at, ...extra });
const G = (id, parent, child, pos) => ({ id, parent, child, pos, created_at: at });
const PAGE = (title, color) =>
  `<div class="layr-card" style="padding:14px;border-left:4px solid ${color}"><b>${title}</b>` +
  '<p class="layr-muted">Email and password, then Sign in.</p><input class="layr-input" placeholder="Email">' +
  '<p></p><button class="layr-button primary">Sign in</button></div>';
const seed = {
  nodes: [
    N("root", "Recipes"),
    N("bread", "Bread"),
    N("flour", "Flour"),
    N("water", "Water"),
    N("yeast", "Yeast"),
    N(
      "pancakes",
      "**Pancakes** for Sunday: see [Fix the griddle](layr://pipeline/task/12) and https://example.com/pancakes",
    ),
    N("soup", "Soup"),
    N("salad", "Salad"),
    N("login", "Login card"),
    N("login2", "Login card, rounder"),
    N("dish", "Dish"),
    N("types", "Edge types"),
    N("isa", "is a"),
    N("goes", "goes with"),
    N("dev", "developed from"),
  ],
  groups: [
    G("g-bread", "root", "bread", "a0"),
    G("g-pancakes", "root", "pancakes", "a1"),
    G("g-soup", "root", "soup", "a2"),
    G("g-salad", "root", "salad", "a3"),
    G("g-login", "root", "login", "a4"),
    G("g-login2", "root", "login2", "a5"),
    G("g-flour", "bread", "flour", "a0"),
    G("g-water", "bread", "water", "a1"),
    G("g-yeast", "bread", "yeast", "a2"),
    G("g-isa", "types", "isa", "a0"),
    G("g-goes", "types", "goes", "a1"),
    G("g-dev", "types", "dev", "a2"),
  ],
  edges: [
    { id: "e-isa", from_node: "pancakes", to_node: "dish", type: "isa", label: null, in_group: null, created_at: at },
    { id: "e-goes", from_node: "bread", to_node: "soup", type: "goes", label: "often", in_group: null, created_at: at },
    { id: "e-salad", from_node: "salad", to_node: "soup", type: null, label: null, in_group: null, created_at: at },
    { id: "e-dev", from_node: "login2", to_node: "login", type: "dev", label: null, in_group: null, created_at: at },
  ],
  views: [{ id: "v1", root: "root", name: null, created_at: at }],
  images: [
    { id: "i1", node: "water", path: "images/w.png", caption: "A glass of water", width: 40, height: 20, created_at: at },
  ],
  details: [
    {
      id: "d1",
      node: "bread",
      kind: "summary",
      text: "Flour, water and yeast; the loaves we bake.",
      outdated: false,
      created_at: at,
    },
  ],
  pages: [
    { id: "p1", node: "login", html: PAGE("Sign in", "#3e8ef7"), created_at: at },
    {
      id: "p2",
      node: "login2",
      html: PAGE("Sign in, rounder", "#30a46c").replace("layr-card", 'layr-card" style="border-radius:18px'),
      created_at: at,
    },
  ],
  looks: [
    {
      id: "l1",
      view: "v1",
      node: "bread",
      open: true,
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
      created_at: at,
    },
  ],
  settings: [{ id: "s1", edge_types: "types" }],
  tag_sets: [{ id: "set-pri", name: "Priority", description: "", single: true, pos: 1, created_at: at }],
  tags: [
    {
      id: "t-high",
      tag_set: "set-pri",
      name: "High",
      description: "Do it first",
      color: "red",
      pos: 1,
      created_at: at,
    },
    { id: "t-low", tag_set: "set-pri", name: "Low", description: "", color: "gray", pos: 2, created_at: at },
    {
      id: "t-quick",
      tag_set: null,
      name: "quick",
      description: "Under 30 minutes",
      color: "teal",
      pos: 1,
      created_at: at,
    },
  ],
  node_tags: [
    { id: "nt1", node: "pancakes", tag: "t-quick", created_at: at },
    { id: "nt2", node: "bread", tag: "t-high", created_at: at },
  ],
  otherTools: {
    pipeline__propose: {
      proposed: true,
      number: 42,
      title: "Pancakes for Sunday",
      link: "[#42](layr://pipeline/task/42)",
    },
    pipeline__projects: { projects: [{ projectId: "pr1", title: "layr", enabled: true }] },
    pipeline__tasks: { tasks: [{ number: 12, title: "Fix the griddle", column: "ready" }], more: 0 },
    claude__thread_start: { thread: { id: "t_abc", title: "Soup" } },
    claude__projects_list: { projects: [{ id: "c1", name: "layr" }] },
  },
};

// ---------- the run

const steps = [];
const errors = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    steps.push(`ok   ${name} (${Date.now() - t0} ms)`);
    console.log(steps.at(-1));
  } catch (error) {
    console.log(`FAIL ${name}: ${error.stack ?? error.message}`);
    if (errors.length) console.log("page errors:", errors.join(" | "));
    throw error;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
/** A page with the panel, `state` as its saved state. */
async function open(path, { width = 1180, height = 720, theme = "dark", state = null, params = {} } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript((s) => {
    window.__seed = s;
    window.conceptsOwnMenus = true;
  }, seed);
  const q = new URLSearchParams({ theme, state: JSON.stringify(state), params: JSON.stringify(params) });
  await page.goto(`${base}${path}?${q}`);
  return page;
}
const tables = (page) => page.evaluate(() => window.__tables);
const until = async (test, what) => {
  for (let i = 0; i < 60; i++) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`timed out: ${what}`);
};
/** Click a menu item of the panel's own menu, along a path of labels. */
async function menuPath(page, labels) {
  for (const label of labels) {
    const item = page.locator(".menu-box .menu-item", { has: page.locator(`.menu-label:text-is("${label}")`) }).last();
    await item.hover();
    await item.click();
  }
}

let page;
try {
  await step("the outline: Markdown with chips, tags, a type badge, edges, a summary, prototypes folded", async () => {
    page = await open("/panels/concepts.html", { state: { view: "v1", side: false } });
    await page.waitForSelector("body[data-ready='ready']");
    await page.waitForSelector(".item-head:has-text('Flour')");
    assert.ok(await page.isVisible(".item-head[data-node='pancakes'] .node-text strong:has-text('Pancakes')"));
    assert.ok(await page.isVisible(".item-head[data-node='pancakes'] .link-chip:has-text('Fix the griddle')"));
    assert.ok(await page.isVisible(".item-head[data-node='pancakes'] .type-badge:has-text('Dish')"));
    assert.ok(await page.isVisible(".edge-chip[data-edge='e-goes']:has-text('often')"));
    assert.ok(await page.isVisible(".item:has(> .item-head[data-node='login']) .proto-head"));
    await page.screenshot({ path: join(SHOTS, "outline-0.2-dark.png") });
  });

  await step("a layr link chip opens through layr; a concepts node link reveals it here", async () => {
    await page.click(".item-head[data-node='pancakes'] .link-chip");
    const calls = await page.evaluate(() => window.__layr.calls);
    assert.ok(calls.some((c) => c.method === "links.open" && c.params.url === "layr://pipeline/task/12"));
    assert.equal(await page.evaluate(() => document.activeElement?.isContentEditable ?? false), false);
  });

  await step("a prototype folds out under its node, zooms in steps and keeps it in the view", async () => {
    await page.click(".item:has(> .item-head[data-node='login']) .proto-fold");
    const frame = page.frameLocator(".item:has(> .item-head[data-node='login']) iframe.proto-frame");
    await frame.locator("text=Email and password").waitFor();
    await page.click(".item:has(> .item-head[data-node='login']) .proto-head button[title='Zoom the page in']");
    await until(async () => {
      const l = (await tables(page)).looks.find((x) => x.node === "login");
      return l?.proto_open === true && l?.proto_zoom === 110;
    }, "open and zoom saved in the view");
    // Drawn again (another change), the page stays: its frame isn't loaded anew.
    await page.evaluate(() => (document.querySelector(".proto-frame").dataset.mark = "kept"));
    await page.click(".item-head[data-node='soup'] .toggle", { force: true }).catch(() => {});
    await page.keyboard.press("Escape");
    await sleep(300);
    assert.equal(
      await page.getAttribute(".item:has(> .item-head[data-node='login']) .proto-frame", "data-mark"),
      "kept",
    );
    await sleep(200);
    await page.screenshot({ path: join(SHOTS, "prototype-fold-dark.png") });
  });

  await step("Ctrl+click and Shift+click select rows; the selection bar acts on all of them", async () => {
    await page.click(".item-head[data-node='soup'] .node-text", { modifiers: ["Control"] });
    await page.click(".item-head[data-node='login'] .node-text", { modifiers: ["Shift"] });
    await page.waitForSelector(".selection-bar:has-text('3 selected')");
    assert.equal(await page.locator(".item-head.selected").count(), 3);
    assert.equal(await page.evaluate(() => document.activeElement?.isContentEditable ?? false), false);
    await page.screenshot({ path: join(SHOTS, "selection-dark.png") });
    await page.click(".selection-bar button:has-text('Tags…')");
    await page.screenshot({ path: join(SHOTS, "selection-tags-menu-dark.png") });
    await menuPath(page, ["quick"]);
    await until(
      async () => (await tables(page)).node_tags.filter((t) => t.tag === "t-quick").length === 4,
      "tagged all",
    );
  });

  await step("the menu on a selected row is the menu for all of them", async () => {
    await page.click(".item-head[data-node='salad'] .node-text", { button: "right" });
    await page.waitForSelector(".menu-box .menu-item:has-text('3 selected')");
    await page.locator(".menu-box .menu-item:has-text('Select')").first().hover();
    await sleep(100);
    await page.screenshot({ path: join(SHOTS, "selection-menu-dark.png") });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForSelector(".selection-bar", { state: "detached" });
  });

  await step("Shift+↓ grows the selection from the row the keys are on", async () => {
    await page.click(".item-head[data-node='soup']", { position: { x: 4, y: 8 } });
    await page.waitForSelector(".item-head.cursor[data-node='soup']");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForSelector(".selection-bar:has-text('3 selected')");
    await page.keyboard.press("Escape");
  });

  await step("dragging ⠿ onto a node moves the row into it; Ctrl+drag puts it there too", async () => {
    const drag = async (from, to, ctrl = false) => {
      const grip = page.locator(`.item-head[data-node='${from}'] .grip`);
      await page.hover(`.item-head[data-node='${from}']`);
      const a = await grip.boundingBox();
      const b = await page.locator(`.item-head[data-node='${to}'] .node-text`).boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      if (ctrl) await page.keyboard.down("Control");
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(a.x + ((b.x + 30 - a.x) * i) / 8, a.y + ((b.y + b.height / 2 - a.y) * i) / 8);
        await sleep(30);
      }
      await sleep(80);
      if (from === "salad") await page.screenshot({ path: join(SHOTS, "drag-dark.png") });
      await page.mouse.up();
      if (ctrl) await page.keyboard.up("Control");
    };
    await drag("salad", "soup");
    await until(
      async () => (await tables(page)).groups.some((g) => g.parent === "soup" && g.child === "salad"),
      "moved",
    );
    await until(
      async () => !(await tables(page)).groups.some((g) => g.parent === "root" && g.child === "salad"),
      "gone",
    );
    await drag("yeast", "pancakes", true);
    await until(
      async () => (await tables(page)).groups.some((g) => g.parent === "pancakes" && g.child === "yeast"),
      "also in",
    );
    assert.ok(
      (await tables(page)).groups.some((g) => g.parent === "bread" && g.child === "yeast"),
      "and still there",
    );
  });

  await step("an edge's label is typed in place; its menu changes where it holds", async () => {
    await page.click(".edge-chip[data-edge='e-goes'] .chip-label");
    await page.fill(".chip-input", "always");
    await page.press(".chip-input", "Enter");
    await until(
      async () => (await tables(page)).edges.find((e) => e.id === "e-goes").label === "always",
      "label saved",
    );
    await page.click(".edge-chip[data-edge='e-goes'] b");
    await page.waitForSelector(".menu-box .menu-item:has-text('Change its type…')");
    await page.screenshot({ path: join(SHOTS, "edge-menu-dark.png") });
    await page.keyboard.press("Escape");
  });

  await step("connecting several nodes at once: the type asked once, the one used last first", async () => {
    await page.click(".item-head[data-node='bread'] .node-text", { modifiers: ["Control"] });
    await page.click(".item-head[data-node='pancakes'] .node-text", { modifiers: ["Control"] });
    await page.click(".selection-bar button:has-text('Connect…')");
    await page.waitForSelector(".connect-bar");
    await page.click(".item-head[data-node='login2'] .node-text");
    await page.click(".modal li:has-text('goes with')");
    await until(
      async () => (await tables(page)).edges.filter((e) => e.to_node === "login2" && e.type === "goes").length === 2,
      "two edges",
    );
    assert.equal((await page.evaluate(() => window.__layr.state)).lastType, "goes");
  });

  await step("a tag pill's menu switches it within its set and filters by it", async () => {
    await page.click(".item-head[data-node='bread'] .tag-pill:has-text('High')");
    await page.screenshot({ path: join(SHOTS, "tag-pill-menu-dark.png") });
    await menuPath(page, ["Change to Low"]);
    await until(
      async () => (await tables(page)).node_tags.some((t) => t.node === "bread" && t.tag === "t-low"),
      "switched",
    );
    assert.ok(!(await tables(page)).node_tags.some((t) => t.node === "bread" && t.tag === "t-high"));
    await page.click(".item-head[data-node='bread'] .tag-pill:has-text('Low')");
    await menuPath(page, ["Show only nodes tagged Low"]);
    await page.waitForSelector(".item-head.dimmed[data-node='soup']");
    assert.deepEqual((await page.evaluate(() => window.__layr.state)).tags, ["t-low"]);
    await page.screenshot({ path: join(SHOTS, "tag-filter-dark.png") });
    await page.click(".tags-button");
    await menuPath(page, ["Show all nodes again"]);
    await page.waitForSelector(".item-head.dimmed", { state: "detached" });
  });

  await step("managing tags: rename, a new set, the Status set", async () => {
    await page.click(".tags-button");
    await menuPath(page, ["Manage tags…"]);
    await page.waitForSelector(".tags-manager");
    const name = page.locator(".tm-tag[data-tag='t-quick'] .tm-name");
    await name.fill("fast");
    await name.press("Enter");
    await until(async () => (await tables(page)).tags.find((t) => t.id === "t-quick").name === "fast", "renamed");
    await page.click(".modal button:has-text('Add a Status set')");
    await until(
      async () =>
        (await tables(page)).tags.filter((t) => ["Idea", "Planned", "In progress", "Done", "Dropped"].includes(t.name))
          .length === 5,
      "the Status set",
    );
    assert.ok((await tables(page)).tag_sets.find((s) => s.name === "Status").single);
    await sleep(100);
    await page.screenshot({ path: join(SHOTS, "tags-manager-dark.png") });
    await page.click(".modal button:has-text('Done')");
  });

  await step("the node menu's links: send to the pipeline as a task, linked both ways", async () => {
    await page.click(".item-head[data-node='soup'] .node-text", { button: "right" });
    await page.locator(".menu-box .menu-item:has-text('Links')").hover();
    await sleep(100);
    await page.screenshot({ path: join(SHOTS, "node-menu-links-dark.png") });
    await menuPath(page, ["Send to the pipeline as a task…"]);
    await until(
      async () => (await tables(page)).threads.some((t) => t.node === "soup" && t.href === "layr://pipeline/task/42"),
      "the task linked to the node",
    );
    const propose = (await page.evaluate(() => window.__layr.calls)).find((c) => c.tool === "propose");
    assert.equal(propose.plugin, "pipeline");
    assert.deepEqual(propose.args.from, ["layr://concepts/node/soup"]);
    assert.match(propose.args.description, /Soup/);
  });

  await step("ask in a Claude thread: started with the node as context, and linked", async () => {
    await page.click(".selection-bar button[title^='Clear']").catch(() => {});
    await page.click(".item-head[data-node='bread'] .node-text", { button: "right" });
    await menuPath(page, ["Links", "Ask in a Claude thread…"]);
    await page.waitForSelector(".modal:has-text('Ask Claude about')");
    await page.screenshot({ path: join(SHOTS, "ask-claude-dark.png") });
    await page.click(".modal button:has-text('Start the thread')");
    await until(
      async () => (await tables(page)).threads.some((t) => t.href === "layr://claude/thread/t_abc"),
      "linked",
    );
    const start = (await page.evaluate(() => window.__layr.calls)).find((c) => c.tool === "thread_start");
    assert.match(start.args.prompt, /layr:\/\/concepts\/node\/bread/);
    await until(
      async () =>
        (
          await page.evaluate(() => window.__layr.opened)
        ).some((o) => o.panel === "thread" && o.params.thread === "t_abc"),
      "the thread opened",
    );
  });

  await step("found by search, made the view's root: the groups above it on top, Back to where it was", async () => {
    const rootText = () => page.textContent(".root-text");
    await page.click(".main-bar button[title='Views and proposals']");
    // Where the view is scrolled is kept with its root.
    const scrolled = await page.evaluate(async () => {
      const body = document.querySelector("#main .view-body");
      body.scrollTop = 0;
      body.scrollTop = Math.min(120, body.scrollHeight - body.clientHeight);
      await new Promise((done) => setTimeout(done, 50));
      return body.scrollTop;
    });
    assert.ok(scrolled > 20, `the view scrolls (${scrolled})`);
    await sleep(500);
    await page.fill("#search", "Flour");
    await page.waitForSelector(".hit .hit-root");
    await page.click(".hit .hit-root");
    await until(async () => (await rootText()) === "Flour", "Flour is the root");
    const viewRoot = async () => (await tables(page)).views.find((v) => v.id === "v1").root;
    await until(async () => (await viewRoot()) === "flour", "saved as the view's root");
    await page.waitForSelector(".crumbs .crumb");
    assert.deepEqual(await page.locator(".crumbs .crumb").allTextContents(), ["Recipes", "Bread"], "the way down");
    await page.fill("#search", "");
    await page.click(".crumbs button.back");
    await until(async () => (await rootText()) === "Recipes", "back at Recipes");
    await until(async () => (await viewRoot()) === "root", "the view's root set back");
    await until(
      async () => Math.abs((await page.evaluate(() => document.querySelector("#main .view-body").scrollTop)) - scrolled) < 2,
      "scrolled where it was",
    );
    assert.equal(await page.locator(".crumbs button.back").count(), 0, "nothing more to go back to");

    // ×2: the groups Yeast is in; one chosen shows it as the root, Alt+← goes back.
    await page.locator(".item-head[data-node='yeast'] button.places").first().click();
    await page.waitForSelector(".modal li:has-text('Pancakes')");
    await page.click(".modal li:has-text('Pancakes')");
    await until(async () => (await rootText()).startsWith("Pancakes"), "Pancakes is the root");
    await page.locator("body").press("Alt+ArrowLeft");
    await until(async () => (await rootText()) === "Recipes", "back again");
  });

  await step("a picture shows under its node, big on a click; History… lists a node's changes", async () => {
    const img = page.locator(".item[data-key='g-water'] > .node-picture img");
    await img.waitFor();
    assert.equal(await img.evaluate((el) => el.style.width), "32px", "icon sized");
    await img.click();
    await page.waitForSelector(".picture-big:has-text('A glass of water')");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".picture-big").count(), 0, "closed");
    await page.click(".item-head[data-node='bread'] .node-text", { button: "right" });
    await menuPath(page, ["History…"]);
    await page.waitForSelector(".modal li:has-text('changed the text')");
    await page.keyboard.press("Escape");
  });

  await step("a view is deleted from the views list (asked); its nodes stay", async () => {
    await page.click(".item-head[data-node='soup'] .node-text", { button: "right" });
    await menuPath(page, ["New view of this node"]);
    await until(async () => (await tables(page)).views.length === 2, "a second view");
    await until(async () => (await page.textContent(".root-text")) === "Soup", "it shows");
    const row = page.locator(".view-row.active");
    await row.hover();
    await row.locator("button[aria-label='Delete']").click();
    await page.click(".modal button:has-text('Delete view')");
    await until(async () => (await tables(page)).views.length === 1, "deleted");
    await until(async () => (await page.textContent(".root-text")) === "Recipes", "the other view open");
    assert.ok((await tables(page)).nodes.some((n) => n.id === "soup"), "its root stays");
    await page.click(".main-bar button[title='Hide the side']");
  });

  await step("a child laid out freely: a scroll area sized by its corner, or one that grows to fit", async () => {
    await page.click(".item-head[data-node='bread'] .node-text", { button: "right" });
    await menuPath(page, ["Layout", "✥ Free"]);
    const area = ".item:has(> .item-head[data-node='bread']) .free-scroll";
    await page.waitForSelector(`${area} .free-item`);
    assert.equal(await page.locator(`${area} .free-item`).count(), 3);
    const corner = await page.locator(`${area} .corner-handle`).boundingBox();
    await page.mouse.move(corner.x + 5, corner.y + 5);
    await page.mouse.down();
    await page.mouse.move(corner.x - 120, corner.y - 150, { steps: 6 });
    await page.mouse.up();
    await until(async () => (await tables(page)).looks.find((l) => l.node === "bread")?.area_w < 560, "its size saved");
    await sleep(200);
    await page.screenshot({ path: join(SHOTS, "nested-free-dark.png") });
    await page.click(".item-head[data-node='bread'] .node-text", { button: "right" });
    await menuPath(page, ["Layout", "Size", "Grow to fit"]);
    await page.waitForSelector(".item:has(> .item-head[data-node='bread']) .free-grow .free-item");
    await until(async () => (await tables(page)).looks.find((l) => l.node === "bread")?.overflow === "grow", "saved");
  });

  await step("horizontal: the root's children side by side", async () => {
    await page.click(".main-bar .layout-switch button[aria-label='Horizontal']");
    await page.waitForSelector(".view-body > .list.horizontal");
    await until(
      async () => (await tables(page)).looks.find((l) => l.node === "root")?.layout === "horizontal",
      "saved",
    );
    await sleep(150);
    await page.screenshot({ path: join(SHOTS, "horizontal-dark.png") });
  });

  await step("free: a canvas with edges as arrows and order badges; drag a child where you want it", async () => {
    await page.click(".main-bar .layout-switch button[aria-label='Free']");
    await page.waitForSelector(".canvas-area .free-item");
    await sleep(300);
    assert.ok((await page.locator(".free-svg line.edge-line").count()) >= 1, "edges drawn");
    assert.ok(await page.isVisible(".free-item .order-badge"));
    const item = page.locator(".free-item[data-group='g-soup']");
    const grip = item.locator(".grip").first();
    const a = await grip.boundingBox();
    await page.mouse.move(a.x + 4, a.y + 6);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(a.x + 4 + i * 40, a.y + 6 + i * 25);
      await sleep(20);
    }
    await page.mouse.up();
    await until(async () => (await tables(page)).looks.find((l) => l.node === "soup")?.x > 100, "its place saved");
    await page.click(".canvas-tools .fit");
    await sleep(200);
    await page.screenshot({ path: join(SHOTS, "free-dark.png") });
  });

  await step("free: dragging the background pans the canvas; a box follows the pointer over other boxes", async () => {
    const spotX = async () => (await page.evaluate(() => window.__layr.state)).spots?.["v1/root"]?.x ?? 0;
    // An empty spot of the canvas: not on a box or the tools.
    const empty = await page.evaluate(() => {
      const r = document.querySelector(".canvas-area").getBoundingClientRect();
      for (let y = r.top + 10; y < r.bottom - 60; y += 15)
        for (let x = r.left + 10; x < r.right - 160; x += 15) {
          const el = document.elementFromPoint(x, y);
          if (el && !el.closest(".free-item, .canvas-tools")) return { x, y };
        }
      return null;
    });
    assert.ok(empty, "an empty spot");
    const before = await spotX();
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.down();
    assert.ok(await page.evaluate(() => document.body.classList.contains("panning")), "panning");
    await page.mouse.move(empty.x + 50, empty.y + 30, { steps: 5 });
    await page.mouse.move(empty.x + 100, empty.y + 60, { steps: 5 });
    await page.mouse.up();
    await until(async () => Math.abs((await spotX()) - before - 100) <= 1, "panned by 100");
    assert.ok(!(await page.evaluate(() => document.body.classList.contains("panning"))), "panning ended");
    // A second pan works too (a pan whose release was missed doesn't block the next).
    await page.mouse.move(empty.x + 100, empty.y + 60);
    await page.mouse.down();
    await page.mouse.move(empty.x + 60, empty.y + 60, { steps: 4 });
    await page.mouse.up();
    await until(async () => Math.abs((await spotX()) - before - 60) <= 1, "panned back by 40");

    // Dragged over another box, the box still follows the pointer.
    const item = page.locator(".free-item[data-group='g-soup']");
    const other = await page.locator(".free-item[data-group='g-bread'] .node-text").first().boundingBox();
    const grip = await item.locator(".grip").first().boundingBox();
    const start = await item.evaluate((el) => el.style.left + "," + el.style.top);
    await page.mouse.move(grip.x + 4, grip.y + 6);
    await page.mouse.down();
    const lefts = [];
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(grip.x + 4 + ((other.x + 20 - grip.x) * i) / 6, grip.y + 6 + ((other.y + 8 - grip.y) * i) / 6);
      lefts.push(await item.evaluate((el) => el.style.left + "," + el.style.top));
      // The label shows only over another node or group it would go into (lit up), not over its own layout.
      const [hidden, lit] = await page.evaluate(() => [
        document.querySelector(".drag-ghost")?.hidden,
        !!document.querySelector(".drop-target"),
      ]);
      assert.equal(hidden, !lit, "a label only over another target");
    }
    assert.equal(new Set(lefts).size, lefts.length, `it moved on each step: ${lefts}`);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    assert.equal(await item.evaluate((el) => el.style.left + "," + el.style.top), start, "back where it was");
    await sleep(100);
  });

  await step("free: a click on a box's text selects it; a second click types in it", async () => {
    const head = page.locator(".free-item[data-group='g-soup'] .item-head").first();
    const text = head.locator(".node-text");
    await text.click();
    await until(async () => (await head.getAttribute("class")).includes("selected"), "selected");
    assert.ok(!(await text.evaluate((el) => document.activeElement === el)), "not typed in yet");
    await text.click();
    assert.ok(await text.evaluate((el) => document.activeElement === el), "typed in");
    await page.keyboard.press("Escape");
    // A click beside its rows, in the box, selects the box's node.
    const spot = await page.evaluate(() => {
      const item = document.querySelector(".free-item[data-group='g-bread']");
      const r = item.getBoundingClientRect();
      for (let y = r.top + 1; y < r.bottom; y += 2)
        for (let x = r.left + 1; x < r.right - 6; x += 2) if (document.elementFromPoint(x, y) === item) return { x, y };
      return null;
    });
    assert.ok(spot, "a spot in the box beside its rows");
    await page.mouse.click(spot.x, spot.y);
    await until(
      async () =>
        (await page.locator(".free-item[data-group='g-bread'] .item-head").first().getAttribute("class")).includes(
          "selected",
        ),
      "the box selected",
    );
  });

  await step("Ctrl+scroll zooms the canvas, kept with the panel", async () => {
    const box = await page.locator(".canvas-area").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.up("Control");
    await until(
      async () => ((await page.evaluate(() => window.__layr.state)).spots?.["v1/root"]?.zoom ?? 0) > 0.8,
      "zoom kept",
    );
  });

  await step("arranged automatically (Organic, in a worker), then once by Grid and by hand again", async () => {
    await page.click(".root-row .row-tools button");
    await sleep(200);
    await menuPath(page, ["Layout", "Arrange", "Organic"]);
    await until(
      async () => (await tables(page)).looks.find((l) => l.node === "root")?.arrange === "organic",
      "organic",
    );
    await page.waitForSelector(".free:not(.pending)");
    await page.click(".canvas-tools .fit");
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, "free-organic-dark.png") });
    await page.click(".root-row .row-tools button");
    await menuPath(page, ["Layout", "Arrange", "Once, then by hand", "Grid"]);
    await until(async () => {
      const t = await tables(page);
      return t.looks.find((l) => l.node === "root")?.arrange == null && t.looks.filter((l) => l.x !== null).length >= 5;
    }, "placed once, by hand again");
  });

  await step("the Prototypes panel: two side by side, and what one came from", async () => {
    const p2 = await open("/panels/prototypes.html", { params: { nodes: ["login2"] } });
    await p2.waitForSelector("body[data-ready='1']");
    await p2.click("button:has-text('What it came from')");
    await p2.waitForSelector(".proto-tabs button:has-text('Side by side')");
    assert.equal(await p2.locator(".proto-column").count(), 2);
    await p2.frameLocator(".proto-column >> nth=1 >> iframe").locator("text=Email and password").waitFor();
    await sleep(200);
    await p2.screenshot({ path: join(SHOTS, "prototypes-compare-dark.png") });
    await p2.click(".proto-tabs button:has-text('Login card, rounder')");
    assert.equal(await p2.locator(".proto-column:not([hidden])").count(), 1);
    await p2.close();
  });

  await step("a phone: narrow, light, the same menus", async () => {
    const phone = await open("/panels/concepts.html", {
      width: 390,
      height: 760,
      theme: "light",
      state: { view: "v1" },
    });
    await phone.waitForSelector("body[data-ready='ready']");
    await phone.waitForSelector(".item-head:has-text('Flour')");
    await phone.screenshot({ path: join(SHOTS, "narrow-0.2-light.png") });
    await phone.click(".item-head[data-node='soup'] .row-tools button[title^='More']");
    await phone.waitForSelector(".menu-box");
    await phone.screenshot({ path: join(SHOTS, "narrow-menu-light.png") });
    await phone.close();
  });

  await step("no errors in the pages", async () => {
    assert.deepEqual(errors, []);
  });
} finally {
  await browser.close();
  server.close();
}
console.log(`${steps.length} steps passed`);
