// Managing tags (from layr_code's view.tsx: manageTags, editTag, editSet): every set and tag in one dialog, open until
// closed. Rename, describe, colour, change set, reorder and delete tags; make, rename, describe and delete sets, one
// tag per node or any; add the Status set. Changes are saved as they are made.
import { TAG_COLORS } from "../shared/rows.js";
import { h } from "./dom.js";
import { modal } from "./dialogs.js";
import { shiftOrder, STATUS } from "./model.js";

const nodesText = (n) => (n === 1 ? "1 node" : `${n} nodes`);

/**
 * Open the tag manager. `run(write)` saves (showing what went wrong); `counts()` how many nodes have each tag;
 * `onDeleted(tag)` (the panel's filter forgets it). `focus`: a tag to start at.
 */
export function manageTags({ graph, ops, run, counts, onDeleted, focus }) {
  return modal(
    (done) => {
      const body = h("div.tags-manager");
      let tagCounts = {};
      let confirming = null; // a tag or set id waiting for its second click on Delete
      /** Drawn again after each change; the field typed in last keeps the focus. */
      const redraw = () => {
        const active = body.contains(document.activeElement) ? document.activeElement : null;
        const row = active?.closest("[data-tag], [data-set]");
        const spot = active && {
          row: row ? `[data-${row.dataset.tag ? "tag" : "set"}="${row.dataset.tag ?? row.dataset.set}"]` : "",
          field: active.getAttribute("placeholder") ?? active.getAttribute("aria-label"),
        };
        body.replaceChildren(...draw().flat(Infinity).filter(Boolean));
        if (!spot?.field) return;
        const sel = `${spot.row} [placeholder="${spot.field}"], ${spot.row} [aria-label="${spot.field}"]`;
        body.querySelector(sel.trim())?.focus();
      };
      const save = async (write) => {
        await run(write);
        redraw();
      };
      void counts()
        .then((c) => ((tagCounts = c ?? {}), redraw()))
        .catch(() => {});

      const colorSelect = (t) => {
        const select = h(
          "select.layr-select.small-select.tag-color",
          { "aria-label": `Colour of ${t.name}`, dataset: { color: t.color ?? "gray" } },
          ...TAG_COLORS.map((c) => h("option", { value: c, selected: (t.color ?? "gray") === c }, c)),
        );
        select.onchange = () =>
          save(() => ops.updateTag(t.id, { color: select.value === "gray" ? null : select.value }));
        return select;
      };
      const field = (value, placeholder, onSave, cls = "") => {
        const input = h(`input.layr-input.small-input${cls}`, { value, placeholder });
        const commit = () => input.value.trim() !== value.trim() && save(() => onSave(input.value));
        input.onkeydown = (e) => e.key === "Enter" && input.blur();
        input.onblur = commit;
        return input;
      };
      const deleteButton = (id, what, onDelete) =>
        h(
          "button.layr-button.small.ghost.danger",
          {
            title: what,
            onclick: () => {
              if (confirming !== id) {
                confirming = id;
                return redraw();
              }
              confirming = null;
              void save(onDelete);
            },
          },
          confirming === id ? "Sure?" : "Delete",
        );

      const tagRow = (t, siblings) => {
        const setChoice = h(
          "select.layr-select.small-select",
          { "aria-label": `Set of ${t.name}` },
          h("option", { value: "" }, "No set"),
          ...graph.sortedTagSets().map((s) => h("option", { value: s.id, selected: t.tag_set === s.id }, s.name)),
        );
        setChoice.onchange = () => save(() => ops.updateTag(t.id, { tag_set: setChoice.value || null }));
        const move = (by) =>
          save(async () => {
            for (const [id, pos] of shiftOrder(siblings, t.id, by)) await ops.updateTag(id, { pos });
          });
        return h(
          "div.tm-row.tm-tag",
          { dataset: { tag: t.id }, class: focus === t.id ? "focus" : "" },
          h("span.tag-pill", { dataset: { color: t.color ?? "gray" } }, t.name),
          field(t.name, "Name", (name) => ops.updateTag(t.id, { name }), ".tm-name"),
          field(t.description ?? "", "What it means", (description) => ops.updateTag(t.id, { description })),
          colorSelect(t),
          setChoice,
          h("span.tm-count.layr-muted", nodesText(tagCounts[t.id] ?? 0)),
          h("button.layr-button.small.ghost", { title: "Up", onclick: () => move(-1) }, "↑"),
          h("button.layr-button.small.ghost", { title: "Down", onclick: () => move(1) }, "↓"),
          deleteButton(t.id, `Delete the tag; it goes from ${nodesText(tagCounts[t.id] ?? 0)}`, async () => {
            onDeleted?.(t.id);
            await ops.deleteTag(t.id);
          }),
        );
      };

      const newTagRow = (setId) => {
        const input = h("input.layr-input.small-input", { placeholder: setId ? "New tag in this set" : "New tag" });
        const add = () => {
          const name = input.value.trim();
          if (name) void save(() => ops.createTag({ name, tag_set: setId }));
        };
        input.onkeydown = (e) => e.key === "Enter" && add();
        return h("div.tm-row.tm-new", input, h("button.layr-button.small", { onclick: add }, "Add"));
      };

      const draw = () => {
        const tags = graph.sortedTags();
        const sets = graph.sortedTagSets();
        const loose = tags.filter((t) => !t.tag_set || !graph.tagSets.has(t.tag_set));
        const setBlock = (s) => {
          const inSet = tags.filter((t) => t.tag_set === s.id);
          const single = h("input", { type: "checkbox", checked: !!s.single });
          single.onchange = () => save(() => ops.updateTagSet(s.id, { single: single.checked }));
          const move = (by) =>
            save(async () => {
              for (const [id, pos] of shiftOrder(sets, s.id, by)) await ops.updateTagSet(id, { pos });
            });
          return h(
            "section.tm-set",
            { dataset: { set: s.id } },
            h(
              "div.tm-row.tm-set-head",
              h("strong", "Set"),
              field(s.name, "Set name", (name) => ops.updateTagSet(s.id, { name }), ".tm-name"),
              field(s.description ?? "", "What it is for", (description) => ops.updateTagSet(s.id, { description })),
              h("label.check", { title: "Like a status: a new one replaces the old" }, single, " One per node"),
              h("button.layr-button.small.ghost", { title: "Up", onclick: () => move(-1) }, "↑"),
              h("button.layr-button.small.ghost", { title: "Down", onclick: () => move(1) }, "↓"),
              deleteButton(s.id, "Delete the set; its tags stay, in no set", () => ops.deleteTagSet(s.id)),
            ),
            inSet.map((t) => tagRow(t, inSet)),
            newTagRow(s.id),
          );
        };
        const newSet = h("input.layr-input.small-input", { placeholder: "New set, e.g. Platform" });
        const newSetSingle = h("input", { type: "checkbox" });
        const addSet = () => {
          const name = newSet.value.trim();
          if (name) void save(() => ops.createTagSet({ name, single: newSetSingle.checked }));
        };
        newSet.onkeydown = (e) => e.key === "Enter" && addSet();
        return [
          sets.map(setBlock),
          h(
            "section.tm-set.tm-loose",
            sets.length > 0 && h("div.tm-row.tm-set-head", h("strong", "In no set")),
            loose.map((t) => tagRow(t, loose)),
            newTagRow(null),
          ),
          h(
            "div.tm-row.tm-new",
            newSet,
            h("label.check", newSetSingle, " One per node"),
            h("button.layr-button.small", { onclick: addSet }, "Make a set"),
            !graph.tagSetByName("Status") &&
              h(
                "button.layr-button.small",
                {
                  title: STATUS.map((t) => t.name).join(", "),
                  onclick: () =>
                    save(async () => {
                      const set = await ops.createTagSet({
                        name: "Status",
                        single: true,
                        description: "Where it stands",
                      });
                      for (const t of STATUS) if (!graph.tagByName(t.name)) await ops.createTag({ ...t, tag_set: set });
                    }),
                },
                "Add a Status set",
              ),
          ),
        ];
      };
      redraw();
      if (focus) setTimeout(() => body.querySelector(`[data-tag="${focus}"] .tm-name`)?.focus(), 0);
      return [
        h("h3.modal-title", "Tags"),
        h("p.layr-muted.modal-note", "Changes are saved as you make them, on every node that has the tag."),
        body,
        h("div.modal-actions", h("button.layr-button.primary", { onclick: () => done(null) }, "Done")),
      ];
    },
    { wide: true },
  );
}
