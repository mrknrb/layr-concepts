// The Concepts panel and the backend through a real core, in headless Chromium, signed in as the TEST account
// (LAYR_TEST_EMAIL, LAYR_TEST_PASSWORD; never the user's). It starts `layr serve` (a copy of core's debug build, so
// cargo can still rebuild it) on a free port with a temporary home and this plugin linked, signs the core in, makes a
// test tree under "layr_flutter test (delete me) …" with the backend's tools (over /mcp), clicks through the panel,
// takes screenshots into screenshots/, and deletes everything it made.
//   cargo build -p layr_cli   (in core/), then:  node test/panels.e2e.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createSupabase } from "../shared/supabase.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, "..");
const CORE = join(PLUGIN, "..", "..", "core");
const SHOTS = join(PLUGIN, "screenshots");
const require = createRequire(join(process.env.PWTOOLS ?? "C:/Users/mrknr/pwtools", "package.json"));
const { chromium } = require("playwright");

const { LAYR_TEST_EMAIL: email, LAYR_TEST_PASSWORD: password } = process.env;
if (!email || !password) {
  console.log("skipped: set LAYR_TEST_EMAIL and LAYR_TEST_PASSWORD (the test account)");
  process.exit(0);
}
mkdirSync(SHOTS, { recursive: true });

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- the core ----------

const port = await freePort();
const token = "e2e-" + Math.random().toString(36).slice(2);
const home = mkdtempSync(join(tmpdir(), "layr-concepts-e2e-"));
const exe = join(home, "layr.exe");
copyFileSync(join(CORE, "target", "debug", process.platform === "win32" ? "layr.exe" : "layr"), exe);
const core = spawn(exe, ["serve", "--port", String(port), "--token", token, "--home", join(home, "home"), "--link", PLUGIN], {
  cwd: CORE,
  stdio: ["ignore", "pipe", "pipe"],
});
let coreLog = "";
core.stdout.on("data", (d) => (coreLog += d));
core.stderr.on("data", (d) => (coreLog += d));
console.log(`layr serve pid ${core.pid} on ${port}`);

for (let i = 0; ; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_layr/layr.js`);
    if (res.ok) break;
  } catch {
    // not yet
  }
  if (i > 300) throw new Error(`layr serve didn't start:\n${coreLog}`);
  await sleep(200);
}

