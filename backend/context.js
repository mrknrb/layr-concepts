// What layr_code's plugin host gave the concepts backend (`PluginContext`), made from the new layr's parts, so the code
// ported from there (tools.js, project.js, threads.js) runs unchanged: tables and storage in the user's Supabase
// (shared/supabase.js), settings in the plugin's own store (the hub), MCP tools collected for the server, and
// commands, which other plugins and the panel reach here as tools too (COMMAND_TOOLS).
import { errorMessage, log } from "./hub.js";

const str = (description) => ({ type: "string", description });
const strings = (description) => ({ type: "array", items: { type: "string" }, description });
const object = (properties, required = []) => ({ type: "object", properties, required });

/**
 * The commands layr_code's other plugins (the pipeline, the chat) and the panel called, as tools: name, what it does
 * (for whoever calls it: other plugins, the Concepts panel), and its arguments. Agents see them too.
 */
export const COMMAND_TOOLS = {
  "concepts.nodes": {
    tool: "nodes",
    description: "For pickers (plugins, the panel): nodes matching `query`, `[{id, label, in}]` (`in`: the last two groups).",
    inputSchema: object({ query: str("Words in the node's text") }),
  },
  "concepts.tagged": {
    tool: "tagged",
    description: "For plugins: the nodes with this tag (by name), `[{id, label, in}]`; `under`: only inside that node.",
    inputSchema: object({ tag: str("The tag's name"), under: str("Only inside this node (full id)") }, ["tag"]),
  },
  "concepts.link": {
    tool: "link",
    description:
      "For plugins: link an item of theirs (`thread`: its layr link, e.g. layr://pipeline/task/12) to nodes, so the " +
      "nodes list it among their threads; `note`: one line shown with the link. Gives `{linked, nodes}`.",
    inputSchema: object(
      { thread: str("A layr link"), title: str("The item's title"), nodes: strings("Node ids"), note: str("One line") },
      ["thread", "nodes"],
    ),
  },
  "concepts.relink": {
    tool: "relink",
    description:
      "For plugins: move the rows of an item (`thread`, a layr link) to another link or title (`to: {thread, title}`), " +
      "or delete them (`to: null`).",
    inputSchema: object({ thread: str("A layr link"), to: { type: ["object", "null"] } }, ["thread"]),
  },
  "concepts.linkedNodes": {
    tool: "linked_nodes",
    description: "For plugins: the nodes linked to their items, by link prefix (layr://pipeline/task/): `{link: [{id, text}]}`.",
    inputSchema: object({ prefix: str("A layr link prefix") }, ["prefix"]),
  },
  "concepts.threadNodes": {
    tool: "thread_nodes",
    description: "For plugins: the nodes one thread changed, mentioned or was linked to, latest first.",
    inputSchema: object({ thread: str("A Claude thread's id or a layr link") }, ["thread"]),
  },
  "concepts.applyProposal": {
    tool: "apply_proposal",
    description:
      "For the Concepts panel (the user's Accept): make a proposal's changes, then forget it. Stopped by an error, " +
      "accepting again continues where it stopped; `skip` passes over the change that failed. Agents: concepts__decide.",
    inputSchema: object({ id: str("The proposal's full id"), skip: { type: "boolean" } }, ["id"]),
  },
  "concepts.projectMap": {
    tool: "project_map",
    description: "For plugins: a project node's sections and rules, as structured data (agents: concepts__project).",
    inputSchema: object({ node: str("The project node") }, ["node"]),
  },
  "concepts.setupProjectMap": {
    tool: "setup_project_map",
    description: "For plugins: give a project node the standard sections (Rules, Brainstorm, Features, Plan) it lacks.",
    inputSchema: object({ node: str("The project node") }, ["node"]),
  },
  "concepts.advanceStatus": {
    tool: "advance_status",
    description: "For the pipeline: move the Status of these nodes forward to `status` (never out of Dropped or Done).",
    inputSchema: object({ nodes: strings("Node ids"), status: str("Planned, In progress, Done…") }, ["nodes", "status"]),
  },
  "concepts.needs": {
    tool: "needs",
    description: "For the pipeline: per node, the nodes it needs (\"needs\" edges) with their Status.",
    inputSchema: object({ nodes: strings("Node ids") }, ["nodes"]),
  },
  "concepts.filedIdeas": {
    tool: "filed_ideas",
    description: "For the pipeline: what agents and scouts filed into a project's Features that waits for the user.",
    inputSchema: object({ node: str("The project node") }, ["node"]),
  },
  "concepts.statusNodes": {
    tool: "status_nodes",
    description: "For the pipeline: how many of a project's features have each Status, and the first `max` of them.",
    inputSchema: object({ node: str("The project node"), max: { type: "number" } }, ["node"]),
  },
  "concepts.addLessons": {
    tool: "add_lessons",
    description: "For the pipeline's retro: lessons as children of Plan › Lessons, tagged Idea (none twice).",
    inputSchema: object({ node: str("The project node"), lessons: strings("One sentence each") }, ["node", "lessons"]),
  },
  "concepts.dropNodes": {
    tool: "drop_nodes",
    description: "For the pipeline's Drop: Status Dropped on these nodes, and the reason as a \"Decision: …\" child.",
    inputSchema: object({ nodes: strings("Node ids"), reason: str("Why") }, ["nodes"]),
  },
  "concepts.summarize": {
    tool: "summarize",
    description:
      "For the Concepts panel: write a node's summary with Claude (haiku, through the claude plugin's ask) from what " +
      "is inside it, and save it. Gives `{summary}`. Agents write summaries themselves with concepts__summary.",
    inputSchema: object({ node: str("The node (full id)") }, ["node"]),
  },
};

