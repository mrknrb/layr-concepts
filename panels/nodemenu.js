// The panel's menus (right-click, long-press, ⋯, the menu key, a tag pill, an edge chip), as items for
// layr.ui.contextMenu: plain data, so test/nodemenu.test.js checks them without a page. The panel passes what each item
// does (`act`) and how things look in the view shown (`ctx`).
import { TAG_COLORS } from "../shared/rows.js";
import { nodeLabel } from "../shared/outline.js";
import { ARRANGE_INFO, edgeText, edgesHere, LAYOUT_INFO, otherEnd } from "./model.js";
import { ARRANGES } from "../shared/layout/index.js";

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
  while (out[0] === "-") out.shift();
  return out;
}

const capital = (s) => s[0].toUpperCase() + s.slice(1);
const all = (xs, test) => xs.length > 0 && xs.every(test);

/** How the view shown looks, for the menus: `look(node)` its look row there, if any. Without a view, nothing. */
const NO_CTX = { look: () => undefined, view: false };

/** The layout of `node`'s children in the view shown. */
export const layoutOf = (ctx, node) => ctx.look(node)?.layout ?? "vertical";
/** Whether the order of `node`'s children counts when they are arranged: as set, else when the group is ordered. */
export const useOrderOf = (graph, ctx, node) => {
  const set = ctx.look(node)?.use_order;
  return typeof set === "boolean" ? set : !graph.node(node)?.data.unordered;
};

/** A submenu with a node colour to choose, for one node or several (✓: what they all have now). */
export function colorItems(graph, nodes, act) {
  const now = new Set(nodes.map((n) => graph.node(n)?.data.color ?? null));
  const current = now.size === 1 ? [...now][0] : undefined;
  return [
    { label: "No colour", checked: current === null, run: () => act.setColor(nodes, null) },
    "-",
    ...TAG_COLORS.filter((c) => c !== "gray").map((c) => ({
      label: capital(c),
      checked: current === c,
      run: () => act.setColor(nodes, c),
    })),
  ];
}

/**
 * The "Layout" submenu for `nodes` (whose children it lays out, in the view shown): vertical, horizontal or free; in
 * a free layout how they are arranged and take space; opening everything inside. `rows`: those shown as rows (not
 * the root), which can open everything inside them and whose free area has a size.
 */
export function layoutItems(graph, ctx, nodes, act, rows = nodes) {
  if (!ctx.view || !nodes.length) return null;
  const free = nodes.filter((n) => layoutOf(ctx, n) === "free");
  const areas = free.filter((n) => rows.includes(n));
  const several = nodes.length > 1;
  const arrangeItem = (k) => ({
    label: k ? ARRANGE_INFO[k].label : "By hand",
    checked: all(free, (n) => (ctx.look(n)?.arrange ?? null) === (k ?? null)),
    run: () => act.arrange(free, k ?? null),
  });
  const ordered = all(free, (n) => useOrderOf(graph, ctx, n));
  return {
    label: "Layout",
    icon: "dashboard",
    items: [
      ...Object.entries(LAYOUT_INFO).map(([id, info]) => ({
        label: `${info.mark} ${info.label}`,
        checked: all(nodes, (n) => layoutOf(ctx, n) === id),
        run: () => act.setLayout(nodes, id),
      })),
      free.length > 0 && "-",
      free.length > 0 && {
        label: several && free.length < nodes.length ? `Arrange (${free.length} free)` : "Arrange",
        icon: "auto_fix_high",
        items: [
          arrangeItem(null),
          "-",
          ...ARRANGES.map(arrangeItem),
          "-",
          {
            label: "Once, then by hand",
            items: ARRANGES.map((k) => ({ label: ARRANGE_INFO[k].label, run: () => act.arrangeOnce(free, k) })),
          },
          { label: "Order counts", checked: ordered, run: () => act.useOrder(free, !ordered) },
        ],
      },
      areas.length > 0 && {
        label: "Size",
        items: [
          {
            label: "Scroll area",
            checked: all(areas, (n) => !ctx.look(n)?.overflow),
            run: () => act.overflow(areas, null),
          },
          {
            label: "Grow to fit",
            checked: all(areas, (n) => ctx.look(n)?.overflow === "grow"),
            run: () => act.overflow(areas, "grow"),
          },
        ],
      },
      rows.some((n) => graph.childCount(n) > 0) && "-",
      rows.some((n) => graph.childCount(n) > 0) && {
        label: "Open everything inside",
        shortcut: "Alt+click ▸",
        run: () => act.openAll(rows, true),
      },
      rows.some((n) => graph.childCount(n) > 0) && {
        label: "Close everything inside",
        run: () => act.openAll(rows, false),
      },
    ],
  };
}

