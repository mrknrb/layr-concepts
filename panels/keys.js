// What the keys do in the outline, as plain functions (tested in test/keys.test.js): while a node's text is typed in
// its row, and while a row is only picked (the cursor) with nothing being typed. Ported from layr_code's view.tsx
// (Item's onKey and onViewKey).

/** Links to other things in a node's text show as their label until the text is edited (`[label](layr://…)`). */
const LINK = /\[([^\]\n]*)\]\(layr:\/\/[^)\s]+\)/g;

/** A node's text as its row shows it while it isn't edited: all of its lines, links as their labels. */
export const shownText = (text) => (text ?? "").trim().replace(LINK, "$1");

/**
 * What a key does while a node's text is typed in its row: `child` (Ctrl+Enter, a new child, last), `sibling` (Enter,
 * a new node below; in the root's title a new first child), `stop` (Esc), `indent` / `outdent` (Tab / Shift+Tab),
 * `delete` (Backspace in an empty node that may go), `up` / `down` (Alt+↑ / Alt+↓); null: the key types as usual
 * (Shift+Enter is a new line).
 */
export function editAction(e, { empty = false, deletable = false } = {}) {
  if (e.isComposing) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "Enter" && mod) return "child";
  if (e.key === "Enter" && !e.shiftKey && !e.altKey) return "sibling";
  if (e.key === "Escape") return "stop";
  if (e.key === "Tab" && !mod && !e.altKey) return e.shiftKey ? "outdent" : "indent";
  if (e.key === "Backspace" && empty && deletable && !mod && !e.shiftKey && !e.altKey) return "delete";
  if (e.altKey && !mod && !e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    return e.key === "ArrowUp" ? "up" : "down";
  }
  return null;
}

/**
 * What a key does on the picked row while nothing is typed: `prev` / `next` (↑ / ↓), `right` / `left` (open, into its
 * group / close, out to its parent), `up` / `down` (Alt+↑ / Alt+↓: move it), `child` (Ctrl+Enter), `edit` (Enter or
 * F2: type in it), `toggle` (Space), `remove` (Delete), `clear` (Esc), `menu` (the menu key or Shift+F10); null: not
 * one of ours.
 */
export function rowAction(e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  if (k === "ContextMenu" || (k === "F10" && e.shiftKey)) return "menu";
  if (k === "Escape") return "clear";
  if ((k === "ArrowUp" || k === "ArrowDown") && e.altKey && !mod) return k === "ArrowUp" ? "up" : "down";
  if (mod || e.altKey) return k === "Enter" && mod ? "child" : null;
  if (k === "ArrowUp") return "prev";
  if (k === "ArrowDown") return "next";
  if (k === "ArrowRight") return "right";
  if (k === "ArrowLeft") return "left";
  if (k === "Enter" || k === "F2") return "edit";
  if (k === " ") return "toggle";
  if (k === "Delete") return "remove";
  return null;
}

/**
 * What typing in a node's row saves: the text without the spaces around it, or null when nothing should be saved (it
 * didn't change, or it is empty: an existing node isn't emptied by typing; a new one left empty goes away instead).
 */
export function textToSave(typed, stored) {
  const text = (typed ?? "").trim();
  return text && text !== (stored ?? "") ? text : null;
}
