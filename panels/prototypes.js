// The Prototypes panel (from layr_code's panels/prototypes.tsx): prototypes big, side by side or one at a time, the
// nodes chosen on the map (Open the prototype big, Compare side by side) or a `layr://concepts/prototype/<id>` link.
// "⇄ What it came from" adds what they were developed from. Reads the user's tables itself, as the concept map does.
import { DEVELOPED_FROM } from "../shared/prototype.js";
import { TABLES } from "../shared/rows.js";
import { createSupabase } from "../shared/supabase.js";
import { firstLine } from "../shared/graph.js";
import { h, icon } from "./dom.js";
import { nextZoom } from "./model.js";
import { cssReady, protoBoard } from "./proto.js";

await layr.ready;
await cssReady;
const tables =
  window.conceptsTestTables ??
  createSupabase({ session: () => layr.tools.run("supabase_session", {}, { plugin: "layr" }) }).tables;

const idsOf = (p) => [...new Set([...(p?.nodes ?? []), ...(p?.prototype ? [p.prototype] : [])].filter(Boolean))];
const S = {
  nodes: idsOf(layr.info.state).length ? idsOf(layr.info.state) : idsOf(layr.info.params),
  zoom: layr.info.state?.zoom ?? null,
  pages: undefined,
  origins: [],
  error: "",
};

/** The prototypes with these node ids, in this order; those gone or not prototypes are left out. */
async function loadPages(ids) {
  if (!ids.length) return [];
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

/** What the prototypes shown were developed from, when it isn't shown too. */
async function originsOf(ids) {
  if (!ids.length) return [];
  const edges = await tables.select(TABLES.edges, { from_node: ids });
  const relations = [...new Set(edges.flatMap((e) => (e.type ? [e.type] : [])))];
  if (!relations.length) return [];
  const types = await tables.select(TABLES.nodes, { id: relations });
  const developed = new Set(types.filter((t) => t.text.trim().toLowerCase() === DEVELOPED_FROM).map((t) => t.id));
  const found = edges.filter((e) => e.type && developed.has(e.type)).map((e) => e.to_node);
  return [...new Set(found)].filter((id) => !ids.includes(id));
}

const remember = () => void layr.panel.setState({ nodes: S.nodes, zoom: S.zoom }).catch(() => {});

async function load() {
  S.error = "";
  try {
    [S.pages, S.origins] = await Promise.all([loadPages(S.nodes), originsOf(S.nodes)]);
  } catch (error) {
    S.error = /not signed in/i.test(error.message)
      ? "Sign in under Settings › Account to see prototypes."
      : error.message;
  }
  render();
}

let board = null;
function render() {
  const shown = S.pages ?? [];
  void layr.panel.setTitle(shown.length ? shown.map((p) => p.title).join(" · ") : "Prototypes").catch(() => {});
  const zoom = S.zoom ?? 100;
  const setZoom = (z) => {
    S.zoom = z === 100 ? null : z;
    remember();
    board?.update({ zoom: S.zoom });
    render();
  };
  const bar = h(
    "div.layr-toolbar.proto-panel-bar",
    h("span.bar-title", shown.length > 1 ? `${shown.length} prototypes` : shown[0]?.title ?? "Prototypes"),
    h("span.layr-spacer"),
    S.origins.length > 0 &&
      h(
        "button.layr-button",
        {
          title: "Show what they were developed from, next to them",
          onclick: () => {
            S.nodes = [...S.origins, ...S.nodes];
            remember();
            board = null;
            void load();
          },
        },
        "⇄ What it came from",
      ),
    h("button.layr-button.ghost", { title: "Zoom the pages out", onclick: () => setZoom(nextZoom(zoom, -1)) }, "−"),
    h("button.layr-button.ghost", { title: "The pages' zoom (click: 100%)", onclick: () => setZoom(100) }, `${zoom}%`),
    h("button.layr-button.ghost", { title: "Zoom the pages in", onclick: () => setZoom(nextZoom(zoom, 1)) }, "+"),
    h(
      "button.layr-button.ghost.icon",
      { title: "Run them again", "aria-label": "Run them again", onclick: () => ((board = null), void load()) },
      icon("refresh"),
    ),
  );
  let body;
  if (S.error) body = h("div.layr-empty", h("p.layr-error", S.error));
  else if (S.pages === undefined) body = h("div.layr-empty", h("span.layr-spinner"), " Loading…");
  else if (!S.nodes.length) body = h("div.layr-empty", h("p", "No prototype chosen: open one from the concept map."));
  else if (!shown.length) body = h("div.layr-empty", h("p", "This prototype was deleted."));
  else {
    board ??= protoBoard({ pages: shown, fill: true, look: { zoom: S.zoom } });
    body = h("div.proto-panel-body", board);
  }
  document.getElementById("app").replaceChildren(bar, body);
}

layr.panel.onParams?.((params) => {
  const ids = idsOf(params);
  if (!ids.length) return;
  S.nodes = ids;
  S.pages = undefined;
  board = null;
  remember();
  void load();
});
render();
remember();
await load();
document.body.dataset.ready = "1";
