// Building the panel's DOM: `h()` makes elements, `morph()` makes a part of the page look like a newly built one while
// keeping what must stay (scroll positions, the free canvas, prototype frames that would reload, the text being typed
// in). Handlers given to `h()` are kept on the element (`__on`), so `morph()` can hand the new ones to the element it
// keeps.

/** `h("div.a.b", {onclick}, children…)`: an element. Strings become text; null/false are skipped. */
export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split(".");
  const svg = name === "svg" || SVG_TAGS.has(name);
  const el = svg ? document.createElementNS(SVG, name) : document.createElement(name || "div");
  if (classes.length) el.setAttribute("class", classes.join(" "));
  if (props && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = {};
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") on(el, k.slice(2), v);
    else if (k === "class") el.setAttribute("class", `${el.getAttribute("class") ?? ""} ${v}`.trim());
    else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) dv !== undefined && (el.dataset[dk] = dv);
    else if (k === "style") el.style.cssText = v;
    else if (k === "innerHTML") el.innerHTML = v;
    else if (!svg && k in el && k !== "list" && typeof v !== "string") el[k] = v;
    else if (!svg && (k === "value" || k === "contentEditable")) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["path", "line", "g", "text", "defs", "marker", "polygon", "rect", "circle"]);
/** Events whose listeners must be able to cancel scrolling. */
const ACTIVE = new Set(["wheel", "touchmove", "touchstart"]);

function dispatch(e) {
  return e.currentTarget.__on?.[e.type]?.call(e.currentTarget, e);
}

/** Set the handler of `type` on `el` (one per type), so `morph()` can replace it later. */
export function on(el, type, fn) {
  el.__on ??= {};
  if (!(type in el.__on)) el.addEventListener(type, dispatch, ACTIVE.has(type) ? { passive: false } : undefined);
  el.__on[type] = fn;
}

/**
 * Make `live` (on the page) look like `next` (just built), keeping `live` itself. Children match by `data-key`, else
 * by place and tag. A child marked `data-island="<id>"` stays as it is while the id is the same (its content is
 * managed by its own code); one marked `data-own`, and form fields, are replaced (their handlers hold on to them)
 * unless they have the focus, when they stay as they are.
 */
export function morph(live, next) {
  syncAttributes(live, next);
  syncHandlers(live, next);
  patchChildren(live, next);
}

/** Put `children` into `live`, morphing what is there. */
export function morphChildren(live, children) {
  const next = document.createElement(live.tagName);
  next.append(...children);
  patchChildren(live, next);
}

const keyOf = (n) => (n.nodeType === 1 ? n.getAttribute("data-key") ?? null : null);
const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);

function patchChildren(live, next) {
  const wanted = [...next.childNodes];
  const keyed = new Map();
  const loose = [];
  for (const c of live.childNodes) {
    const key = keyOf(c);
    if (key !== null && !keyed.has(key)) keyed.set(key, c);
    else loose.push(c);
  }
  const used = new Set();
  let li = 0;
  wanted.forEach((n, i) => {
    const key = keyOf(n);
    let match = null;
    if (key !== null) {
      const c = keyed.get(key);
      if (c && same(c, n)) match = c;
    } else {
      while (li < loose.length && (used.has(loose[li]) || keyOf(loose[li]) !== null)) li++;
      if (li < loose.length && same(loose[li], n)) match = loose[li++];
    }
    let node = n;
    if (match) {
      used.add(match);
      node = patch(match, n);
    }
    const at = live.childNodes[i];
    if (at !== node) live.insertBefore(node, at ?? null);
  });
  while (live.childNodes.length > wanted.length) live.lastChild.remove();
}

/** The node that stays in the page for `l` (live) and `n` (new). */
function patch(l, n) {
  if (l.nodeType !== 1) {
    if (l.data !== n.data) l.data = n.data;
    return l;
  }
  const island = n.getAttribute("data-island");
  if (island !== null && l.getAttribute("data-island") === island) return l;
  const own = n.hasAttribute("data-own") || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName);
  if (own || island !== null) {
    const active = document.activeElement;
    if (own && active && active !== document.body && l.contains(active)) return l;
    l.replaceWith(n);
    return n;
  }
  morph(l, n);
  return l;
}

function syncAttributes(l, n) {
  for (const { name } of [...l.attributes]) if (!n.hasAttribute(name)) l.removeAttribute(name);
  for (const { name, value } of n.attributes) if (l.getAttribute(name) !== value) l.setAttribute(name, value);
}

function syncHandlers(l, n) {
  const fresh = n.__on ?? {};
  for (const type of Object.keys(l.__on ?? {})) if (!(type in fresh)) l.__on[type] = undefined;
  for (const [type, fn] of Object.entries(fresh)) on(l, type, fn);
}

// ---------------------------------------------------------------- icons

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
  tag: "M3 3h8l10 10-8 8L3 11zm4 2.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  back: "M10 6l-6 6 6 6 1.4-1.4L7.8 13H20v-2H7.8l3.6-3.6z",
  edit: "M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z",
  trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z",
  more:
    "M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" +
    "m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z",
  vertical: "M11 4h2v12.2l3.6-3.6L18 14l-6 6-6-6 1.4-1.4 3.6 3.6z",
  horizontal: "M4 11h12.2l-3.6-3.6L14 6l6 6-6 6-1.4-1.4 3.6-3.6H4z",
  free: "M12 2l3 3h-2v4h-2V5H9zm0 20l-3-3h2v-4h2v4h2zM2 12l3-3v2h4v2H5v2zm20 0l-3 3v-2h-4v-2h4V9z",
  fit: "M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z",
};

export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICONS[name]);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

export const iconButton = (name, title, onclick, extra = "") =>
  h(`button.layr-button.ghost.icon${extra}`, { title, "aria-label": title, onclick }, icon(name));
