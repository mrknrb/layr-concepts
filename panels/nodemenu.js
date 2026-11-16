// A node's context menu (right-click, long-press, ⋯, the menu key), as items for layr.ui.contextMenu: plain data, so
// test/nodemenu.test.js checks them without a page. The panel passes what each item does (`act`).
import { TAG_COLORS } from "../shared/rows.js";

/** Items without the parts left out (false, null) and without separators at the ends or next to each other. */
export function tidy(items) {
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (item === "-") {
      if (out.length && out.at(-1) !== "-") out.push("-");
      continue;
    }
    if (item.items) {
      const sub = tidy(item.items);
      if (sub.length) out.push({ ...item, items: sub });
      continue;
    }
    out.push(item);
  }
  while (out.at(-1) === "-") out.pop();
  return out;
}

/**
 * The menu of `node`, shown through the group conn `group` (none: the root of what is shown). `open`: its children
 * show here; `act`: what the items do, each called with what it needs.
 */
export function nodeMenuItems(graph, { node, group, open = false, root = false }, act) {
  const n = graph.node(node);
  if (!n) return [];
  const parent = group ? graph.group(group)?.data.from : undefined;
  const siblings = parent ? graph.children(parent) : [];
  const index = group ? siblings.findIndex((c) => c.id === group) : -1;
  const last = parent ? graph.childCount(parent) - 1 : -1;
  const kids = graph.childCount(node);
  const summary = graph.summary(node);

  const tag = (t) => {
    const has = !!graph.nodeTag(node, t.id);
    return { label: t.name, checked: has, run: () => act.setTag(node, t.id, !has) };
  };
  const tags = graph.sortedTags();
  const sets = graph.sortedTagSets().filter((s) => tags.some((t) => t.tag_set === s.id));
  const tagItems = [
    ...sets.map((s) => ({ label: s.name, items: tags.filter((t) => t.tag_set === s.id).map(tag) })),
    ...tags.filter((t) => !t.tag_set || !graph.tagSets.has(t.tag_set)).map(tag),
    "-",
    { label: "New tag…", icon: "add", run: () => act.newTag(node) },
  ];
  const colorItems = [
    { label: "No colour", checked: !n.data.color, run: () => act.setColor(node, null) },
    "-",
    ...TAG_COLORS.filter((c) => c !== "gray").map((c) => ({
      label: c[0].toUpperCase() + c.slice(1),
      checked: n.data.color === c,
      run: () => act.setColor(node, c),
    })),
  ];

  return tidy([
    { label: "Edit", icon: "edit", shortcut: "Ctrl+click", run: () => act.edit(node) },
    "-",
    {
      label: "Add inside",
      icon: "subdirectory_arrow_right",
      shortcut: "Ctrl+Enter",
      run: () => act.addInside(node, group),
    },
    group && { label: "Add below", icon: "add", shortcut: "Enter", run: () => act.addBelow(group) },
    group && kids > 0 && {
      label: open ? "Close" : "Open",
      icon: open ? "unfold_less" : "unfold_more",
      shortcut: "Space",
      run: () => act.toggle(node),
    },
    !root && kids > 0 && { label: "Show it as the root", icon: "open_in_full", run: () => act.focusRoot(node) },
    "-",
    { label: summary ? "Edit the summary…" : "Write a summary…", icon: "notes", run: () => act.summary(node) },
    { label: "Summarize with Claude…", icon: "auto_awesome", run: () => act.summarize(node) },
    { label: "Tags", icon: "sell", items: tagItems },
    { label: "Colour", icon: "palette", items: colorItems },
    {
      label: "Order doesn't matter",
      checked: !!n.data.unordered,
      run: () => act.setUnordered(node, !n.data.unordered),
    },
    "-",
    { label: "Connect to…", icon: "link", run: () => act.connect(node) },
    group && index > 0 && { label: "Move up", icon: "arrow_upward", shortcut: "Alt+↑", run: () => act.move(group, -1) },
    group && index >= 0 && index < last && {
      label: "Move down",
      icon: "arrow_downward",
      shortcut: "Alt+↓",
      run: () => act.move(group, 1),
    },
    group && { label: "Move to…", icon: "drive_file_move", run: () => act.moveTo(group) },
    { label: "Also in…", icon: "library_add", run: () => act.alsoIn(node) },
    "-",
    { label: n.data.image ? "Change the picture…" : "Add a picture…", icon: "image", run: () => act.picture(node) },
    n.data.image && { label: "Remove the picture", icon: "hide_image", run: () => act.removePicture(node) },
    "-",
    group && {
      label: "Take out of this group",
      icon: "remove_circle_outline",
      shortcut: "Del",
      run: () => act.takeOut(group),
    },
    { label: "Delete everywhere…", icon: "delete", danger: true, run: () => act.delete(node) },
  ]);
}