/** The tags submenu for one node, or for several (✓: they all have it; picking it then takes it off them all). */
export function tagItems(graph, nodes, act) {
  const has = (t) => all(nodes, (n) => !!graph.nodeTag(n, t.id));
  const tag = (t) => ({ label: t.name, checked: has(t), run: () => act.setTag(nodes, t.id, !has(t)) });
  const tags = graph.sortedTags();
  const sets = graph.sortedTagSets().filter((s) => tags.some((t) => t.tag_set === s.id));
  return [
    ...sets.map((s) => ({ label: s.name, items: tags.filter((t) => t.tag_set === s.id).map(tag) })),
    ...tags.filter((t) => !t.tag_set || !graph.tagSets.has(t.tag_set)).map(tag),
    "-",
    { label: "New tag…", icon: "add", run: () => act.newTag(nodes) },
    { label: "Manage tags…", icon: "settings", run: () => act.manageTags() },
  ];
}

/** An edge's menu, seen from `node` (shown inside `parent`, if any). */
export function edgeItems(graph, edgeId, node, parent, act) {
  const e = graph.edge(edgeId);
  if (!e) return [];
  const bothHere = !!parent && !!graph.membership(parent, e.data.from) && !!graph.membership(parent, e.data.to);
  return tidy([
    {
      label: `Show "${nodeLabel(graph, otherEnd(e, node))}"`,
      icon: "visibility",
      run: () => act.show(otherEnd(e, node)),
    },
    { label: e.data.label ? "Edit the label" : "Add a label", icon: "edit", run: () => act.editLabel(edgeId) },
    { label: "Change its type…", icon: "swap_horiz", run: () => act.changeType(edgeId) },
    e.data.in
      ? {
          label: "Hold everywhere",
          icon: "public",
          shortcut: `now only in ${nodeLabel(graph, e.data.in)}`,
          run: () => act.holdIn(edgeId, null),
        }
      : bothHere && {
          label: `Hold only in "${nodeLabel(graph, parent)}"`,
          icon: "filter_center_focus",
          run: () => act.holdIn(edgeId, parent),
        },
    "-",
    { label: "Delete the edge", icon: "delete", danger: true, run: () => act.deleteEdge(edgeId) },
  ]);
}

/** A tag pill's menu: switch within its set, take it off, filter by it, its colour, edit it. */
export function tagPillItems(graph, node, tagId, filter, act) {
  const t = graph.tags.get(tagId);
  if (!t) return [];
  const set = t.tag_set ? graph.tagSets.get(t.tag_set) : undefined;
  const others = set ? graph.sortedTags().filter((o) => o.tag_set === set.id && o.id !== t.id) : [];
  const only = filter.includes(tagId);
  return tidy([
    ...others.map((o) => {
      const on = !!graph.nodeTag(node, o.id);
      return {
        label: `${set.single ? "Change to" : on ? "Take off" : "Also"} ${o.name}`,
        checked: on,
        run: () => act.setTag([node], o.id, !on),
      };
    }),
    "-",
    { label: `Take ${t.name} off`, icon: "remove", run: () => act.setTag([node], tagId, false) },
    {
      label: only ? `Stop showing only ${t.name}` : `Show only nodes tagged ${t.name}`,
      icon: "filter_alt",
      checked: only,
      run: () => act.filter(only ? filter.filter((x) => x !== tagId) : [...filter, tagId]),
    },
    "-",
    {
      label: `Colour of ${t.name}`,
      icon: "palette",
      items: TAG_COLORS.map((c) => ({
        label: capital(c),
        checked: (t.color ?? "gray") === c,
        run: () => act.tagColor(tagId, c === "gray" ? null : c),
      })),
    },
    { label: `Edit the tag ${t.name}…`, icon: "edit", run: () => act.manageTags(tagId) },
  ]);
}

