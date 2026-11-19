// A node's text as Markdown, the way layr_code's panel showed it (panels/markdown.ts, there with `marked`): line breaks
// kept, raw HTML shown as text, layr links (`[label](layr://plugin/kind/id)`) as chips the panel opens, web links
// opening outside. A small renderer of its own (node texts are short): headings, lists, quotes, code blocks, inline
// code, bold, italic, strikethrough, links and bare web addresses. Pure: it gives HTML text (tested in
// test/markdown.test.js).
import { parseLayrLink } from "../shared/links.js";

const LINK_ICONS = { concepts: "◆", claude: "💬", chat: "💬", pipeline: "▶" };

export const escapeHtml = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Whether `text` has anything Markdown would show differently from plain text. */
export const hasMarkdown = (text) => /[*_`~#>[\]]|^\s*([-+]|\d+[.)])\s|https?:\/\//m.test(text ?? "");

/** A link: a chip for a layr link, an anchor for a web or mail address, else only its label. */
function link(href, label) {
  const target = href.trim();
  const layr = parseLayrLink(target);
  if (layr) {
    const mark = layr.kind === "prototype" ? "▣" : LINK_ICONS[layr.plugin] ?? "↗";
    const title = escapeHtml(target);
    return (
      `<a class="link-chip" href="#" title="${title}" data-layr-link="${title}">` +
      `${mark} ${label || escapeHtml(layr.kind)}</a>`
    );
  }
  if (!/^(https?:|mailto:)/i.test(target)) return label;
  return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener noreferrer" data-web-link="1">${label}</a>`;
}

/** One line (or paragraph) of inline Markdown as HTML. */
export function inline(text) {
  const out = [];
  // Code spans first: nothing inside them is formatted.
  const parts = String(text).split(/(`[^`\n]+`)/);
  for (const part of parts) {
    if (/^`[^`\n]+`$/.test(part)) {
      out.push(`<code>${escapeHtml(part.slice(1, -1))}</code>`);
      continue;
    }
    out.push(spans(part));
  }
  return out.join("");
}

/** `[label](href)` (the label may hold one level of brackets, the address of parentheses), or a bare web address. */
const LINK = new RegExp(
  [
    String.raw`\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(([^()\s]+(?:\([^()\s]*\))?[^()\s]*)\)`,
    String.raw`(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])`,
  ].join("|"),
  "g",
);

/** Links, then emphasis around and between them. */
function spans(text) {
  let html = "";
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    html += emphasis(escapeHtml(text.slice(last, m.index)));
    html += m[3] ? link(m[3], escapeHtml(m[3])) : link(m[2], emphasis(escapeHtml(m[1])));
    last = m.index + m[0].length;
  }
  return html + emphasis(escapeHtml(text.slice(last)));
}

/** Bold, italic and strikethrough in escaped text. */
function emphasis(html) {
  return html
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)([^_]*?\S)__/g, "<strong>$1</strong>")
    .replace(/~~(?=\S)([^~]*?\S)~~/g, "<del>$1</del>")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1<em>$2</em>");
}

/** A node's whole text as HTML blocks. */
export function renderMarkdown(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const blocks = [];
  let para = [];
  let list = null; // {tag, items}
  let quote = null;
  const endPara = () => {
    if (para.length) blocks.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const endList = () => {
    if (list) blocks.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const endQuote = () => {
    if (quote) blocks.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
    quote = null;
  };
  const endAll = () => {
    endPara();
    endList();
    endQuote();
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*(\S*)/.exec(line);
    if (fence) {
      endAll();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      const lang = fence[1] ? `<div class="codeblock-lang">${escapeHtml(fence[1])}</div>` : "";
      blocks.push(`<div class="codeblock">${lang}<pre><code>${escapeHtml(code.join("\n"))}</code></pre></div>`);
      continue;
    }
    if (!line.trim()) {
      endAll();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      endAll();
      blocks.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      endPara();
      endList();
      (quote ??= []).push(q[1]);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const number = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || number) {
      endPara();
      endQuote();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) endList();
      (list ??= { tag, items: [] }).items.push((bullet ?? number)[1]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    endList();
    endQuote();
    para.push(line);
  }
  endAll();
  return blocks.join("");
}
