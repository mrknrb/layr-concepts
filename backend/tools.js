import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { prototypeLink } from "../shared/links.js";
import { applyRetype, connect, EDGE_PAGE, findType, groupEdges, MANY, MAX_EDGES } from "../shared/edges.js";
import { firstLine, Graph } from "../shared/graph.js";
import { IMAGE_FOLDER, imagePath, imageType, MAX_ATTACHED_BYTES, strayFiles } from "../shared/image.js";
import { CHECK_PAGE, checkGroup, follow, FOLLOW_MAX } from "../shared/inspect.js";
import { Ops, uuid } from "../shared/ops.js";
import { nodeLabel, outline, shortId } from "../shared/outline.js";
import { applyProposal } from "../shared/proposals.js";
import { applyEdits, checkPage, DEVELOPED_FROM, PROTOTYPES_GROUP } from "../shared/prototype.js";
import { SETTINGS_COLLECTION, SETTINGS_ID, settingsOf } from "../shared/settings.js";
import { childrenOutline, DEFAULT_BUDGET, MAX_BUDGET, readOutline } from "../shared/read.js";
import { applyBundle, applyRow, TABLES, TAG_COLORS } from "../shared/rows.js";
import { projectMaps } from "./project.js";
import { currentActor, describeThread, threads, touch } from "./threads.js";
/**
 * How to use the tools: the MCP server's instructions, and the answer of `concepts__guide` (layr's hub doesn't pass
 * a backend's instructions on to agents).
 */
