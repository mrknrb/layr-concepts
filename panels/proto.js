// Prototypes in a panel (from layr_code's packages/panel-ui/src/Prototype.tsx): pages next to each other or one at a
// time, each in its own locked-down iframe (shared/links.js), zoomed like a browser zooms, made taller or shorter by
// dragging their bottom edge (double-click: as tall as the page). The map folds a prototype's page out under its node
// (`protoEmbed`), the Prototypes panel shows them big (`protoBoard` with `fill`). Built once and updated in place
// (`el.update(look)`): rebuilding a frame would run its page again.
import { prototypeDocument } from "../shared/links.js";
import { h } from "./dom.js";
import { nextZoom, PROTO_HEIGHT } from "./model.js";

/** layr.css for prototype pages, so a page can look like the app (inline: the frame has no origin). */
let layrCss = "";
export const cssReady = fetch("/_layr/layr.css")
  .then((r) => (r.ok ? r.text() : ""))
  .then((text) => (layrCss = text))
  .catch(() => "");

/** The theme the shell gave this panel, as CSS variables, for the pages. */
function panelTheme() {
  const style = getComputedStyle(document.documentElement);
  const names = [
    "--bg",
    "--bg-2",
    "--bg-3",
    "--fg",
    "--fg-dim",
    "--border",
    "--accent",
    "--accent-fg",
    "--danger",
    "--radius",
    "--font",
    "--font-mono",
  ];
  const theme = Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]).filter(([, v]) => v));
  const mode = document.documentElement.getAttribute("data-theme");
  if (mode === "dark" || mode === "light") theme["color-scheme"] = mode;
  return theme;
}

/**
 * One page. No `allow-same-origin`: the page has no origin, so it can't reach this panel or layr. Zoom works as in a
 * browser: the frame is laid out bigger or smaller than its box and scaled to fit, so the page's percents and media
 * queries follow. `onHeight(height | null)` saves a dragged height (null: as tall as its page).
 */
export function protoFrame({ title, html, fill = false, onHeight }) {
  const frame = h("iframe.proto-frame", {
    sandbox: "allow-scripts allow-forms",
    title,
    srcdoc: prototypeDocument(html, panelTheme(), layrCss),
  });
  const box = h("div.proto-box", frame);
  const el = h("div.proto-page", box);
  let look = { zoom: null, height: null };
  let pageHeight = 320;
  let resizing = null;
  const draw = () => {
    const scale = (look.zoom ?? 100) / 100;
    frame.style.width = `${100 / scale}%`;
    frame.style.height = `${100 / scale}%`;
    frame.style.transform = scale === 1 ? "" : `scale(${scale})`;
    if (fill) return;
    const fitted = Math.min(PROTO_HEIGHT.fit, Math.max(PROTO_HEIGHT.least, Math.ceil(pageHeight * scale)));
    box.style.height = `${resizing ?? look.height ?? fitted}px`;
  };
  const onMessage = (event) => {
    if (!frame.isConnected) return void window.removeEventListener("message", onMessage);
    const asked = event.data?.layrPrototypeHeight;
    if (event.source !== frame.contentWindow || typeof asked !== "number") return;
    pageHeight = asked;
    draw();
  };
  window.addEventListener("message", onMessage);
  if (onHeight && !fill) {
    const grip = h("span.proto-grip", {
      title: "Drag to make it taller or shorter (double-click: as tall as its page)",
    });
    grip.addEventListener("dblclick", () => onHeight(null));
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // The window hears the moves (pointer capture loses them in layr's Windows web views); the frames take no
      // pointer meanwhile, so the page inside doesn't swallow them.
      document.body.classList.add("proto-resizing");
      const start = box.offsetHeight;
      const zoomed = box.getBoundingClientRect().height / start || 1;
      const from = e.clientY;
      grip.classList.add("resizing");
      const onMove = (ev) => {
        resizing = Math.min(
          PROTO_HEIGHT.max,
          Math.max(PROTO_HEIGHT.min, Math.round(start + (ev.clientY - from) / zoomed)),
        );
        draw();
      };
      const onDone = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onDone);
        window.removeEventListener("pointercancel", onDone);
        document.body.classList.remove("proto-resizing");
        grip.classList.remove("resizing");
        const r = resizing;
        if (r === null || r === start) {
          resizing = null;
          return draw();
        }
        look = { ...look, height: r };
        resizing = null;
        draw();
        onHeight(r);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onDone);
      window.addEventListener("pointercancel", onDone);
    });
    el.append(grip);
  }
  el.update = (next) => {
    look = { ...look, ...next };
    draw();
  };
  draw();
  return el;
}

/**
 * The pages side by side, or one alone (tabs when there are several). `fill`: as tall as the parent, else each as
 * tall as its page or as dragged. `look`: `{zoom, height}`.
 */