/** The plugin's settings (Concepts settings in the panel), kept in its own store under this key. */
export const SETTINGS_KEY = "settings";

/**
 * A context for `activate(ctx)`. `supabase`: shared/supabase.js's client; `hub`: backend/hub.js (or a fake in tests).
 * Gives the context and what was registered on it: `tools` (MCP tools by name) and `commands` (by command id).
 */
export function createContext({ supabase, hub }) {
  const tools = new Map();
  const commands = new Map();
  let instructions = "";

  const ctx = {
    tables: supabase.tables,
    storage: supabase.storage,
    /**
     * layr_code kept the settings record `settings/global` in plugin_records; here they are the plugin's settings
     * (manifest `settings`, the shell's Settings page), or, where the core has none, its own store's `settings`.
     */
    data: {
      async get(collection, id) {
        if (collection !== "settings" || id !== "global") return null;
        const proposals = await hub.call("layr__settings_get", { id: "proposals" }).catch(() => undefined);
        if (typeof proposals === "boolean") return { data: { proposals } };
        const value = await hub.call("layr__data_get", { key: SETTINGS_KEY }).catch(() => null);
        return value && typeof value === "object" ? { data: value } : null;
      },
    },
    commands: {
      register(id, handler) {
        commands.set(id, handler);
      },
      /** Commands of this plugin run here; other plugins' (chat, pipeline in layr_code) aren't there: they fail. */
      async run(id, args) {
        const handler = commands.get(id);
        if (!handler) throw new Error(`No backend handles ${id}`);
        return handler(args ?? {});
      },
    },
    /** Core AI isn't a part of the new layr's core: one-shot answers come from the claude plugin's `ask` tool. */
    ai: {
      available: async () => {
        if (!hub.available) return false;
        const tools = await hub.toolNames().catch(() => []);
        return tools.includes("claude__ask");
      },
      run: async ({ model, system, prompt }) => {
        const answer = await hub.call("claude__ask", { prompt, ...(system ? { system } : {}), model: model ?? "haiku" });
        return { text: typeof answer === "string" ? answer : (answer?.text ?? "") };
      },
    },
    /** No T3 Code in the new layr: links to T3 threads from layr_code still read, without titles. */
    t3: {
      connected: async () => false,
      call: async () => {
        throw new Error("T3 Code is not connected");
      },
    },
    /** The claude plugin's threads, for thread links: their titles. */
    claude: {
      async threadTitle(id) {
        try {
          const status = await hub.call("claude__thread_status", { thread: id });
          return status?.thread?.title || null;
        } catch (error) {
          const message = errorMessage(error);
          if (/^No thread /.test(message)) throw new Error(`No Claude thread "${id}": \`thread\` is your own thread's id`);
          return null; // the claude plugin isn't there or can't be asked: no title
        }
      },
    },
    mcp: {
      setInstructions(text) {
        instructions = text;
      },
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
    },
    log,
  };

  return { ctx, tools, commands, instructions: () => instructions };
}