const INSTRUCTIONS = [
  "layr concepts: the user's concept map, read and changed with the concepts__* tools.",
  "- Every concept is a node. The nodes inside a node (its children, a group) together make up what it means, and " +
    "their order matters unless the node says \"order doesn't matter\". A node's text is the title of what is " +
    "inside it.",
  "- A summary is only a short version of a node's children (or of its own long text). Use it to decide what to " +
    "read, never as a source of facts, and ignore it when it is outdated: facts, and anything you write, come from " +
    "nodes.",
  "- Read wide before deep: concepts__read shows titles and summaries first and opens groups while its budget lasts. " +
    "Stop once you have enough; read a node by its #id to go deeper. Start from concepts__views or concepts__search.",
  '- Edges connect nodes. Their type is a node under "Edge types" (concepts__types): reuse one, and make a new one ' +
    "only when none fits. concepts__connect takes many edges at once (`edges`) and says for each what it did; " +
    "concepts__edges lists the edges in a group, to check your work.",
  "- Tags label nodes, e.g. a feature's status; outlines show them as `tags: Planned, mobile`. concepts__tags lists " +
    "them with what they mean, concepts__tag puts them on nodes or takes them off (a set with one tag per node, like " +
    "a status, swaps the old one for the new), concepts__search with `tags` finds the nodes that have them. Say with " +
    "a tag what a tag says, not with nodes or edges; make new tags (concepts__define_tag) only when none fits.",
  "- Give nodes by #id (the 8 characters outlines show, or all of it), or by their exact title when only one node " +
    "has it.",
  "- Search before creating a node; a node can be in several groups (concepts__add with `node` or `nodes`).",
  "- A node can be a prototype: a UI suggestion as a small live HTML page. When the user asks to see a UI or UX " +
    "suggestion, make one with concepts__prototype, one node per idea: alternatives are separate nodes with no " +
    "connection. Buttons, transitions and animations work, so make it feel real instead of describing it, and mock " +
    "only the part in question, with realistic sample data. Write the `link` it returns in your reply: the user opens it " +
    "in the Concepts panel, where the prototypes show live.",
  "- To develop a prototype, call concepts__prototype with `from`: it makes a new node connected to the old one by " +
    'a "developed from" edge, and the old one stays. Send `edits` (read the page with concepts__prototype_page), not ' +
    "a whole new page. Two nodes developed from one are a branch. The user's comments are the prototype's child " +
    "nodes: read them first.",
  "- A node can hold one picture. Outlines mark it `picture`, with its caption when it has one, and concepts__search " +
    "looks in captions too. A picture costs tokens only when you look at it: concepts__image shows it to you, so look " +
    "when it matters. concepts__set_image gives a node a picture from a file on the PC, or changes its caption; when " +
    "you've looked at a picture without one and can say what it shows, write it, so it can be found.",
  "- A prototype's page runs with no network: no CDN scripts, fonts, images or fetch, no eval, no alert(). Draw " +
    "pictures with inline SVG or data: URLs. Links don't navigate. For a layr suggestion, match the app: the page has " +
    "layr's CSS variables (--bg, --bg-2, --bg-3, --fg, --fg-dim, --border, --accent, --accent-fg, --danger, --radius, " +
    "--font, --font-mono) and its classes (layr-button, layr-button primary, layr-input, layr-textarea, layr-select, " +
    "layr-toolbar, layr-badge, layr-muted). Read the panel's real CSS and markup first and copy them, so only the " +
    "suggestion differs.",
  "- To check your work: concepts__edges lists a group's edges, concepts__check looks for what might be wrong in it, " +
    "concepts__follow follows edges of a type step by step, and concepts__history without a node shows the latest " +
    "changes across the map.",
  "- In a Claude thread, pass `thread` (your thread's id, when you know it; in a layr pipeline task, the task link " +
    "its first message gives) to every tool that changes the map, so the user can find your thread from the nodes. " +
    "When your " +
    "thread has something worth finding about a node it doesn't change (you read it, decided or learned something " +
    "about it), link them with concepts__mention and a short note. concepts__threads lists the threads of a node: " +
    "earlier work and discussions about it.",
  "- Every project has a project node with sections titled Rules, Brainstorm, Features and Plan (concepts__project " +
    "reads them with their rules; pipeline_projects gives each project's node). Follow a section's rules before " +
    "changing it: Features documents what the app does now, every node in one place, with changes under the " +
    'feature they change and "needs" edges for their order. A bug or idea you notice outside your task: ' +
    "don't fix it, file it with concepts__file.",
  "- When the text inside a group grows large (about 300 words or more), write or refresh its summary with " +
    "concepts__summary, from its children only.",
  "- Deleting, taking a node out of a group, moving it to another group, adding more than 10 nodes and retyping " +
    "more than 10 edges at once become proposals the user accepts or declines in the Concepts panel: tell them " +
    "when you make one. Several nodes in one call (`nodes`, `children`) make one proposal. concepts__views lists " +
    "those still waiting. The user can turn proposals off in Concepts Settings: then these changes are made right " +
    "away, and the tool's answer says so.",
].join("\n");
/** Links of the orchestrator's threads (`plugins/chat/shared/orchestrator.ts` orchestratorLink). */
const ORCHESTRATOR = "layr://chat/orchestrator/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The plugin's read functions (migration 0009). */
function loader(ctx) {
  return {
    get: (ids) => ctx.tables.rpc("get", { ids }),
    level: (parents, skip, pageSize) => ctx.tables.rpc("level", { parents, skip, page_size: pageSize }),
    where: (id) => ctx.tables.rpc("where", { node_id: id }),
  };
}
/** A node's full id from a full id, a unique prefix like outlines show, or a title only one node has. */
async function resolve(ctx, id) {
  const text = id.trim().replace(/^#/, "");
  if (UUID.test(text)) return text.toLowerCase();
  const found = /^[0-9a-f-]{4,}$/i.test(text) ? await ctx.tables.rpc("find", { prefix: text }) : [];
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new Error(`More than one node's id starts with "${text}": give more of it`);
  const title = id.trim().toLowerCase();
  const hits = title ? await search(ctx, id.trim(), 30) : [];
  const titled = hits.filter((h) => firstLine(h.text).toLowerCase() === title);
  if (titled.length === 1) return titled[0].id;
  if (titled.length > 1) throw new Error(`${titled.length} nodes are titled "${id.trim()}": give its #id`);
  throw new Error(`No node "${id}": give its #id (as outlines show it) or its exact title`);
}
/**
 * What a write needs, read fresh for each call so the AI never works on a stale copy: the nodes `ids` with their
 * edges and summaries, and the groups they are in. Ops read a group's places themselves when they put a child in it.
 */
async function slice(ctx, ids, strict = true) {
  const graph = new Graph();
  const [bundle, groups] = ids.length
    ? await Promise.all([loader(ctx).get(ids), ctx.tables.select(TABLES.groups, { child: ids })])
    : [undefined, []];
  applyBundle(graph, bundle);
  for (const row of groups) applyRow(graph, TABLES.groups, "insert", row);
  if (strict) for (const id of ids) if (!graph.node(id)) throw new Error(`No node ${shortId(id)}`);
  // The nodes each change touches go to the tool call running it, for the thread it acts for.
  return { graph, ops: new Ops(graph, ctx.tables, touch) };
}
const edgeTypes = async (ctx) => (await ctx.tables.rpc("types", {})).types;
/** The group for prototypes nothing says where to put: a view of its own, made the first time. */
async function prototypesGroup(ctx, ops) {
  const nodes = await ctx.tables.select(TABLES.nodes, { text: PROTOTYPES_GROUP });
  const views = await ctx.tables.select(TABLES.views, { root: nodes.map((n) => n.id) });
  if (views[0]) return views[0].root;
  const root = await ops.createNode(PROTOTYPES_GROUP);
  await ops.addView(root);
  return root;
}
/** Every tag and set into `graph` (there are few). */
async function loadTags(ctx, graph) {
  const [tags, sets] = await Promise.all([ctx.tables.select(TABLES.tags), ctx.tables.select(TABLES.tagSets)]);
  for (const row of sets) applyRow(graph, TABLES.tagSets, "insert", row);
  for (const row of tags) applyRow(graph, TABLES.tags, "insert", row);
  return graph;
}
/** A tag's id from its name, in any case (or its id). */
function tagId(graph, name) {
  const tag = graph.tags.get(name.trim()) ?? graph.tagByName(name);
  if (tag) return tag.id;
  const names = graph.sortedTags().map((t) => t.name);
  const there = names.length ? `there are: ${names.join(", ")}` : "there are none yet";
  throw new Error(`No tag "${name}" (${there}); make one with concepts__define_tag`);
}
/** What concepts_connect reads and writes with. */
const edgeSource = (ctx) => ({
  resolve: (name) => resolve(ctx, name),
  slice: (ids) => slice(ctx, ids, false),
  types: () => edgeTypes(ctx),
  select: (table, filter) => ctx.tables.select(table, filter),
  // A retype made right away answers in words too.
  propose: async (title, changes) => String(await propose(ctx, title, changes)),
});
const brief = (graph, id) => ({ id: shortId(id), text: nodeLabel(graph, id) });
/** Index among the loaded children of `parent` to insert at: right after `after` (a child node id), first, or last. */
function position(graph, parent, at) {
  if (at.first) return 0;
  if (!at.after) return undefined;
  const index = graph.children(parent).findIndex((g) => g.data.to === at.after);
  if (index < 0) throw new Error(`"${nodeLabel(graph, at.after)}" is not in "${nodeLabel(graph, parent)}"`);
  return index + 1;
}
function member(graph, parent, child) {
  const g = graph.membership(parent, child);
  if (!g) throw new Error(`"${nodeLabel(graph, child)}" is not in "${nodeLabel(graph, parent)}"`);
  return g;
}
const newText = (item) => (typeof item === "string" ? item : (item?.text ?? ""));
const newChildren = (item) => (typeof item === "string" ? [] : (item?.children ?? []));
const countNew = (items) => items.reduce((n, item) => n + 1 + countNew(newChildren(item)), 0);
/** Changes by tool name, with full ids. */
const CHANGES = {
  async add(ctx, { parent, texts, node, nodes, after, first }) {
    const existing = [...(node ? [node] : []), ...(nodes ?? [])];
    const { graph, ops } = await slice(ctx, [parent, ...existing]);
    // The children's titles, so `after` can be found.
    applyBundle(graph, await loader(ctx).level([parent], 0, 1000));
    let index = position(graph, parent, { after, first });
    if (existing.length) {
      for (const id of existing) {
        await ops.addChild(parent, id, index);
        if (index !== undefined) index++;
      }
      return { parent: brief(graph, parent), added: existing.map((id) => brief(graph, id)) };
    }
    if (!texts?.length) throw new Error("Give `texts` or `node`");
    const make = async (into, items, at) => {
      const added = [];
      for (const item of items) {
        const id = await ops.createNode(newText(item));
        await ops.addChild(into, id, at);
        if (at !== undefined) at++;
        const inside = newChildren(item);
        added.push({ ...brief(graph, id), ...(inside.length ? { children: await make(id, inside) } : {}) });
      }
      return added;
    };
    return { parent: brief(graph, parent), added: await make(parent, texts, index) };
  },
  async move(ctx, { parent, child, to, after, first }) {
    if (!child) throw new Error("Give `child`");
    const target = to ?? parent;
    const { graph, ops } = await slice(ctx, [parent, child, target]);
    applyBundle(graph, await loader(ctx).level([target], 0, 1000));
    const g = member(graph, parent, child);
    if (target !== parent) {
      await ops.moveToGroup(g.id, target, position(graph, target, { after, first }));
    } else {
      const rest = graph.children(target).filter((c) => c.id !== g.id);
      const index = first ? 0 : after ? rest.findIndex((c) => c.data.to === after) + 1 : rest.length;
      await ops.moveChild(g.id, index);
    }
    return outline(graph, target, { expanded: (id) => id === target });
  },
  async remove(ctx, { node, parent }) {
    if (!node) throw new Error("Give `node`");
    const { graph, ops } = await slice(ctx, [node, ...(parent ? [parent] : [])]);
    if (parent) await ops.removeFromGroup(member(graph, parent, node).id);
    else await ops.deleteNode(node);
    return { ok: true };
  },
  retype: (ctx, change) => applyRetype(edgeSource(ctx), change),
};
/** Run one change of a proposal (or of a big change made right away) by its tool's name. */
function runChange(ctx, change) {
  const run = CHANGES[change.tool];
  if (!run) throw new Error(`Unknown change ${change.tool}`);
  return run(ctx, change.args);
}
/** Whether the user lets the orchestrator change the map without proposals (Do it quietly, or Do it and tell me). */
async function mapFreedom(ctx) {
  const abilities = await ctx.commands.run("chat.orchestratorAbilities").catch(() => null);
  return abilities?.map === "quiet" || abilities?.map === "tell";
}
/** Whether big changes wait for the user (Concepts Settings; on unless turned off). Read each time: they are rare. */
async function proposalsOn(ctx) {
  const stored = await ctx.data.get(SETTINGS_COLLECTION, SETTINGS_ID);
  return settingsOf(stored?.data).proposals;
}
/**
 * Save a big change for the user to accept or decline: one or more changes, accepted together. With proposals off,
 * they are made right away instead, one by one; one that fails stops the rest, and those before it stay made.
 */
async function propose(ctx, title, changes) {
  const by = currentActor();
  // The orchestrator changes the map itself (task #281) while the user lets it (its "map" ability).
  const trusted = !!by?.thread.startsWith(ORCHESTRATOR) && (await mapFreedom(ctx));
  if (trusted || !(await proposalsOn(ctx))) {
    let result;
    for (const change of changes) result = await runChange(ctx, change);
    if (changes.length === 1) return result;
    const why = trusted ? "the orchestrator needs no proposals" : "proposals are off in Concepts Settings";
    return `Done right away (${why}): "${title}", ${changes.length} changes.`;
  }
  const saved = by ? changes.map((c) => ({ ...c, by })) : changes;
  const [row] = await ctx.tables.insert(TABLES.proposals, { title, changes: saved });
  const many = changes.length > 1 ? `, ${changes.length} changes` : "";
  return (
    `Proposed, not done yet: "${title}" (proposal ${shortId(row.id)}${many}). The user accepts or declines it in ` +
    "the Concepts panel; tell them."
  );
}
async function titles(ctx, ids) {
  const graph = new Graph();
  applyBundle(graph, await loader(ctx).get(ids));
  return (id) => `"${nodeLabel(graph, id)}"`;
}
const nodeArg = (description) => ({ type: "string", description });
const placeArgs = {
  after: nodeArg("Put it right after this child of the parent (node id)"),
  first: { type: "boolean", description: "Put it first instead of last" },
};
const THREAD_ARG = {
  type: "string",
  description:
    "Your Claude thread's id, when you know it (in a layr pipeline task, the task link its first message gives), " +
    "so the user finds your thread from the nodes",
};
/** Registers the tools and commands on `ctx` (backend/context.js: what layr_code's plugin host gave). */
export function activate(ctx) {
  ctx.mcp.setInstructions(INSTRUCTIONS);
  const load = loader(ctx);
  const links = threads(ctx);
  // Files left by deleted nodes: soon after each start, then daily. Before migration 0023 there's no bucket yet.
  const sweepImages = async () => {
    const files = await ctx.storage.list(IMAGE_FOLDER);
    const rows = await ctx.tables.select(TABLES.images);
    await ctx.storage.remove(strayFiles(files, rows, Date.now()));
  };
  const sweep = () => void sweepImages().catch((e) => ctx.log("sweeping pictures failed:", e?.message ?? e));
  // unref: they don't keep the process alive (it ends with its stdin).
  setTimeout(sweep, 60_000).unref?.();
  setInterval(sweep, 24 * 60 * 60 * 1000).unref?.();
  /** A tool that changes the map: the nodes it changes are linked to the thread it acts for (`thread`). */
  const writeTool = (tool) =>
    ctx.mcp.registerTool({
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: { ...tool.inputSchema.properties, thread: THREAD_ARG },
      },
      handler: async ({ thread, ...args }, call) =>
        links.runAs(await links.actor(call, thread), async () => tool.handler(args, call)),
    });
  projectMaps(ctx, {
    load,
    slice: (ids, strict) => slice(ctx, ids, strict),
    resolve: (id) => resolve(ctx, id),
    loadTags: (graph) => loadTags(ctx, graph),
    search: (query, max, under) => search(ctx, query, max, under),
    tagged: (tagIds, under, max) => ctx.tables.rpc("tagged", { tag_ids: tagIds, q: null, under, max_hits: max }),
    groupsOf: (ids) => ctx.tables.select(TABLES.groups, { child: ids }),
    types: () => edgeTypes(ctx),
    writeTool,
  });
  ctx.mcp.registerTool({
    name: "read",
    description:
      "Read part of the user's concept map as an outline, wide before deep: the node, then its children's titles " +
      "and summaries, opening groups while the budget lasts. Each line is a node (#id) with tags like '12 inside, " +
      "not opened' or '+380 words' (shortened); read one by its #id to see more. Lines like '--is a--> Grain " +
      "(#id)' are edges; 'Edges only here' under a group hold only inside it. Text may hold Markdown links to " +
      "other layr items, like [#12 Fix login](layr://pipeline/task/12).",
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id or id prefix"),
        budget: { type: "number", description: `Tokens to spend (default ${DEFAULT_BUDGET}, at most ${MAX_BUDGET})` },
      },
      required: ["node"],
    },
    handler: async ({ node, budget }) => readOutline(load, await resolve(ctx, node), budget),
  });
  ctx.mcp.registerTool({
    name: "children",
    description: "A page of a node's children, one line each with summaries: for groups with many children.",
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id"),
        offset: { type: "number", description: "Children to skip (default 0)" },
        limit: { type: "number", description: "At most this many (default 100)" },
      },
      required: ["node"],
    },
    handler: async ({ node, offset, limit }) =>
      childrenOutline(load, await resolve(ctx, node), offset ?? 0, Math.min(limit ?? 100, 500)),
  });
  ctx.mcp.registerTool({
    name: "views",
    description:
      "List the views (the roots the user keeps in the concepts panel, each with its own look; a root can have " +
      "several, by name), nodes that are in no group, and proposals still waiting for the user.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const views = await ctx.tables.select(TABLES.views);
      const graph = new Graph();
      applyBundle(graph, await load.get([...new Set(views.map((v) => v.root))]));
      const unplaced = await ctx.tables.rpc("unplaced", {
        max_nodes: 50,
      });
      return {
        views: views
          .filter((v) => graph.node(v.root))
          .map((v) => ({ ...brief(graph, v.root), ...(v.name ? { view: v.name } : {}) })),
        unplaced: unplaced.nodes.map((n) => ({ id: shortId(n.id), text: n.text || "(empty)" })),
        nodes: unplaced.total,
        proposals: (await ctx.tables.select(TABLES.proposals)).map(describeProposal),
      };
    },
  });
  ctx.mcp.registerTool({
    name: "decide",
    description:
      "Accept or decline a proposal waiting for the user (concepts__views lists them by id), as the Concepts " +
      "panel's buttons do: accepting makes its changes, as the thread that proposed it; declining drops it. A " +
      "proposal stopped by an error goes on where it stopped when accepted again; `skip` passes over the change " +
      "that failed.",
    inputSchema: {
      type: "object",
      properties: {
        proposal: { type: "string", description: "The proposal's id (or the start of it)" },
        accept: { type: "boolean", description: "true: make its changes; false: drop it" },
        skip: { type: "boolean", description: "Accepting again: pass over the change that failed" },
      },
      required: ["proposal", "accept"],
    },
    handler: async ({ proposal, accept, skip }) => {
      const wanted = proposal.trim().toLowerCase();
      const rows = await ctx.tables.select(TABLES.proposals);
      const found = rows.filter((r) => r.id.toLowerCase().startsWith(wanted));
      if (found.length !== 1) {
        throw new Error(
          found.length
            ? `"${proposal}" fits ${found.length} proposals: give more of its id`
            : "No such proposal: see concepts__views",
        );
      }
      const row = found[0];
      if (!accept) {
        await ctx.tables.delete(TABLES.proposals, { id: row.id });
        return { declined: row.title };
      }
      await ctx.commands.run("concepts.applyProposal", { id: row.id, ...(skip ? { skip } : {}) });
      return { accepted: row.title };
    },
  });
  ctx.mcp.registerTool({
    name: "search",
    description:
      "Find nodes whose text, summary or picture caption contains the query (any case), each with its summary, the " +
      "way down to it and how many groups it is in. `under`: only inside that node, at any depth. `tags`: only " +
      "nodes with all of these tags (then the query can be left out, e.g. every node tagged Planned).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        under: nodeArg("Only nodes inside this one"),
        tags: { type: "array", items: { type: "string" }, description: "Only nodes with all of these tags (names)" },
      },
    },
    handler: async ({ query, under, tags }) => {
      const inside = under ? await resolve(ctx, under) : undefined;
      let hits;
      if (tags?.length) {
        const graph = await loadTags(ctx, new Graph());
        hits = await ctx.tables.rpc("tagged", {
          tag_ids: tags.map((name) => tagId(graph, name)),
          q: query?.trim() || null,
          under: inside ?? null,
          max_hits: 50,
        });
      } else if (query?.trim()) hits = await search(ctx, query, 30, inside);
      else throw new Error("Give `query`, or `tags`");
      return hits.map((h) => ({
        id: shortId(h.id),
        text: shortText(h.text),
        ...(h.summary ? { summary: h.summary } : {}),
        path: h.path.map((p) => p.text || "(empty)").join(" › "),
        ...(h.parents > 1 ? { groups: h.parents } : {}),
        ...(h.image ? { picture: h.caption || true } : {}),
      }));
    },
  });
  ctx.mcp.registerTool({
    name: "neighbors",
    description: "A node's edges both ways (type, label, the other node), 50 at a time.",
    inputSchema: {
      type: "object",
      properties: { node: nodeArg("Node id"), offset: { type: "number", description: "Edges to skip" } },
      required: ["node"],
    },
    handler: async ({ node, offset }) => {
      const result = await ctx.tables.rpc("neighbors", {
        node_id: await resolve(ctx, node),
        skip: offset ?? 0,
        max_edges: 50,
      });
      return {
        total: result.total,
        edges: result.edges.map((e) => {
          const name = [e.type?.text, e.label].filter(Boolean).join(" · ");
          const other = `${e.other.text || "(empty)"} (#${shortId(e.other.id)})`;
          const line = e.out ? `--${name ? `${name}--` : ""}> ${other}` : `<--${name ? `${name}--` : ""} ${other}`;
          return e.in ? `${line} (only in ${e.in.text})` : line;
        }),
      };
    },
  });
  ctx.mcp.registerTool({
    name: "types",
    description: 'The edge types (children of the "Edge types" node), each with the start of what it means.',
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const result = await ctx.tables.rpc("types", {});
      return result.types.map((t) => ({
        id: shortId(t.id),
        type: t.text,
        ...(t.meaning ? { means: t.meaning } : {}),
      }));
    },
  });
  ctx.mcp.registerTool({
    name: "tags",
    description:
      "The tags nodes can have, set by set, each with what it means and how many nodes have it. In a set with " +
      "`onePerNode` (like a status) a node has at most one of its tags.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const graph = await loadTags(ctx, new Graph());
      if (!graph.tags.size && !graph.tagSets.size) return "No tags yet: make them with concepts__define_tag";
      const counts = await ctx.tables.rpc("tag_counts", {});
      const describe = (t) => ({
        tag: t.name,
        ...(t.description ? { means: t.description } : {}),
        nodes: counts[t.id] ?? 0,
      });
      const tags = graph.sortedTags();
      const loose = tags.filter((t) => !t.tag_set || !graph.tagSets.has(t.tag_set));
      return {
        sets: graph.sortedTagSets().map((s) => ({
          set: s.name,
          ...(s.single ? { onePerNode: true } : {}),
          ...(s.description ? { means: s.description } : {}),
          tags: tags.filter((t) => t.tag_set === s.id).map(describe),
        })),
        ...(loose.length ? { tags: loose.map(describe) } : {}),
      };
    },
  });
  writeTool({
    name: "tag",
    description:
      "Put tags on nodes (`add`) or take them off (`remove`), by their names from concepts__tags. A tag of a set " +
      "with one tag per node (like a status) replaces the node's other tag of that set. Up to 100 nodes at once.",
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id"),
        nodes: { type: "array", items: { type: "string" }, description: "Several nodes instead" },
        add: { type: "array", items: { type: "string" }, description: "Tag names to put on" },
        remove: { type: "array", items: { type: "string" }, description: "Tag names to take off" },
      },
    },
    handler: async ({ node, nodes, add, remove }) => {
      const names = [...(node ? [node] : []), ...(nodes ?? [])];
      if (!names.length) throw new Error("Give `node` or `nodes`");
      if (names.length > 100) throw new Error("At most 100 nodes at once");
      if (!add?.length && !remove?.length) throw new Error("Give `add` or `remove`");
      const ids = [...new Set(await resolveList(ctx, names))];
      const { graph, ops } = await slice(ctx, ids);
      await loadTags(ctx, graph);
      // Every name is checked before anything changes.
      const on = (add ?? []).map((name) => tagId(graph, name));
      const off = (remove ?? []).map((name) => tagId(graph, name));
      for (const id of ids) {
        for (const tag of off) await ops.untag(id, tag);
        for (const tag of on) await ops.tag(id, tag);
      }
      return ids.map((id) => {
        const now = graph.tagsOf(id).map((t) => t.name);
        return `${nodeLabel(graph, id)} (#${shortId(id)}): ${now.length ? now.join(", ") : "no tags"}`;
      });
    },
  });
  ctx.mcp.registerTool({
    name: "define_tag",
    description:
      "Make or change a tag (`tag`), or with `set` alone a set of tags. A new tag goes into `set` (made if it is " +
      'new; give `set: ""` to take a tag out of its set). `onePerNode` makes a set allow one of its tags per ' +
      `node, like a status. \`description\`: what it means; \`color\`: ${TAG_COLORS.join(", ")}. Look at ` +
      "concepts__tags first and reuse what fits. Deleting tags is left to the user, in the Concepts panel.",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "The tag's name (a new one makes it)" },
        set: { type: "string", description: "The set's name (a new one makes it)" },
        rename: { type: "string", description: "A new name for the tag, or for the set when no `tag` is given" },
        description: { type: "string", description: "What it means" },
        color: { type: "string", enum: [...TAG_COLORS] },
        onePerNode: { type: "boolean", description: "For a set: a node has at most one of its tags" },
      },
    },
    handler: async ({ tag, set, rename, description, color, onePerNode }) => {
      if (color && !TAG_COLORS.includes(color)) {
        throw new Error(`No color "${color}": use one of ${TAG_COLORS.join(", ")}`);
      }
      const graph = await loadTags(ctx, new Graph());
      const ops = new Ops(graph, ctx.tables);
      /** The set named `name`, made when there is none. */
      const setOf = async (name) => {
        const found = graph.tagSetByName(name);
        if (found) return found.id;
        return ops.createTagSet({ name, single: !tag && onePerNode });
      };
      if (!tag) {
        if (!set?.trim()) throw new Error("Give `tag`, or `set`");
        const id = await setOf(set);
        await ops.updateTagSet(id, {
          ...(rename !== undefined ? { name: rename } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(onePerNode !== undefined ? { single: onePerNode } : {}),
        });
        const s = graph.tagSets.get(id);
        return `Set "${s.name}"${s.single ? " (one tag per node)" : ""}${s.description ? `: ${s.description}` : ""}`;
      }
      if (onePerNode !== undefined) throw new Error("`onePerNode` is for a set: give it with `set` and no `tag`");
      const tagSet = set === undefined ? undefined : set.trim() ? await setOf(set) : null;
      const fields = {
        ...(tagSet !== undefined ? { tag_set: tagSet } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(color ? { color: color } : {}),
      };
      const old = graph.tagByName(tag);
      let id = old?.id;
      if (id) await ops.updateTag(id, { ...fields, ...(rename !== undefined ? { name: rename } : {}) });
      else id = await ops.createTag({ name: rename ?? tag, ...fields });
      const t = graph.tags.get(id);
      const inSet = t.tag_set ? ` in "${graph.tagSets.get(t.tag_set)?.name}"` : "";
      return `${old ? "Changed" : "Made"} tag "${t.name}"${inSet}${t.description ? `: ${t.description}` : ""}`;
    },
  });
  ctx.mcp.registerTool({
    name: "history",
    description:
      "A node's last 20 changes, newest first: what changed, what it was, and whether the user or an AI did it. " +
      'Without `node`, the latest changes across the whole map (e.g. to review your own: `by: "ai"`, `since: ' +
      '"2h"`), each with its node.',
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id (none: the whole map)"),
        since: { type: "string", description: "Only changes after this: a time (ISO), or ago like 30m, 2h, 1d" },
        by: { type: "string", enum: ["you", "ai"], description: "Only the user's changes, or only AI's" },
        limit: { type: "number", description: "At most this many (default 50, at most 200; a node keeps 20)" },
      },
    },
    handler: async ({ node, since, by, limit }) => {
      if (node) {
        const id = await resolve(ctx, node);
        const changes = await ctx.tables.rpc("history", { node_id: id, max_changes: 20 });
        const after = since ? sinceTime(since) : "";
        return changes.filter((c) => (!by || c.actor === by) && c.at > after).map(describeChange);
      }
      const changes = await ctx.tables.rpc("recent", {
        since: since ? sinceTime(since) : null,
        who: by ?? null,
        max_changes: Math.max(1, Math.min(limit ?? 50, 200)),
      });
      return changes.map((c) => `${describeChange(c)} · on "${c.node_text ?? "(deleted)"}" (#${shortId(c.node)})`);
    },
  });
  writeTool({
    name: "add",
    description:
      "Add children to a group: new nodes from `texts` (one node per concept, e.g. one per paragraph), or " +
      "existing nodes (`node`, or several: `nodes`) so they also appear in this group. A text can be `{ text, " +
      "children }` to make a " +
      "node with nodes inside it, a whole tree in one call. Search for an existing node before creating one. " +
      `More than ${MANY} new nodes at once (counting those inside) become a proposal for the user.`,
    inputSchema: {
      type: "object",
      properties: {
        parent: nodeArg("The group (parent node id)"),
        texts: {
          type: "array",
          items: {
            anyOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  text: { type: "string" },
                  children: { type: "array", description: "New nodes inside it, the same way", items: {} },
                },
                required: ["text"],
              },
            ],
          },
          description: "New nodes, in order: texts, or { text, children } for a node with nodes inside",
        },
        node: nodeArg("An existing node to add instead"),
        nodes: { type: "array", items: { type: "string" }, description: "Existing nodes to add instead, in order" },
        ...placeArgs,
      },
      required: ["parent"],
    },
    handler: async (args) => {
      const full = {
        ...args,
        parent: await resolve(ctx, args.parent),
        node: args.node ? await resolve(ctx, args.node) : undefined,
        nodes: args.nodes?.length ? await resolveList(ctx, args.nodes) : undefined,
        after: args.after ? await resolve(ctx, args.after) : undefined,
      };
      const count = full.node || full.nodes ? 0 : countNew(full.texts ?? []);
      if (count > MANY) {
        const title = await titles(ctx, [full.parent]);
        const text = `Add ${count} nodes to ${title(full.parent)}`;
        return propose(ctx, text, [{ tool: "add", args: { ...full }, title: text }]);
      }
      return CHANGES.add(ctx, full);
    },
  });
  writeTool({
    name: "prototype",
    description:
      "Make a prototype: a node with a live HTML page, a UI suggestion. With `from`, develop one: a new node with " +
      "its page changed by `edits` (or a whole new `html`; neither: a copy to branch from), next to it and connected " +
      'by a "developed from" edge; the old one stays as it is. Without `from`, a new idea with no connection: give ' +
      `\`html\`, and \`parent\` for the node it is about (none: the "${PROTOTYPES_GROUP}" group). Returns a Markdown ` +
      "`link`: write it in your reply and it shows there live.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short: the node's text" },
        html: { type: "string", description: "The whole page or a fragment, CSS and JavaScript inline" },
        edits: {
          type: "array",
          description: "With `from`: changes to its page, in turn; each `find` must match exactly once",
          items: {
            type: "object",
            properties: { find: { type: "string" }, replace: { type: "string" } },
            required: ["find", "replace"],
          },
        },
        from: nodeArg("The prototype this develops"),
        parent: nodeArg("The group to put it in (default: next to `from`)"),
      },
      required: ["title"],
    },
    handler: async ({ title, html, edits, from, parent }) => {
      if (html !== undefined && edits) throw new Error("Give `html` or `edits`, not both");
      const origin = from ? await resolve(ctx, from) : undefined;
      const [page] = origin ? await ctx.tables.select(TABLES.pages, { node: origin }) : [];
      if (origin && !page) throw new Error(`#${shortId(origin)} is not a prototype`);
      if (!page && (edits || html === undefined)) throw new Error("A new prototype needs `html`");
      const made = checkPage(html ?? applyEdits(page.html, edits ?? []));
      const asked = parent ? await resolve(ctx, parent) : undefined;
      const { graph, ops } = await slice(ctx, [...(origin ? [origin] : []), ...(asked ? [asked] : [])]);
      const beside = origin ? graph.incoming(origin, "group")[0]?.data.from : undefined;
      const group = asked ?? beside ?? (await prototypesGroup(ctx, ops));
      applyBundle(graph, await load.get([group]));
      applyBundle(graph, await load.level([group], 0, 1000));
      const id = await ops.createNode(title);
      await ops.addChild(group, id, group === beside ? position(graph, group, { after: origin }) : undefined);
      await ctx.tables.insert(TABLES.pages, { node: id, html: made });
      if (origin) await connect(edgeSource(ctx), { from: id, to: origin, type: DEVELOPED_FROM, newType: true });
      return { ...brief(graph, id), link: prototypeLink(title, id) };
    },
  });
  ctx.mcp.registerTool({
    name: "prototype_page",
    description: "Read a prototype's HTML page, to change it with concepts__prototype `edits`.",
    inputSchema: { type: "object", properties: { node: nodeArg("The prototype") }, required: ["node"] },
    handler: async ({ node }) => {
      const id = await resolve(ctx, node);
      const [page] = await ctx.tables.select(TABLES.pages, { node: id });
      if (!page) throw new Error(`#${shortId(id)} is not a prototype`);
      return { html: page.html };
    },
  });
  ctx.mcp.registerTool({
    name: "image",
    description:
      "Look at a node's picture: it comes back as an image you can see, with its caption. Outlines and search mark " +
      "the nodes that have one (`picture`).",
    inputSchema: { type: "object", properties: { node: nodeArg("Node id") }, required: ["node"] },
    handler: async ({ node }) => {
      const id = await resolve(ctx, node);
      const [row] = await ctx.tables.select(TABLES.images, { node: id });
      if (!row) throw new Error(`#${shortId(id)} has no picture`);
      const { data, mimeType } = await ctx.storage.download(row.path);
      const type = imageType(Buffer.from(data.slice(0, 32), "base64")) ?? mimeType;
      const text = row.caption
        ? `Caption: ${row.caption}`
        : "No caption yet. If you can say what it shows, write it with concepts__set_image.";
      return { image: { data, mimeType: type }, text };
    },
  });
  writeTool({
    name: "set_image",
    description:
      "Give a node a picture from a file on the PC (`path`), or with `caption` alone change what its picture says " +
      "it shows. A node has one picture: to change one that is there, say `replace: true`.",
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id"),
        path: { type: "string", description: "Absolute path of a PNG, JPEG, WebP or GIF, at most 3.5 MB" },
        caption: { type: "string", description: "What it shows, in words; search and outlines find it by this" },
        replace: { type: "boolean", description: "Replace the picture the node has" },
      },
      required: ["node"],
    },
    handler: async ({ node, path, caption, replace }) => {
      const id = await resolve(ctx, node);
      const [old] = await ctx.tables.select(TABLES.images, { node: id });
      const said = caption === undefined ? {} : { caption: caption.trim() };
      if (path === undefined) {
        if (caption === undefined) throw new Error("Give `path`, or `caption`");
        if (!old) throw new Error(`#${shortId(id)} has no picture`);
        await ctx.tables.update(TABLES.images, { id: old.id }, said);
      } else {
        if (old && !replace) throw new Error(`#${shortId(id)} already has a picture; say replace: true to change it`);
        if (!isAbsolute(path)) throw new Error("`path` must be absolute");
        if ((await stat(path)).size > MAX_ATTACHED_BYTES) throw new Error("That file is over 3.5 MB");
        // By its bytes, so this can't copy anything but a picture off the PC, whatever a file is called.
        const bytes = await readFile(path);
        const type = imageType(bytes);
        if (!type) throw new Error("That file isn't a PNG, JPEG, WebP or GIF");
        const saved = imagePath(uuid(), type);
        await ctx.storage.upload(saved, bytes.toString("base64"), type);
        const row = { path: saved, width: null, height: null, caption: "", ...said };
        try {
          if (old) await ctx.tables.update(TABLES.images, { id: old.id }, row);
          else await ctx.tables.insert(TABLES.images, { node: id, ...row });
        } catch (e) {
          await ctx.storage.remove([saved]).catch(() => {});
          throw e;
        }
        if (old) await ctx.storage.remove([old.path]).catch(() => {});
      }
      touch([id]);
      const { graph } = await slice(ctx, [id]);
      return brief(graph, id);
    },
  });
  writeTool({
    name: "create_view",
    description:
      "Create a new root node and show it in the user's views list, or make a view of an existing `node`. A view " +
      "remembers how things look below its root (open groups, layouts); a root can have several views.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        node: nodeArg("Existing node to make a view of instead"),
        name: { type: "string", description: "The view's own name (default: the root's title)" },
      },
      required: ["text"],
    },
    handler: async ({ text, node, name }) => {
      const id = node ? await resolve(ctx, node) : undefined;
      const { graph, ops } = await slice(ctx, id ? [id] : []);
      const root = id ?? (await ops.createNode(text));
      await ops.addView(root, name);
      return brief(graph, root);
    },
  });
  writeTool({
    name: "update",
    description:
      "Change a node's text, whether the order of its children matters (`unordered: true` for e.g. " +
      "ingredients, not steps), or its own colour (`color`, shown wherever it is; `none` takes it off). Only " +
      "colour a node when the user asks: say what a colour would say with a tag instead.",
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id"),
        text: { type: "string" },
        unordered: { type: "boolean", description: "The order of its children carries no meaning" },
        color: { type: "string", enum: [...TAG_COLORS, "none"], description: "Its colour; none: the default" },
      },
      required: ["node"],
    },
    handler: async ({ node, text, unordered, color }) => {
      if (color && color !== "none" && !TAG_COLORS.includes(color)) {
        throw new Error(`No color "${color}": use one of ${TAG_COLORS.join(", ")} or none`);
      }
      const id = await resolve(ctx, node);
      const { graph, ops } = await slice(ctx, [id]);
      await ops.updateNode(id, {
        ...(text !== undefined ? { text } : {}),
        ...(unordered !== undefined ? { unordered } : {}),
        ...(color ? { color: color === "none" ? null : color } : {}),
      });
      return brief(graph, id);
    },
  });
  writeTool({
    name: "summary",
    description:
      "Write (or with `remove`, delete) a node's summary: a short version of what its children (or its own long " +
      "text) say, with nothing that isn't there. Worth it once the text inside is large (about 300 words). " +
      "Read the node's children first; a summary goes out of date when anything inside changes.",
    inputSchema: {
      type: "object",
      properties: { node: nodeArg("Node id"), text: { type: "string" }, remove: { type: "boolean" } },
      required: ["node"],
    },
    handler: async ({ node, text, remove }) => {
      const id = await resolve(ctx, node);
      const { graph, ops } = await slice(ctx, [id]);
      if (remove) await ops.removeSummary(id);
      else if (text?.trim()) await ops.setSummary(id, text.trim());
      else throw new Error("Give the summary's `text`, or `remove: true`");
      return brief(graph, id);
    },
  });
  writeTool({
    name: "connect",
    description:
      "Add edges from one node to another, each with a `type` from concepts__types (by name or id) and optional " +
      "free text in `label` (e.g. type 'causes', label 'sometimes'). A type that doesn't exist yet is made only " +
      "with `newType: true`. An edge holds wherever the two nodes are; give `in` (a group both are children of) " +
      "for one that holds only inside that group. There is one edge per pair, type and place: connecting it " +
      "again changes its label (no `label` takes it off). `newIn` moves an edge (the one from `from` to `to`, " +
      "of `type` and in `in` if given) to hold only in that group, or `everywhere`. `remove` deletes the edges " +
      "from `from` to `to` (only those of `type`, or only in `in`, if given). Many at once: `edges`, a list of " +
      "{ from, to, type, label, in, newIn }; what is given beside it goes for those that don't give their own. " +
      "`retype` gives edges of `type` that type instead: all of them, those between the children of `in`, or " +
      `those of the pairs given; more than ${MANY} become a proposal. ` +
      "`preview: true` says what would happen without doing it. The result says for each edge what was done.",
    inputSchema: {
      type: "object",
      properties: {
        from: nodeArg("Node id"),
        to: nodeArg("Node id"),
        type: { type: "string", description: "Edge type name or id" },
        label: { type: "string" },
        in: nodeArg("Only inside this group (parent node id)"),
        newIn: nodeArg("Move the edge to hold only in this group, or `everywhere`"),
        retype: { type: "string", description: "Give the edges of `type` this type instead (name or id)" },
        edges: {
          type: "array",
          description: `Up to ${MAX_EDGES} edges, instead of \`from\` and \`to\``,
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              type: { type: "string" },
              label: { type: "string" },
              in: { type: "string" },
              newIn: { type: "string" },
            },
            required: ["from", "to"],
          },
        },
        newType: { type: "boolean", description: "Make `type` as a new edge type" },
        remove: { type: "boolean" },
        preview: { type: "boolean", description: "Only say what would be done" },
      },
    },
    handler: (args) => connect(edgeSource(ctx), args),
  });
  ctx.mcp.registerTool({
    name: "edges",
    description:
      "Every edge in a group, to see its graph at once: those only for this group, those between its children " +
      `that hold everywhere, and those from its children to nodes outside it. ${EDGE_PAGE} children at a time.`,
    inputSchema: {
      type: "object",
      properties: {
        group: nodeArg("The group (parent node id)"),
        offset: { type: "number", description: "Children to skip (default 0)" },
      },
      required: ["group"],
    },
    handler: async ({ group, offset }) => groupEdges(load, await resolve(ctx, group), Math.max(0, offset ?? 0)),
  });
  ctx.mcp.registerTool({
    name: "check",
    description:
      "Look through a group for what might be wrong, to check your work: cycles of the edge types in `acyclic` " +
      "(types that go one way, like 'blocks'), edges both ways or twice, edges without a type, children with the " +
      "same title, outdated or missing summaries. It only reports; whether something is wrong is yours to judge. " +
      `The first ${CHECK_PAGE} children.`,
    inputSchema: {
      type: "object",
      properties: {
        group: nodeArg("The group (parent node id)"),
        acyclic: { type: "array", items: { type: "string" }, description: "Edge types that must not go in a circle" },
      },
      required: ["group"],
    },
    handler: async ({ group, acyclic }) =>
      checkGroup(load, await resolve(ctx, group), await edgeTypes(ctx), acyclic ?? []),
  });
  ctx.mcp.registerTool({
    name: "follow",
    description:
      "Follow edges from a node step by step (e.g. everything that blocks it: type 'blocks', direction 'in'), as " +
      "a tree, then everything reached in the edges' order: each node before the nodes its edges point to. " +
      `At most ${FOLLOW_MAX} nodes.`,
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id"),
        type: { type: "string", description: "Only edges of this type (name or id; default: all)" },
        direction: {
          type: "string",
          enum: ["out", "in", "both"],
          description: "out: along the edges (default); in: against them",
        },
        depth: { type: "number", description: "Steps at most (default 5, at most 10)" },
      },
      required: ["node"],
    },
    handler: async ({ node, type, direction, depth }) => {
      const types = await edgeTypes(ctx);
      const typeId = type ? findType(types, type)?.id : undefined;
      if (type && !typeId) {
        throw new Error(`No edge type "${type}" (there are: ${types.map((t) => t.text).join(", ")})`);
      }
      return follow(load, await resolve(ctx, node), types, { type: typeId, direction, depth });
    },
  });
  writeTool({
    name: "move",
    description:
      "Reorder a child inside its group, or move it into another group (`to`; its edges only for the old group " +
      "are dropped). `children` moves several, kept together in that order. `order` puts all of a group's " +
      "children in a new order at once: it must list every child. Moving to another group becomes a proposal " +
      "for the user (one for all the `children`).",
    inputSchema: {
      type: "object",
      properties: {
        parent: nodeArg("Current group"),
        child: nodeArg("Child node id"),
        children: { type: "array", items: { type: "string" }, description: "Several children instead, in order" },
        order: { type: "array", items: { type: "string" }, description: "Every child of `parent`, in a new order" },
        to: nodeArg("New group (default: same)"),
        ...placeArgs,
      },
      required: ["parent"],
    },
    handler: async (args) => {
      const parent = await resolve(ctx, args.parent);
      if ([args.child, args.children?.length, args.order?.length].filter(Boolean).length !== 1) {
        throw new Error("Give one of `child`, `children` or `order`");
      }
      if (args.order?.length) {
        const order = await resolveList(ctx, args.order);
        const { graph, ops } = await slice(ctx, [parent]);
        applyBundle(graph, await loader(ctx).level([parent], 0, 1000));
        await ops.reorder(parent, order);
        return outline(graph, parent, { expanded: (id) => id === parent });
      }
      const children = args.child ? [await resolve(ctx, args.child)] : await resolveList(ctx, args.children);
      const to = args.to ? await resolve(ctx, args.to) : undefined;
      const after = args.after ? await resolve(ctx, args.after) : undefined;
      // Each after the one before it, so they stay together in the order given.
      const moves = children.map((child, i) =>
        i === 0 ? { parent, child, to, after, first: args.first } : { parent, child, to, after: children[i - 1] },
      );
      if (to && to !== parent) {
        const title = await titles(ctx, [...children, parent, to]);
        const changes = moves.map((m) => ({
          tool: "move",
          args: { ...m },
          title: `Move ${title(m.child)} from ${title(parent)} to ${title(to)}`,
        }));
        const many = `Move ${children.length} nodes from ${title(parent)} to ${title(to)}`;
        const text = children.length > 1 ? many : changes[0].title;
        return propose(ctx, text, changes);
      }
      let result;
      for (const m of moves) result = await CHANGES.move(ctx, m);
      return result;
    },
  });
  writeTool({
    name: "remove",
    description:
      "Take a node out of one group (`parent`), keeping it elsewhere; without `parent`, delete the node everywhere " +
      "(its children stay, maybe in no group). `nodes` does it for several, as one proposal. Either becomes a " +
      "proposal for the user.",
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id"),
        nodes: { type: "array", items: { type: "string" }, description: "Several nodes instead" },
        parent: nodeArg("Only remove it from this group"),
      },
    },
    handler: async (args) => {
      if (!args.node === !args.nodes?.length) throw new Error("Give `node` or `nodes`");
      const nodes = args.node ? [await resolve(ctx, args.node)] : await resolveList(ctx, args.nodes);
      const parent = args.parent ? await resolve(ctx, args.parent) : undefined;
      const title = await titles(ctx, [...nodes, ...(parent ? [parent] : [])]);
      const what = (n) => (parent ? `Take ${title(n)} out of ${title(parent)}` : `Delete ${title(n)} everywhere`);
      const changes = nodes.map((node) => ({ tool: "remove", args: { node, parent }, title: what(node) }));
      const text =
        nodes.length === 1
          ? changes[0].title
          : parent
            ? `Take ${nodes.length} nodes out of ${title(parent)}`
            : `Delete ${nodes.length} nodes everywhere`;
      return propose(ctx, text, changes);
    },
  });
  ctx.mcp.registerTool({
    name: "mention",
    description:
      "Link your thread to nodes it read, discussed or relied on without changing them, so the user finds the " +
      "thread from the nodes (nodes you change are linked by themselves). `note`: one line on what the thread " +
      "has about them, e.g. 'decided to drop the cache; reasons at the end'. Linking again replaces the note.",
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id"),
        nodes: { type: "array", items: { type: "string" }, description: "Several nodes instead (at most 100)" },
        note: { type: "string", description: "What the thread has about them, in one line" },
        thread: THREAD_ARG,
      },
    },
    handler: async ({ node, nodes, note, thread }, call) => {
      const who = await links.actor(call, thread);
      if (!who) throw new Error("Give `thread`: your Claude thread's id, or your pipeline task's link");
      const names = [...(node ? [node] : []), ...(nodes ?? [])];
      if (!names.length) throw new Error("Give `node` or `nodes`");
      if (names.length > 100) throw new Error("At most 100 nodes at once");
      const ids = [...new Set(await resolveList(ctx, names))];
      const count = await links.mark(who, ids, "mentioned", note?.trim() || undefined);
      const title = await titles(ctx, ids);
      const missing = count < ids.length ? ` (${ids.length - count} not found)` : "";
      return `Linked ${who.title ? `"${who.title}"` : "your thread"} to ${ids.map(title).join(", ")}${missing}`;
    },
  });
  ctx.mcp.registerTool({
    name: "threads",
    description:
      "The threads (Claude threads, T3 threads and AI chats of the old layr, pipeline tasks and proposals) that changed, mentioned or were linked to " +
      "a node, latest first, with their notes and links: earlier work, discussions and planned work about it. " +
      "Without `node`, the nodes a thread changed, mentioned or was linked to (`thread`: yours, or another's).",
    inputSchema: {
      type: "object",
      properties: {
        node: nodeArg("Node id"),
        thread: { type: "string", description: "A Claude thread's id, or a layr link (a pipeline task's)" },
      },
    },
    handler: async ({ node, thread }, call) => {
      if (node) {
        const rows = await ctx.tables.select(TABLES.threads, { node: await resolve(ctx, node) });
        rows.sort((a, b) => b.at.localeCompare(a.at));
        return rows.length ? rows.map(describeThread) : "No thread has changed, mentioned or been linked to it yet";
      }
      const who = await links.actor(call, thread);
      if (!who) throw new Error("Give `node`, or `thread`");
      const rows = await ctx.tables.rpc("thread_nodes", { thread_key: who.thread, max_nodes: 100 });
      if (!rows.length) return `${who.title ? `"${who.title}"` : "That thread"} has no nodes linked yet`;
      return rows.map((r) => {
        const did = [r.linked_at ? "linked" : "", r.changed_at ? "changed" : "", r.mentioned_at ? "mentioned" : ""]
          .filter(Boolean)
          .join(", ");
        return `${r.text || "(empty)"} (#${shortId(r.node)}): ${did}${r.note ? `: ${r.note}` : ""}`;
      });
    },
  });
  // ---------- commands for panels ----------
  /** Nodes matching `query`, for pickers (e.g. mentioning a node in an AI chat). */
  ctx.commands.register("concepts.nodes", async ({ query } = {}) => {
    if (!query?.trim()) return [];
    return (await search(ctx, query, 40)).map((h) => ({
      id: h.id,
      label: firstLine(h.text) || "(empty)",
      in: h.path.slice(-2).map((p) => p.text || "(empty)"),
    }));
  });
  /**
   * The nodes with this tag (by name, any case), for other plugins (the orchestrator watches the ideas you approved).
   * None when there is no such tag. `under`: only those inside that node, at any depth (the orchestrator
   * leaves out the approved ideas of projects that don't wake it).
   */
  ctx.commands.register("concepts.tagged", async ({ tag, under }) => {
    const graph = await loadTags(ctx, new Graph());
    const found = graph.tags.get(tag?.trim()) ?? graph.tagByName(tag ?? "");
    if (!found) return [];
    const args = { tag_ids: [found.id], q: null, under: under ?? null, max_hits: 200 };
    const hits = await ctx.tables.rpc("tagged", args);
    return hits.map((h) => ({
      id: h.id,
      label: firstLine(h.text) || "(empty)",
      in: h.path.map((p) => p.text || "(empty)"),
    }));
  });
  /**
   * Another plugin's item linked to nodes (`thread`: its layr link, e.g. a pipeline task made from a node), so they
   * list it among their threads. `nodes` may be short ids, as outlines show them (an AI proposing a task from a node
   * passes those). `note`: one line the nodes show with the link, as a mention's (a task landed on your word).
   * Returns how many nodes it linked, and their full ids.
   */
  ctx.commands.register("concepts.link", async ({ thread, title, nodes, note }) => {
    if (!thread?.startsWith("layr://")) throw new Error("Give `thread`: a layr link, like layr://pipeline/task/12");
    if (!nodes?.length) return { linked: 0, nodes: [] };
    const ids = await resolveList(ctx, nodes);
    const who = { thread, href: thread, title: title ?? null };
    const linked = await links.mark(who, ids, "linked");
    // A note (a pipeline task landed on your word) shows with the link, as a mention's does.
    if (note?.trim()) await links.mark(who, ids, "mentioned", note.trim());
    return { linked, nodes: ids };
  });
  /**
   * The rows of `thread` under another link or title (`to`: `{ thread, title }`), or deleted (`to` null): for a
   * plugin whose item was renamed, deleted or became another (a pipeline task forgotten while its T3 thread stays).
   */
  ctx.commands.register("concepts.relink", ({ thread, to }) => {
    if (!thread?.startsWith("layr://") || (to && !to.thread?.startsWith("layr://"))) {
      throw new Error("Give `thread` and `to.thread` as layr links");
    }
    return links.relink(thread, to);
  });
  /** The nodes linked to items of another plugin, by link: `{ prefix: "layr://pipeline/task/" }` (migration 0015). */
  ctx.commands.register("concepts.linkedNodes", async ({ prefix }) => {
    if (!prefix?.startsWith("layr://")) throw new Error("Give a layr link prefix, like layr://pipeline/task/");
    const rows = await ctx.tables.rpc("linked_nodes", { prefix });
    const result = {};
    for (const row of rows) (result[row.thread] ??= []).push({ id: row.node, text: row.text });
    return result;
  });
  /**
   * The nodes one thread changed, mentioned or was linked to, latest first: `thread` is a T3 thread's id or a layr
   * link (a T3 thread in the pipeline is found under its task).
   */
  ctx.commands.register("concepts.threadNodes", async ({ thread }) => {
    const who = await links.actor({}, thread);
    if (!who) return [];
    const rows = await ctx.tables.rpc("thread_nodes", { thread_key: who.thread, max_nodes: 100 });
    return rows.map((r) => ({
      id: r.node,
      text: r.text,
      did: r.changed_at ? "changed" : r.linked_at ? "linked" : "mentioned",
      note: r.note,
    }));
  });
  /**
   * A proposal the user accepted: apply its changes, then forget it. Stopped by an error, accepting it again
   * continues where it stopped; `skip` passes over the change that failed.
   */
  ctx.commands.register("concepts.applyProposal", async ({ id, skip }) => {
    await applyProposal(
      ctx.tables,
      id,
      // Still the change of the thread that proposed it.
      (change) => links.runAs(change.by, () => runChange(ctx, change)),
      !!skip,
    );
    return { ok: true };
  });
  /** Write a node's summary with Claude (haiku), from what is inside it. */
  ctx.commands.register("concepts.summarize", async ({ node }) => {
    if (!(await ctx.ai.available())) throw new Error("Claude is not available on the PC");
    const id = await resolve(ctx, node);
    const text = await readOutline(load, id, MAX_BUDGET);
    const result = await ctx.ai.run({
      model: "haiku",
      system:
        "You write summaries for a concept map. A summary is a short version of what the given outline says " +
        "under its first line, so a reader can decide whether to read it: one to four sentences, in the " +
        "outline's language, with nothing that isn't in it. No ids, no Markdown headings, no preamble.",
      prompt: text,
    });
    const summary = result.text.trim();
    if (!summary) throw new Error("Claude wrote nothing");
    const { ops } = await slice(ctx, [id]);
    await ops.setSummary(id, summary);
    return { summary };
  });
  ctx.log("concepts backend ready");
}
/** Search; `under` only inside that node (migration 0013). */
const search = (ctx, query, max, under) =>
  ctx.tables.rpc("search", { q: query, max_hits: max, ...(under ? { under } : {}) });