export function protoBoard({ pages, fill = false, look = {}, onHeight }) {
  let only = null;
  const frames = pages.map((page) => protoFrame({ title: page.title, html: page.html, fill, onHeight }));
  const columns = pages.map((page, i) =>
    h(
      "div.proto-column",
      { dataset: { page: page.id } },
      pages.length > 1 && h("div.proto-label", h("strong", page.title)),
      frames[i],
    ),
  );
  const tabs = h("div.proto-tabs");
  const draw = () => {
    tabs.replaceChildren(
      h("button", { class: only ? "" : "on", onclick: () => ((only = null), draw()) }, "Side by side"),
      ...pages.map((p) =>
        h("button", { class: only === p.id ? "on" : "", onclick: () => ((only = p.id), draw()) }, p.title),
      ),
    );
    // Hidden rather than removed, so what was clicked in a page stays when it comes back.
    columns.forEach((c, i) => {
      c.hidden = !!only && only !== pages[i].id;
      c.querySelector(".proto-label")?.toggleAttribute("hidden", !!only);
    });
  };
  draw();
  const el = h(
    "div.proto-board",
    { class: fill ? "fill" : "" },
    pages.length > 1 && tabs,
    h("div.proto-columns", columns),
  );
  el.update = (next) => frames.forEach((f) => f.update(next));
  el.update(look);
  return el;
}

/**
 * A prototype folded out under its node in the outline: a title bar (fold, zoom, run again, open big) and its page.
 * Nothing runs while folded. `look`: `{open, height, zoom}` as saved in the view; `onLook(look)` saves a change.
 * `load(ids)` gives `[{id, title, html}]`; `openBig(ids)` opens the Prototypes panel; `name`: its title until then.
 */
export function protoEmbed({ ids, name, look: first, onLook, load, openBig }) {
  let look = { open: false, height: null, zoom: null, ...first };
  let pages;
  let failed = "";
  let board = null;
  const body = h("div.proto-body");
  const head = h("div.proto-head");
  const el = h("div.proto", { dataset: { island: `proto:${ids.join(",")}` } }, head, body);

  const change = (patch) => {
    look = { ...look, ...patch };
    drawHead();
    board?.update(look);
    onLook?.(look);
  };
  const reload = async () => {
    failed = "";
    try {
      pages = await load(ids);
    } catch (error) {
      failed = error.message ?? String(error);
    }
    board = null;
    drawBody();
    drawHead();
  };
  const drawHead = () => {
    const zoom = look.zoom ?? 100;
    const title =
      pages?.length === 1 ? pages[0].title : pages?.length ? `${pages.length} prototypes` : name ?? "Prototype";
    const fold = look.open ? "Fold it away" : "Show it";
    const parts = [
      h("button.proto-fold", { title: fold, onclick: () => toggle() }, look.open ? "▾" : "▸"),
      h("strong.proto-title", { onclick: () => toggle() }, `▣ ${title}`),
      look.open && [
        h("button", { title: "Zoom the page out", onclick: () => change({ zoom: zoomOr(nextZoom(zoom, -1)) }) }, "−"),
        h(
          "button.proto-zoom",
          { title: "The page's zoom (click: 100%)", onclick: () => change({ zoom: null }) },
          `${zoom}%`,
        ),
        h("button", { title: "Zoom the page in", onclick: () => change({ zoom: zoomOr(nextZoom(zoom, 1)) }) }, "+"),
        h("button", { title: "Run it again", onclick: () => void reload() }, "↻"),
      ],
      h("button", { title: "Open it big, in a tab of its own", onclick: () => openBig(ids) }, "⤢"),
    ];
    head.replaceChildren(...parts.flat().filter(Boolean));
  };
  const drawBody = () => {
    if (!look.open) return body.replaceChildren();
    if (failed) return body.replaceChildren(h("div.proto-note", `Couldn't load it: ${failed}`));
    if (!pages) return body.replaceChildren(h("div.proto-note", "Loading…"));
    if (!pages.length) return body.replaceChildren(h("div.proto-note", "This prototype was deleted."));
    board ??= protoBoard({ pages, look, onHeight: (height) => change({ height }) });
    if (board.parentNode !== body) body.replaceChildren(board);
  };
  const toggle = () => {
    change({ open: !look.open });
    if (look.open && !pages) void reload();
    drawBody();
  };
  el.update = (next) => {
    const opened = next.open && !look.open;
    look = { ...look, ...next };
    drawHead();
    if (opened && !pages) void reload();
    drawBody();
    board?.update(look);
  };
  drawHead();
  if (look.open) void reload();
  return el;
}

const zoomOr = (z) => (z === 100 ? null : z);
