// The panel's own dialogs (layr.js has no pickers): a modal, a text question, a confirmation, a list to pick from
// (filtered by typing), and a search for any node.
import { firstLine } from "../shared/graph.js";
import { h } from "./dom.js";

const $ = (sel, root = document) => root.querySelector(sel);

/** A dialog: `build(done)` gives its content; resolves with what `done` gets (null: closed with Esc or outside). */
export function modal(build, { wide = false } = {}) {
  const back = $("#modal");
  return new Promise((resolve) => {
    const done = (value) => {
      back.hidden = true;
      back.replaceChildren();
      document.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    back.onclick = (e) => e.target === back && done(null);
    back.replaceChildren(h("div.modal.layr-card", { role: "dialog", class: wide ? "wide" : "" }, build(done)));
    back.hidden = false;
    setTimeout(() => $("[data-first], input, textarea, select, button.primary", back)?.focus(), 0);
  });
}

export const isOpen = () => !$("#modal").hidden;

/** A line of text; null when cancelled. `empty`: an empty answer counts (it clears something). */
export const ask = (title, value = "", placeholder = "", { empty = false, multiline = false } = {}) =>
  modal((done) => {
    const input = multiline
      ? h("textarea.layr-textarea", { value, placeholder, rows: 4 })
      : h("input.layr-input", { value, placeholder });
    const ok = () => done(input.value.trim() || (empty ? "" : null));
    input.onkeydown = (e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), ok());
    return [
      h("h3.modal-title", title),
      input,
      h(
        "div.modal-actions",
        h("button.layr-button", { onclick: () => done(null) }, "Cancel"),
        h("button.layr-button.primary", { onclick: ok }, "OK"),
      ),
    ];
  });

export const confirmIt = (title, text, action, danger = true) =>
  modal((done) => [
    h("h3.modal-title", title),
    text && h("p.layr-muted", text),
    h(
      "div.modal-actions",
      h("button.layr-button", { onclick: () => done(false) }, "Cancel"),
      h(`button.layr-button${danger ? ".danger" : ".primary"}`, { onclick: () => done(true) }, action),
    ),
  ]);

/**
 * Pick one of `items` (`{label, description?, value, checked?}`); typing filters them. Resolves with the value, or
 * null. `note`: a line under the title.
 */
export const pick = (title, items, { note = "", empty = "Nothing to pick" } = {}) =>
  modal((done) => {
    const input = h("input.layr-input", { type: "search", placeholder: "Type to filter", autocomplete: "off" });
    const list = h("ul.layr-list.pick-list");
    let shown = items;
    let at = 0;
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      shown = items.filter((i) => !q || `${i.label} ${i.description ?? ""}`.toLowerCase().includes(q));
      at = Math.min(at, Math.max(0, shown.length - 1));
      list.replaceChildren(
        ...shown.map((i, n) =>
          h(
            "li",
            { class: n === at ? "active" : "", onclick: () => done(i.value), dataset: { value: String(i.value) } },
            h("div.pick-label", i.checked ? "✓ " : "", i.label),
            i.description && h("div.pick-path.layr-muted", i.description),
          ),
        ),
        ...(shown.length ? [] : [h("li.layr-muted", empty)]),
      );
      list.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
    };
    input.oninput = () => ((at = 0), draw());
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        at = Math.max(0, Math.min(shown.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
        draw();
      } else if (e.key === "Enter" && shown[at]) {
        e.preventDefault();
        done(shown[at].value);
      }
    };
    draw();
    return [h("h3.modal-title", title), note && h("p.layr-muted.modal-note", note), items.length > 7 && input, list];
  });

/**
 * Pick any node: what you type searches all of them (`search(q)` → `[{id, text, path}]`). `first`: items shown
 * before anything is typed (e.g. the group's other children).
 */
export const pickNode = (title, search, exclude = () => false, first = []) =>
  modal((done) => {
    const input = h("input.layr-input", { placeholder: "Type to search", type: "search", autocomplete: "off" });
    const list = h("ul.layr-list.pick-list");
    const row = (id, label, path) =>
      h(
        "li",
        { onclick: () => done(id) },
        h("div.pick-label", label || "(empty)"),
        path && h("div.pick-path.layr-muted", path),
      );
    const drawFirst = () => list.replaceChildren(...first.map((f) => row(f.id, f.label, f.description)));
    drawFirst();
    let timer;
    input.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) return drawFirst();
        const hits = (await search(q).catch(() => [])).filter((x) => !exclude(x.id));
        list.replaceChildren(
          ...hits.map((x) =>
            row(x.id, firstLine(x.text), x.path.map((p) => p.text || "(empty)").join(" › ") || "in no group"),
          ),
          ...(hits.length ? [] : [h("li.layr-muted", "Nothing found")]),
        );
      }, 200);
    };
    input.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      list.querySelector("li:not(.layr-muted)")?.click();
    };
    return [h("h3.modal-title", title), input, list];
  });

/** Show `text` to copy (where the clipboard can't be written). */
export const showText = (title, text) =>
  modal((done) => {
    const area = h("textarea.layr-textarea.ai-text", { value: text, readOnly: true, rows: 8 });
    setTimeout(() => area.select(), 0);
    return [
      h("h3.modal-title", title),
      area,
      h("div.modal-actions", h("button.layr-button.primary", { onclick: () => done(null) }, "Close")),
    ];
  });
