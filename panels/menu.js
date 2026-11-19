// Menus: the shell's (layr.ui.contextMenu, drawn in Flutter above the panel, docs/ARCHITECTURE.md › Context menus),
// or, where there is no shell (a plain browser, the panel's tests), a small one of our own drawn in the page with the
// same items: `{label, icon?, shortcut?, disabled?, checked?, danger?, run?, items?}` or "-".
import { h } from "./dom.js";

/** Show `items` at `at` (a mouse event, or {x, y} in the page); resolves with the picked item (after its `run`). */
export async function showMenu(items, at) {
  if (!items.length) return null;
  if (typeof layr.ui.contextMenu === "function" && !window.conceptsOwnMenus) {
    try {
      return await layr.ui.contextMenu(items, at);
    } catch (error) {
      if (error?.code !== layr.errors.NOT_AVAILABLE) throw error;
    }
  }
  at?.preventDefault?.();
  return ownMenu(items, { x: at?.clientX ?? at?.x ?? 20, y: at?.clientY ?? at?.y ?? 20 });
}

let closeOpen = null;

/** Our own menu, for where the shell can't draw one. */
function ownMenu(items, { x, y }) {
  closeOpen?.(null);
  return new Promise((resolve) => {
    const layer = h("div.menu-layer");
    const done = (item) => {
      layer.remove();
      document.removeEventListener("keydown", onKey, true);
      closeOpen = null;
      resolve(item);
      if (item?.run) setTimeout(() => item.run(), 0);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      const subs = layer.querySelectorAll(".menu-box");
      if (subs.length > 1) subs[subs.length - 1].remove();
      else done(null);
    };
    closeOpen = done;
    layer.addEventListener("pointerdown", (e) => e.target === layer && done(null));
    layer.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (e.target === layer) done(null);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(layer);

    /** `left`: where the row it opens from starts (a submenu with no room on the right goes to the left of it). */
    const open = (list, px, py, depth, left = null) => {
      for (const box of [...layer.querySelectorAll(".menu-box")].slice(depth)) box.remove();
      const box = h("div.menu-box", { role: "menu", dataset: { depth: String(depth) } });
      for (const item of list) {
        if (item === "-") {
          box.append(h("div.menu-sep"));
          continue;
        }
        const row = h(
          "button.menu-item",
          {
            role: "menuitem",
            class: [item.danger ? "danger" : "", item.items ? "sub" : ""].join(" "),
            disabled: !!item.disabled,
          },
          h("span.menu-check", item.checked ? "✓" : ""),
          h("span.menu-label", item.label),
          item.shortcut && h("span.menu-key", item.shortcut),
          item.items && h("span.menu-arrow", "›"),
        );
        const openSub = () => {
          const r = row.getBoundingClientRect();
          open(item.items, r.right - 2, r.top - 4, depth + 1, r.left);
        };
        row.addEventListener("pointerenter", () => (item.items ? openSub() : open([], 0, 0, depth + 1)));
        row.addEventListener("click", () => (item.items ? openSub() : done(item)));
        box.append(row);
      }
      if (!list.length) return;
      layer.append(box);
      const r = box.getBoundingClientRect();
      const x = left !== null && px + r.width > innerWidth - 4 ? left - r.width + 2 : px;
      box.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
      box.style.top = `${Math.max(4, Math.min(py, innerHeight - r.height - 4))}px`;
    };
    open(items, x, y, 0);
  });
}
