// Links between plugins and prototype pages (from layr_code's packages/protocol/src/links.ts and
// packages/panel-ui/src/prototype.ts). Nothing here touches the DOM, so the backend uses it too.

/** Characters of HTML in one page. Enough for a page; pictures should be small SVGs. */
export const MAX_HTML = 400_000;

const PATTERN = /^layr:\/\/([a-z0-9-]+)\/([a-z0-9-]+)\/(.+)$/i;

/** `layr://<plugin>/<kind>/<id>`: a link to another plugin's item, written in text as a Markdown link. */
export const layrLink = ({ plugin, kind, id }) => `layr://${plugin}/${kind}/${encodeURIComponent(id)}`;

export function parseLayrLink(href) {
  const match = PATTERN.exec(String(href).trim());
  if (!match) return null;
  try {
    return { plugin: match[1], kind: match[2], id: decodeURIComponent(match[3]) };
  } catch {
    return null;
  }
}

/** A Markdown link to a layr item; brackets in the label are dropped so it stays one link. */
export const layrMarkdownLink = (label, link) =>
  `[${label.replace(/[[\]\n]/g, " ").trim() || link.kind}](${layrLink(link)})`;

/** `[title](layr://concepts/prototype/<node id>)`: shows the prototype live under the text it is in. */
export const prototypeLink = (title, id) => layrMarkdownLink(title, { plugin: "concepts", kind: "prototype", id });

/** Inline scripts and styles run, nothing else loads and nothing can be sent anywhere. `eval` stays off. */
export const PROTOTYPE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Runs in the page: says how tall it is, and keeps a click on a link from leaving the prototype. */
const BOOT = `(function () {
  function size() {
    parent.postMessage({ layrPrototypeHeight: document.documentElement.getBoundingClientRect().height }, "*");
  }
  new ResizeObserver(size).observe(document.documentElement);
  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest("a[href]");
    if (link && link.getAttribute("href").charAt(0) !== "#") e.preventDefault();
  }, true);
})();`;

/**
 * The document an iframe's `srcdoc` gets. `html` is a whole page or a fragment: it follows what is put here, so the
 * policy is in force before any of it is read (a later one can only tighten it), and a `<html>` or `<head>` in it
 * merges into these. `theme` are layr's CSS variables and `css` its base styles, so a page can look like the app.
 */
export function prototypeDocument(html, theme = {}, css = "") {
  const variables = Object.entries(theme)
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
  // The theme after the base styles and more specific than their light/dark rules (`:root:not([data-theme])` in
  // layr.css), so it wins over their own defaults.
  const style = `${css}:root:root:root{${variables}}html,body{height:auto}body{padding:12px}`.replaceAll("</", "<\\/");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${PROTOTYPE_CSP}">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<style>${style}</style><script>${BOOT}</script>${html}`
  );
}