/** Links to other plugins: copy, send to the pipeline, link or unlink a task, ask Claude, make an idea. */
function linkItems(graph, node, act, ctx) {
  const proto = !!graph.node(node)?.data.prototype;
  return {
    label: "Links",
    icon: "link",
    items: [
      { label: proto ? "Copy the prototype link" : "Copy link", icon: "content_copy", run: () => act.copyLink(node) },
      proto && { label: "Copy the node link", run: () => act.copyLink(node, "node") },
      "-",
      ctx.pipeline !== false && {
        label: "Send to the pipeline as a task…",
        icon: "rocket_launch",
        run: () => act.sendToPipeline(node),
      },
      ctx.pipeline !== false && { label: "Link a pipeline task…", icon: "add_link", run: () => act.linkTask(node) },
      { label: "Unlink…", icon: "link_off", run: () => act.unlink(node) },
      "-",
      ctx.claude !== false && { label: "Ask in a Claude thread…", icon: "forum", run: () => act.askClaude(node) },
      ctx.claude !== false && { label: "Make an idea from this", icon: "lightbulb", run: () => act.makeIdea(node) },
    ],
  };
}

/** The Select submenu for the rows at `conns` (and `root`, the root of what is shown, when it is one of them). */
function selectItems(graph, nodes, act, { rows, several }) {
  const kids = nodes.some((n) => graph.childCount(n) > 0);
  return {
    label: "Select",
    icon: "select_all",
    items: [
      kids && {
        label: several ? "Their children" : "Its children",
        shortcut: "Ctrl+Shift+↓",
        run: () => act.select("children"),
      },
      kids && { label: "Everything inside", run: () => act.select("inside") },
      rows && {
        label: several ? "Their parents" : "Its parent",
        shortcut: "Ctrl+Shift+↑",
        run: () => act.select("parents"),
      },
      rows && { label: several ? "Them and their siblings" : "It and its siblings", run: () => act.select("siblings") },
      several && "-",
      several && { label: "Clear the selection", shortcut: "Esc", run: () => act.select("clear") },
    ],
  };
}

/**
 * The menu of `node`, shown through the group conn `group` (none: the root of what is shown). `open`: its children
 * show here; `act`: what the items do, each called with what it needs; `ctx`: the view's looks (`look(node)`,
 * `view`) and which other plugins are there (`pipeline`, `claude`: false when they aren't).
 */
