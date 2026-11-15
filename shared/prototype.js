// A prototype is a node with an HTML page (`concepts_pages`). Pages aren't changed: a change is a new node, with a page
// made from the old one by small edits, and a "developed from" edge to it. Alternatives are simply unconnected nodes.
import { MAX_HTML } from "./links.js";
export const DEVELOPED_FROM = "developed from";
/** Where a prototype goes when nothing says where. */
export const PROTOTYPES_GROUP = "Prototypes";
/** `html` with each edit made in turn. Each `find` must be there exactly once, so an edit can't land in the wrong place. */
export function applyEdits(html, edits) {
  return edits.reduce((page, { find, replace }) => {
    if (!find) throw new Error("An edit needs a `find`");
    const count = page.split(find).length - 1;
    if (count !== 1) {
      throw new Error(
        `\`find\` must match exactly once, but matches ${count} times: ${JSON.stringify(find.slice(0, 80))}`,
      );
    }
    return page.replace(find, () => replace);
  }, html);
}
export function checkPage(html) {
  if (!html.trim()) throw new Error("The page has no HTML");
  if (html.length > MAX_HTML) throw new Error(`The page is over ${MAX_HTML} characters: make it smaller`);
  return html;
}