class Shell {
  constructor(url) {
    this.url = url;
    this.next = 1;
    this.pending = new Map();
    this.events = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`Can't connect to ${this.url}`));
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? p.reject(Object.assign(new Error(msg.error.message), msg.error)) : p.resolve(msg.result);
        } else if (msg.method === "event") this.events.push(msg.params);
      };
    });
  }
  call(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

process.on("exit", () => core.kill());
process.on("uncaughtException", (error) => {
  console.log("FAIL", error.stack ?? error);
  console.log(coreLog.slice(-3000));
  core.kill();
  process.exit(1);
});
const shell = new Shell(`ws://127.0.0.1:${port}/_layr/ws?token=${token}`);
await shell.open();
await shell.call("events.subscribe", { topic: "shell:notify" });
await shell.call("settings.set", { key: "theme", value: { mode: "dark" } });

/** Tools through the hub's MCP endpoint, as the shell: the backend runs and asks the hub for the session. */
const hubClient = new Client({ name: "concepts-e2e", version: "0.1.0" });
await hubClient.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const mcp = (method, params) =>
  method === "tools/list" ? hubClient.listTools() : hubClient.callTool({ name: params.name, arguments: params.arguments });
async function tool(name, args = {}) {
  const r = await mcp("tools/call", { name: `concepts__${name}`, arguments: args });
  const text = r.content?.map((c) => c.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The test's own client for cleaning up (the same account).
const config = readFileSync(join(CORE, "layr_core", "src", "config.rs"), "utf8");
const SUPABASE = /SUPABASE_URL: &'static str = "([^"]+)"/.exec(config)[1];
const KEY = /SUPABASE_KEY: &'static str = "([^"]+)"/.exec(config)[1];

const steps = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    steps.push(`ok   ${name} (${Date.now() - t0} ms)`);
    console.log(steps.at(-1));
  } catch (error) {
    steps.push(`FAIL ${name}: ${error.message}`);
    const notes = shell.events.filter((e) => e.topic === "shell:notify").map((e) => `${e.data.kind}: ${e.data.text}`);
    if (notes.length) console.log("notifications:", notes.join(" | "));
    if (consoleErrors.length) console.log("page errors:", consoleErrors.join(" | "));
    console.log(steps.at(-1));
    throw error;
  }
};

const ROOT = `layr_flutter test (delete me) panel ${new Date().toISOString().slice(0, 19)}`;
let root = null;
let tables = null;
let before = null;
let browser = null;
const consoleErrors = [];

try {
  await step("the panel says to sign in while signed out", async () => {
    const created = await shell.call("panels.create", { plugin: "concepts", panel: "map" });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
    await page.goto(created.url);
    await page.waitForSelector("text=Sign in to see your concept map", { timeout: 30000 });
    await page.screenshot({ path: join(SHOTS, "signed-out.png") });
    await page.close();
    await shell.call("panels.close", { instance: created.instance });
  });

  await step("the core signs in as the test account; the backend gets the session through the hub", async () => {
    const status = await shell.call("auth.signIn", { email, password });
    assert.equal(status.signedIn, true);
    const tools = await mcp("tools/list", {});
    assert.ok(tools.tools.some((t) => t.name === "concepts__read"), "concepts tools are on the hub");
    assert.ok(!tools.tools.some((t) => t.name === "layr__supabase_session"), "the shell's list has no session tool");
    const views = await tool("views");
    assert.ok(Array.isArray(views.views));
    const session = await createSupabase({
      session: async () => {
        const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const body = await res.json();
        return { url: SUPABASE, key: KEY, accessToken: body.access_token, expiresAt: body.expires_at, userId: body.user.id };
      },
    });
    tables = session.tables;
    before = {
      tags: new Set((await tables.select("tags")).map((t) => t.id)),
      sets: new Set((await tables.select("tag_sets")).map((t) => t.id)),
      types: new Set(((await tables.rpc("types", {})).types ?? []).map((t) => t.id)),
    };
  });

  await step("a test tree, made with the tools", async () => {
    const view = await tool("create_view", { text: ROOT });
    root = (await tables.rpc("find", { prefix: view.id }))[0];
    const added = await tool("add", {
      parent: root,
      texts: [
        "Sourdough starter",
        { text: "Bread recipes", children: ["Country loaf", "Rye with caraway", "Focaccia"] },
        "Oven temperatures",
        "Flour types",
      ],
    });
    const id = (title) => {
      const all = added.added.flatMap((a) => [a, ...(a.children ?? [])]);
      return all.find((a) => a.text === title).id;
    };
    await tool("summary", { node: id("Bread recipes"), text: "Three loaves we bake most, with timings." });
    await tool("define_tag", { tag: "lf-e2e Tried", set: "lf-e2e Status", color: "green", description: "test" });
    await tool("define_tag", { tag: "lf-e2e Wish", set: "lf-e2e Status", color: "orange", description: "test" });
    await tool("tag", { nodes: [id("Country loaf"), id("Sourdough starter")], add: ["lf-e2e Tried"] });
    await tool("tag", { node: id("Focaccia"), add: ["lf-e2e Wish"] });
    await tool("connect", { from: id("Sourdough starter"), to: id("Country loaf"), type: "lf-e2e feeds", newType: true });
    await tool("prototype", {
      title: "Timer card",
      parent: root,
      html:
        '<div class="layr-card" style="padding:12px"><b>Proof</b> <span class="layr-badge">2:30</span>' +
        '<p class="layr-muted">Countdown for the next fold.</p><button class="layr-button primary">Start</button></div>',
    });
    const proposed = await tool("move", { parent: root, child: id("Flour types"), to: id("Bread recipes") });
    assert.match(proposed, /Proposed, not done yet/);
  });

  let page;
  await step("the panel shows the view: outline, tags, summary, edge, proposal", async () => {
    const created = await shell.call("panels.create", { plugin: "concepts", panel: "map", params: { node: root } });
    page = await browser.newPage({ viewport: { width: 1180, height: 720 } });
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(e.message));
    await page.goto(created.url);
    await page.waitForSelector(`.root-text:has-text("${ROOT}")`, { timeout: 30000 });
    await page.waitForSelector(".item-head:has-text('Bread recipes')");
    assert.ok(await page.isVisible(".tag-pill:has-text('lf-e2e Tried')"));
    assert.ok(await page.isVisible(".edge-chip:has-text('lf-e2e feeds')"));
    assert.ok(await page.isVisible(`.proposal:has-text('Flour types'):has-text('${ROOT}')`));
    await page.screenshot({ path: join(SHOTS, "view-dark.png") });
  });

  await step("opening a group loads its children and remembers it in the view", async () => {
    await page.click(".item-head:has-text('Bread recipes') .toggle");
    await page.waitForSelector(".item-head:has-text('Rye with caraway')");
    assert.ok(await page.isVisible(".summary:has-text('Three loaves')"));
    const looks = await tables.select("looks", { node: (await tables.rpc("find", { prefix: (await tool("search", { query: "Bread recipes", under: root }))[0].id }))[0] });
    assert.equal(looks[0]?.open, true);
  });

  await step("picking a node shows its details; its text is edited there", async () => {
    await page.click(".item-head:has-text('Country loaf') .node-text");
    await page.waitForSelector(".details .d-text");
    assert.equal(await page.inputValue(".details .d-text"), "Country loaf");
    assert.ok(await page.isVisible(".details .d-edges:has-text('Sourdough starter')"));
    await page.screenshot({ path: join(SHOTS, "details-dark.png") });
    await page.fill(".details .d-text", "Country loaf (75% water)");
    await page.press(".details .d-text", "Enter");
    await page.waitForSelector(".item-head:has-text('Country loaf (75% water)')");
    // Saved as the user (the panel writes itself): the backend reads it back.
    for (let i = 0; i < 20 && !/75% water/.test(await tool("read", { node: root, budget: 4000 })); i++) await sleep(250);
    assert.match(await tool("read", { node: root, budget: 4000 }), /Country loaf \(75% water\)/);
  });

  await step("adding nodes with Enter", async () => {
    await page.click("button.add-row");
    await page.fill("input.adder", "Scoring patterns");
    await page.press("input.adder", "Enter");
    await page.waitForSelector(".item-head:has-text('Scoring patterns')");
    await page.fill("input.adder", "Steam in the oven");
    await page.press("input.adder", "Enter");
    await page.waitForSelector(".item-head:has-text('Steam in the oven')");
    await page.press("input.adder", "Escape");
    const read = await tool("read", { node: root });
    assert.match(read, /Scoring patterns[\s\S]*Steam in the oven/);
  });

  await step("tagging from the details", async () => {
    await page.click(".item-head:has-text('Steam in the oven') .node-text");
    await page.waitForSelector(".details .d-text");
    const wish = await page.$eval(".details select.small-select", (s) =>
      [...s.options].find((o) => o.textContent.startsWith("lf-e2e Wish")).value,
    );
    await page.selectOption(".details select.small-select", wish);
    await page.waitForSelector(".item-head:has-text('Steam in the oven') .tag-pill:has-text('lf-e2e Wish')");
  });

  await step("a prototype's page shows live in the details", async () => {
    await page.click(".item-head:has-text('Timer card') .node-text");
    await page.waitForSelector(".details iframe.proto-frame");
    const frame = page.frameLocator(".details iframe.proto-frame");
    await frame.locator("text=Countdown for the next fold.").waitFor();
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, "prototype-dark.png") });
  });

  await step("accepting the proposal runs it on the backend", async () => {
    const mine = `.proposal:has-text('Flour types'):has-text('${ROOT}')`;
    await page.click(`${mine} button:has-text('Accept')`);
    await page.waitForSelector(mine, { state: "detached", timeout: 30000 });
    await page.waitForSelector(".item-children .item-head:has-text('Flour types')");
    const read = await tool("read", { node: (await tool("search", { query: "Bread recipes", under: root }))[0].id });
    assert.match(read, /Flour types/);
  });

  await step("search finds a node and reveals it", async () => {
    await page.fill("#search", "caraway");
    await page.waitForSelector(".hit:has-text('Rye with caraway')");
    await page.screenshot({ path: join(SHOTS, "search-dark.png") });
    await page.click(".hit:has-text('Rye with caraway')");
    await page.waitForSelector(".item-head.selected:has-text('Rye with caraway')");
  });

  await step("light theme", async () => {
    await shell.call("settings.set", { key: "theme", value: { mode: "light" } });
    await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, "view-light.png") });
  });

  await step("a narrow tab: the outline alone, the side and details over it", async () => {
    await page.setViewportSize({ width: 360, height: 640 });
    await sleep(300);
    await page.screenshot({ path: join(SHOTS, "narrow-details-light.png") });
    const r0 = await page.evaluate(() => window.conceptsRenders);
    await sleep(1000);
    const r1 = await page.evaluate(() => window.conceptsRenders);
    assert.ok(r1 - r0 < 3, `the panel keeps drawing itself (${r1 - r0} times in a second)`);
    await page.click(".details button[title='Close']");
    await sleep(200);
    if (await page.isVisible(".side")) await page.click(".side button[title='Hide the side']");
    await sleep(200);
    assert.ok(!(await page.isVisible(".side")) && !(await page.isVisible(".details")));
    await page.screenshot({ path: join(SHOTS, "narrow-light.png") });
    await page.click(".main-bar button[title='Views and proposals']");
    await page.waitForSelector(".side .view-row");
    await sleep(200);
    await page.screenshot({ path: join(SHOTS, "narrow-side-light.png") });
    await page.click(".side button[title='Hide the side']");
    await shell.call("settings.set", { key: "theme", value: { mode: "dark" } });
  });

  await step("deleting a node from the details asks first", async () => {
    await page.setViewportSize({ width: 1180, height: 720 });
    await page.click(".item-head:has-text('Oven temperatures') .node-text");
    await page.click(".details button:has-text('Delete everywhere')");
    await page.waitForSelector(".modal:has-text('Delete \"Oven temperatures\"?')");
    await page.screenshot({ path: join(SHOTS, "delete-dialog-dark.png") });
    await page.click(".modal button:has-text('Delete everywhere')");
    await page.waitForSelector(".item-head:has-text('Oven temperatures')", { state: "detached" });
    assert.equal((await tool("search", { query: "Oven temperatures", under: root })).length, 0);
  });

  await step("no errors in the page", async () => {
    assert.deepEqual(consoleErrors, []);
  });
} finally {
  if (tables && root) {
    const below = new Set([root]);
    let frontier = [...below];
    while (frontier.length) {
      const groups = await tables.select("groups", { parent: frontier });
      frontier = groups.map((g) => g.child).filter((c) => !below.has(c));
      for (const c of frontier) below.add(c);
    }
    // Edge types the test made ("lf-e2e feeds").
    for (const t of (await tables.rpc("types", {})).types ?? []) if (!before.types.has(t.id)) below.add(t.id);
    await tables.delete("nodes", { id: [...below] });
    const tags = (await tables.select("tags")).filter((t) => !before.tags.has(t.id));
    if (tags.length) await tables.delete("tags", { id: tags.map((t) => t.id) });
    const sets = (await tables.select("tag_sets")).filter((t) => !before.sets.has(t.id));
    if (sets.length) await tables.delete("tag_sets", { id: sets.map((t) => t.id) });
    // Proposals of test trees (this run's, and any a failed run left).
    const stale = (await tables.select("proposals")).filter((p) => p.title.includes("layr_flutter test (delete me)"));
    if (stale.length) await tables.delete("proposals", { id: stale.map((p) => p.id) });
    const left = await tables.select("nodes", { id: [...below] });
    steps.push(`cleanup: deleted ${below.size} nodes, ${tags.length} tags, ${sets.length} sets; ${left.length} left`);
    console.log(steps.at(-1));
  }
  await browser?.close();
  await shell.call("auth.signOut").catch(() => {});
  core.kill();
  if (process.exitCode) console.log(coreLog.slice(-3000));
}