export function nodeMenuItems(graph, { node, group, open = false, root = false, parent: shownIn }, act, ctx = NO_CTX) {
  const n = graph.node(node);
  if (!n) return [];
  const parent = group ? graph.group(group)?.data.from : undefined;
  const siblings = parent ? graph.children(parent) : [];
  const index = group ? siblings.findIndex((c) => c.id === group) : -1;
  const last = parent ? graph.childCount(parent) - 1 : -1;
  const kids = graph.childCount(node);
  const summary = graph.summary(node);
  const proto = !!n.data.prototype;
  const edges = edgesHere(graph, node, parent ?? shownIn);

  return tidy([
    { label: "Edit", icon: "edit", shortcut: "Alt+Enter", run: () => act.edit(node) },
    "-",
    {
      label: "Add inside",
      icon: "subdirectory_arrow_right",
      shortcut: "Ctrl+Enter",
      run: () => act.addInside(node, group),
    },
    group && { label: "Add below", icon: "add", shortcut: "Enter", run: () => act.addBelow(group) },
    { label: "Put an existing node inside…", icon: "input", run: () => act.putInside(node, group) },
    group &&
      kids > 0 && {
        label: open ? "Close" : "Open",
        icon: open ? "unfold_less" : "unfold_more",
        shortcut: "Space",
        run: () => act.toggle(node),
      },
    !root && { label: "Show it as the root", icon: "open_in_full", run: () => act.focusRoot(node) },
    "-",
    proto &&
      ctx.view && {
        label: ctx.look(node)?.proto_open ? "Fold its page away" : "Show its page here",
        icon: "web",
        run: () => act.protoOpen(node, !ctx.look(node)?.proto_open),
      },
    proto && { label: "Open the prototype big", icon: "open_in_new", run: () => act.openPrototypes([node]) },
    selectItems(graph, [node], act, { rows: !!group, several: false }),
    "-",
    { label: summary ? "Edit the summary…" : "Write a summary…", icon: "notes", run: () => act.summary(node) },
    { label: "Summarize with Claude…", icon: "auto_awesome", run: () => act.summarize(node) },
    { label: "Tags", icon: "sell", items: tagItems(graph, [node], act) },
    { label: "Colour", icon: "palette", items: colorItems(graph, [node], act) },
    {
      label: "Order doesn't matter",
      checked: !!n.data.unordered,
      run: () => act.setUnordered(node, !n.data.unordered),
    },
    layoutItems(graph, ctx, [node], act, group ? [node] : []),
    "-",
    { label: "Connect to…", icon: "link", shortcut: "C", run: () => act.connect([node]) },
    edges.length > 0 && {
      label: `Edges (${edges.length})`,
      icon: "share",
      items: edges.map((e) => ({ label: edgeText(graph, e, node), items: edgeItems(graph, e.id, node, parent, act) })),
    },
    group && index > 0 && { label: "Move up", icon: "arrow_upward", shortcut: "Alt+↑", run: () => act.move(group, -1) },
    group &&
      index >= 0 &&
      index < last && {
        label: "Move down",
        icon: "arrow_downward",
        shortcut: "Alt+↓",
        run: () => act.move(group, 1),
      },
    group && { label: "Move to…", icon: "drive_file_move", shortcut: "M", run: () => act.moveTo([group]) },
    { label: "Also in…", icon: "library_add", run: () => act.alsoIn(node, group) },
    "-",
    linkItems(graph, node, act, ctx),
    { label: n.data.image ? "Change the picture…" : "Add a picture…", icon: "image", run: () => act.picture(node) },
    n.data.image && { label: "Remove the picture", icon: "hide_image", run: () => act.removePicture(node) },
    { label: "New view of this node", icon: "add_box", run: () => act.newViewOf(node) },
    { label: "History…", icon: "history", run: () => act.history(node) },
    root && ctx.view && { label: "Rename this view…", icon: "drive_file_rename_outline", run: () => act.renameView() },
    root && ctx.view && { label: "Delete this view…", icon: "delete", run: () => act.deleteView() },
    "-",
    group && {
      label: "Take out of this group",
      icon: "remove_circle_outline",
      shortcut: "Del",
      run: () => act.takeOut([group]),
    },
    { label: "Delete everywhere…", icon: "delete", danger: true, run: () => act.delete(node) },
  ]);
}

/** The menu for several selected rows (`conns`, group conns, in the order they show). */
export function bulkMenuItems(graph, conns, act, ctx = NO_CTX) {
  const nodes = [...new Set(conns.map((c) => graph.group(c)?.data.to).filter(Boolean))];
  const prototypes = nodes.filter((n) => graph.node(n)?.data.prototype);
  return tidy([
    { label: `${conns.length} selected`, disabled: true },
    "-",
    selectItems(graph, nodes, act, { rows: true, several: true }),
    prototypes.length > 1 && {
      label: "Compare side by side",
      icon: "view_column",
      run: () => act.openPrototypes(prototypes),
    },
    "-",
    { label: "Move to…", icon: "drive_file_move", shortcut: "M", run: () => act.moveTo(conns) },
    { label: "Also put in…", icon: "library_add", run: () => act.alsoInMany(conns) },
    { label: "Connect to…", icon: "link", shortcut: "C", run: () => act.connect(nodes) },
    { label: "Tags", icon: "sell", items: tagItems(graph, nodes, act) },
    { label: "Colour", icon: "palette", items: colorItems(graph, nodes, act) },
    layoutItems(graph, ctx, nodes, act),
    "-",
    { label: "Remove…", icon: "delete", shortcut: "Del", danger: true, run: () => act.takeOut(conns) },
  ]);
}
