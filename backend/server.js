// The concepts backend: an MCP server on stdio (docs/PLUGINS.md › Backends) with the concept map's tools, ported from
// layr_code's plugins/concepts/backend. It works on the user's Supabase tables as the signed-in user, with the session
// the hub gives (layr__supabase_session, docs/ARCHITECTURE.md › Supabase for plugins).
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSupabase } from "../shared/supabase.js";
import { COMMAND_TOOLS, createContext } from "./context.js";
import { errorMessage, Hub, log } from "./hub.js";
import { activate } from "./tools.js";

/** Tools that only read: everything else may have changed the map, so the panels hear `concepts:changed`. */
const READS = new Set([
  "guide",
  "read",
  "children",
  "views",
  "search",
  "neighbors",
  "types",
  "tags",
  "history",
  "prototype_page",
  "image",
  "edges",
  "check",
  "follow",
  "threads",
  "project",
  "nodes",
  "tagged",
  "linked_nodes",
  "thread_nodes",
  "project_map",
  "needs",
  "filed_ideas",
  "status_nodes",
]);

/** A tool's result as MCP content: text (JSON for values), or a picture with text beside it (layr_code's toolContent). */
export function toolContent(result) {
  if (result && typeof result === "object" && result.image && typeof result.image.data === "string") {
    const image = { type: "image", data: result.image.data, mimeType: result.image.mimeType };
    return result.text ? [image, { type: "text", text: result.text }] : [image];
  }
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
  return [{ type: "text", text }];
}

/**
 * Everything the server offers, from `activate`: its tools, the commands as tools, and `guide`. `hub` and
 * `supabase` can be fakes (tests). `onWrite(tool)` runs after a tool that may have changed the map.
 */
export function buildTools({ hub, supabase, onWrite = () => {} }) {
  const { ctx, tools, commands, instructions } = createContext({ hub, supabase });
  activate(ctx);
  const all = new Map();
  all.set("guide", {
    name: "guide",
    description:
      "How to use the concept map's tools (concepts__*): what nodes, groups, summaries, edges, tags, prototypes and " +
      "proposals are, and the rules for changing the user's map. Read it once before using the other tools.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => instructions(),
  });
  for (const tool of tools.values()) all.set(tool.name, tool);
  for (const [id, def] of Object.entries(COMMAND_TOOLS)) {
    const handler = commands.get(id);
    if (!handler) continue;
    all.set(def.tool, { name: def.tool, description: def.description, inputSchema: def.inputSchema, handler });
  }
  const call = async (name, args = {}) => {
    const tool = all.get(name);
    if (!tool) throw new Error(`No tool ${name}`);
    const result = await tool.handler(args, {});
    if (!READS.has(name)) onWrite(name);
    return result;
  };
  return { tools: all, call, instructions };
}

async function main() {
  const hub = new Hub({ url: process.env.LAYR_HUB_URL, token: process.env.LAYR_HUB_TOKEN });
  // `x-layr-actor: ai`: the history tells these changes from the user's (supabase/migrations/lf_0003_concepts_ai_actor.sql).
  const supabase = createSupabase({
    session: () => hub.call("layr__supabase_session", {}),
    headers: { "x-layr-actor": "ai" },
  });
  const { tools, call, instructions } = buildTools({
    hub,
    supabase,
    onWrite: (tool) => hub.emit("concepts:changed", { tool }),
  });
  const server = new Server(
    { name: "concepts", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: instructions() },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return { content: toolContent(await call(request.params.name, request.params.arguments ?? {})) };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: errorMessage(error) }] };
    }
  });
  await server.connect(new StdioServerTransport());
  log(`ready: ${tools.size} tools`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log("failed to start:", errorMessage(error));
    process.exit(1);
  });
}