/** Several nodes the AI gave, as full ids. */
const resolveList = (ctx, names) => Promise.all(names.map((n) => resolve(ctx, n)));
/** A time from `since`: an ISO time, or ago, like 30m, 2h or 1d. */
function sinceTime(since) {
  const ago = /^(\d+(?:\.\d+)?)\s*(m|min|h|d)$/i.exec(since.trim());
  const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 };
  if (ago) {
    const ms = Number(ago[1]) * unit[ago[2].toLowerCase()];
    return new Date(Date.now() - ms).toISOString();
  }
  const time = Date.parse(since);
  if (Number.isNaN(time)) throw new Error(`"${since}" is not a time: give an ISO time, or ago like 30m, 2h, 1d`);
  return new Date(time).toISOString();
}
/** A proposal for concepts_views: what it does, and how far it got if it was accepted and stopped. */
function describeProposal(p) {
  const done = p.changes.filter((c) => c.done || c.skipped).length;
  const failed = p.changes.find((c) => c.error && !c.skipped);
  return {
    id: shortId(p.id),
    title: p.title,
    ...(p.changes.length > 1 ? { changes: p.changes.length } : {}),
    ...(done ? { done } : {}),
    ...(failed ? { stopped: failed.error } : {}),
  };
}
const shortText = (text) => {
  const line = firstLine(text);
  return line.length > 200 ? `${line.slice(0, 199)}…` : line || "(empty)";
};
/** A history entry as one line. */
function describeChange(c) {
  const who = c.actor === "ai" ? "AI" : "you";
  const when = `${c.at.slice(0, 16).replace("T", " ")} UTC`;
  const other = c.other_text !== null ? ` "${c.other_text || "(empty)"}"` : "";
  const was = c.was ? ` (was: ${c.was.length > 300 ? `${c.was.slice(0, 299)}…` : c.was})` : "";
  return `${when} ${who}: ${c.what}${other}${was}`;
}
