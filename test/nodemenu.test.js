import { describe, expect, it } from "./expect.js";
import { Graph } from "../shared/graph.js";
import { bulkMenuItems, edgeItems, nodeMenuItems, tagPillItems, tidy } from "../panels/nodemenu.js";

const at = "2026-01-01T00:00:00Z";
/** p holds a, b, c (in that order); a holds x; a has the tag "Tried" of the set "Status"; c has a picture. */
function sample() {
  const graph = new Graph();
  for (const id of ["p", "a", "b", "c", "x"]) graph.setNode({ id, data: { text: id.toUpperCase() }, created_at: at });
  graph.node("c").data.image = true;
  const group = (id, from, to, pos) => graph.setConn({ id, data: { type: "group", from, to, pos }, created_at: at });
  group("ga", "p", "a", "a0");
  group("gb", "p", "b", "a1");
  group("gc", "p", "c", "a2");
  group("gx", "a", "x", "a0");
  graph.setTagSet({ id: "s", name: "Status", pos: 0, created_at: at });
  graph.setTag({ id: "t1", name: "Tried", tag_set: "s", pos: 0, created_at: at });
  graph.setTag({ id: "t2", name: "Wish", tag_set: "s", pos: 1, created_at: at });
  graph.setTag({ id: "t3", name: "Loose", tag_set: null, pos: 0, created_at: at });
  graph.setNodeTag({ id: "nt1", node: "a", tag: "t1" });
  return graph;
}
/** What the items do, recorded: each action's name and arguments. */
function recorder() {
  const calls = [];
  const act = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
    },
  );
  return { act, calls };
}
const labels = (items) => items.map((i) => (i === "-" ? "-" : i.label));
const find = (items, label) => items.find((i) => i !== "-" && i.label === label);

describe("a node's context menu", () => {
  it("starts with Edit, which opens the node's details", () => {
    const { act, calls } = recorder();
    const items = nodeMenuItems(sample(), { node: "b", group: "gb" }, act);
    expect(items[0].label).toBe("Edit");
    expect(items[0].icon).toBe("edit");
    expect(items[2]).toBe("-");
    items[0].run();
    expect(calls).toEqual([["edit", "b"]]);
  });
  it("has a row's actions in groups, with their keys, and no separators at the ends or twice", () => {
    const items = nodeMenuItems(sample(), { node: "b", group: "gb" }, recorder().act);
    expect(labels(items)).toEqual([
      "Edit",
      "Copy link",
      "-",
      "Add inside",
      "Add below",
      "Put an existing node inside…",
      "Show it as the root",
      "-",
      "Select",
      "-",
      "Write a summary…",
      "Summarize with Claude…",
      "Tags",
      "Colour",
      "Order doesn't matter",
      "-",
      "Connect to…",
      "Move up",
      "Move down",
      "Move to…",
      "Also in…",
      "-",
      "Links",
      "Add a picture…",
      "New view of this node",
      "History…",
      "-",
      "Take out of this group",
      "Delete everywhere…",
    ]);
    expect(find(items, "Add below").shortcut).toBe("Enter");
    expect(find(items, "Move up").shortcut).toBe("Alt+↑");
    expect(find(items, "Delete everywhere…").danger).toBe(true);
  });
  it("offers only the moves there is room for, and open or close for a node with children", () => {
    const graph = sample();
    const first = nodeMenuItems(graph, { node: "a", group: "ga", open: false }, recorder().act);
    expect(find(first, "Move up")).toBe(undefined);
    expect(find(first, "Move down").label).toBe("Move down");
    expect(find(first, "Open").shortcut).toBe("Space");
    expect(find(first, "Show it as the root").label).toBe("Show it as the root");
    const opened = nodeMenuItems(graph, { node: "a", group: "ga", open: true }, recorder().act);
    expect(find(opened, "Close").label).toBe("Close");
    const last = nodeMenuItems(graph, { node: "c", group: "gc" }, recorder().act);
    expect(find(last, "Move down")).toBe(undefined);
    expect(find(last, "Change the picture…").label).toBe("Change the picture…");
    expect(find(last, "Remove the picture").label).toBe("Remove the picture");
  });
  it("leaves out what needs a group for the root of what is shown", () => {
    const items = nodeMenuItems(sample(), { node: "p", root: true }, recorder().act);
    for (const label of ["Add below", "Move up", "Move down", "Move to…", "Take out of this group", "Open"]) {
      expect(find(items, label)).toBe(undefined);
    }
    expect(find(items, "Show it as the root")).toBe(undefined);
    expect(find(items, "Add inside").label).toBe("Add inside");
  });
  it("has the tags in a submenu, a set as a nested submenu, ticked where the node has them", () => {
    const { act, calls } = recorder();
    const tags = find(nodeMenuItems(sample(), { node: "a", group: "ga" }, act), "Tags");
    expect(labels(tags.items)).toEqual(["Status", "Loose", "-", "New tag…", "Manage tags…"]);
    const status = tags.items[0].items;
    expect(status.map((t) => [t.label, t.checked])).toEqual([
      ["Tried", true],
      ["Wish", false],
    ]);
    status[0].run();
    status[1].run();
    tags.items[3].run();
    tags.items[4].run();
    expect(calls).toEqual([
      ["setTag", ["a"], "t1", false],
      ["setTag", ["a"], "t2", true],
      ["newTag", ["a"]],
      ["manageTags"],
    ]);
  });
  it("ticks the node's colour and order setting", () => {
    const graph = sample();
    graph.node("b").data.color = "green";
    graph.node("b").data.unordered = true;
    const { act, calls } = recorder();
    const items = nodeMenuItems(graph, { node: "b", group: "gb" }, act);
    const colours = find(items, "Colour").items;
    expect(colours.filter((c) => c !== "-" && c.checked).map((c) => c.label)).toEqual(["Green"]);
    expect(find(items, "Order doesn't matter").checked).toBe(true);
    find(items, "Order doesn't matter").run();
    colours[0].run();
    expect(calls).toEqual([
      ["setUnordered", "b", false],
      ["setColor", ["b"], null],
    ]);
  });
  it("calls each row action with its node or group", () => {
    const { act, calls } = recorder();
    const items = nodeMenuItems(sample(), { node: "b", group: "gb" }, act);
    const picked = ["Add inside", "Add below", "Move up", "Move to…", "Take out of this group", "Delete everywhere…"];
    for (const label of picked) find(items, label).run();
    find(items, "Connect to…").run();
    expect(calls).toEqual([
      ["addInside", "b", "gb"],
      ["addBelow", "gb"],
      ["move", "gb", -1],
      ["moveTo", ["gb"]],
      ["takeOut", ["gb"]],
      ["delete", "b"],
      ["connect", ["b"]],
    ]);
  });
  it("is empty for a node that isn't loaded", () => {
    expect(nodeMenuItems(sample(), { node: "nope" }, recorder().act)).toEqual([]);
  });
  it("selects its children, everything inside, its parent or its siblings", () => {
    const { act, calls } = recorder();
    const select = find(nodeMenuItems(sample(), { node: "a", group: "ga" }, act), "Select");
    expect(labels(select.items)).toEqual(["Its children", "Everything inside", "Its parent", "It and its siblings"]);
    for (const item of select.items) item.run();
    expect(calls.map((c) => c[1])).toEqual(["children", "inside", "parents", "siblings"]);
    // A node without children, shown as the root: nothing to select.
    expect(find(nodeMenuItems(sample(), { node: "b", root: true }, act), "Select")).toBe(undefined);
  });
  it("has Copy link at the top, right under Edit", () => {
    const { act, calls } = recorder();
    const items = nodeMenuItems(sample(), { node: "b", group: "gb" }, act);
    expect(labels(items).slice(0, 2)).toEqual(["Edit", "Copy link"]);
    items[1].run();
    expect(calls).toEqual([["copyLink", "b"]]);
  });
  it("has the link actions, without the pipeline's and Claude's when they aren't there", () => {
    const { act, calls } = recorder();
    const ctx = { look: () => undefined, view: true };
    const links = find(nodeMenuItems(sample(), { node: "b", group: "gb" }, act, ctx), "Links");
    expect(labels(links.items)).toEqual([
      "Send to the pipeline as a task…",
      "Link a pipeline task…",
      "Unlink…",
      "-",
      "Ask in a thread…",
      "Make an idea from this",
    ]);
    for (const item of links.items) if (item !== "-") item.run();
    expect(calls.map((c) => c[0])).toEqual([
      "sendToPipeline",
      "linkTask",
      "unlink",
      "askClaude",
      "makeIdea",
    ]);
    const bare = find(nodeMenuItems(sample(), { node: "b" }, act, { ...ctx, pipeline: false, claude: false }), "Links");
    expect(labels(bare.items)).toEqual(["Unlink…"]);
  });
  it("offers a prototype's page, folded or not, and its links", () => {
    const graph = sample();
    graph.node("b").data.prototype = true;
    const { act, calls } = recorder();
    const ctx = { look: (n) => (n === "b" ? { proto_open: true } : undefined), view: true };
    const items = nodeMenuItems(graph, { node: "b", group: "gb" }, act, ctx);
    find(items, "Fold its page away").run();
    find(items, "Open the prototype big").run();
    expect(labels(items).slice(1, 3)).toEqual(["Copy the prototype link", "Copy the node link"]);
    expect(calls).toEqual([
      ["protoOpen", "b", false],
      ["openPrototypes", ["b"]],
    ]);
  });
});

describe("the Layout submenu", () => {
  const ctxWith = (looks) => ({ look: (n) => looks[n], view: true });
  it("ticks the layout the node's children have in this view, and changes it", () => {
    const { act, calls } = recorder();
    const layout = find(nodeMenuItems(sample(), { node: "a", group: "ga" }, act, ctxWith({})), "Layout");
    expect(labels(layout.items).slice(0, 3)).toEqual(["↓ Vertical", "→ Horizontal", "✥ Free"]);
    expect(layout.items[0].checked).toBe(true);
    layout.items[2].run();
    expect(calls).toEqual([["setLayout", ["a"], "free"]]);
    expect(find(layout.items, "Open everything inside").shortcut).toBe("Alt+click ▸");
  });
  it("has the arrangements, once, order and size for a free layout", () => {
    const { act, calls } = recorder();
    const looks = { a: { layout: "free", arrange: "organic", overflow: "grow" } };
    const layout = find(nodeMenuItems(sample(), { node: "a", group: "ga" }, act, ctxWith(looks)), "Layout");
    const arrange = find(layout.items, "Arrange");
    expect(labels(arrange.items)).toEqual([
      "By hand",
      "-",
      "Tidy",
      "Organic",
      "Flow ↓",
      "Flow →",
      "Rows",
      "Grid",
      "Pack",
      "Columns",
      "-",
      "Once, then by hand",
      "Order counts",
    ]);
    expect(find(arrange.items, "Organic").checked).toBe(true);
    expect(find(arrange.items, "Order counts").checked).toBe(true);
    find(arrange.items, "By hand").run();
    find(arrange.items, "Once, then by hand").items[0].run();
    find(arrange.items, "Order counts").run();
    const size = find(layout.items, "Size");
    expect(size.items.map((i) => [i.label, i.checked])).toEqual([
      ["Scroll area", false],
      ["Grow to fit", true],
    ]);
    size.items[0].run();
    expect(calls).toEqual([
      ["arrange", ["a"], null],
      ["arrangeOnce", ["a"], "tidy"],
      ["useOrder", ["a"], false],
      ["overflow", ["a"], null],
    ]);
  });
  it("leaves out the free layout's settings for other layouts, and everything without a view", () => {
    const items = nodeMenuItems(sample(), { node: "a", group: "ga" }, recorder().act, ctxWith({}));
    expect(find(find(items, "Layout").items, "Arrange")).toBe(undefined);
    expect(find(nodeMenuItems(sample(), { node: "a", group: "ga" }, recorder().act), "Layout")).toBe(undefined);
  });
});

describe("the menu for several rows", () => {
  it("acts on all of them: select, move, also put in, connect, tags, colour, remove", () => {
    const graph = sample();
    graph.node("a").data.prototype = true;
    graph.node("b").data.prototype = true;
    const { act, calls } = recorder();
    const items = bulkMenuItems(graph, ["ga", "gb"], act, { look: () => undefined, view: true });
    expect(labels(items)).toEqual([
      "2 selected",
      "-",
      "Select",
      "Compare side by side",
      "-",
      "Move to…",
      "Also put in…",
      "Connect to…",
      "Tags",
      "Colour",
      "Layout",
      "-",
      "Remove…",
    ]);
    for (const label of ["Compare side by side", "Move to…", "Also put in…", "Connect to…", "Remove…"]) {
      find(items, label).run();
    }
    find(items, "Tags")
      .items.find((t) => t.label === "Loose")
      .run();
    expect(calls).toEqual([
      ["openPrototypes", ["a", "b"]],
      ["moveTo", ["ga", "gb"]],
      ["alsoInMany", ["ga", "gb"]],
      ["connect", ["a", "b"]],
      ["takeOut", ["ga", "gb"]],
      ["setTag", ["a", "b"], "t3", true],
    ]);
  });
  it("ticks a tag only when all of them have it, and picking it then takes it off them all", () => {
    const graph = sample();
    graph.setNodeTag({ id: "nt2", node: "b", tag: "t1" });
    const { act, calls } = recorder();
    const status = find(bulkMenuItems(graph, ["ga", "gb"], act), "Tags").items[0].items;
    expect(status[0].checked).toBe(true);
    status[0].run();
    expect(calls).toEqual([["setTag", ["a", "b"], "t1", false]]);
  });
});

describe("an edge's menu", () => {
  function withEdge() {
    const graph = sample();
    graph.setNode({ id: "isa", data: { text: "is a" }, created_at: at });
    graph.setConn({ id: "e1", data: { type: "edge", from: "a", to: "b", label: "often" }, created_at: at });
    graph.setConn({ id: "e2", data: { type: "edge", from: "a", to: "c", in: "p" }, created_at: at });
    return graph;
  }
  it("shows the other end, edits the label, changes the type, holds only here or everywhere, deletes", () => {
    const { act, calls } = recorder();
    const items = edgeItems(withEdge(), "e1", "a", "p", act);
    expect(labels(items)).toEqual([
      'Show "B"',
      "Edit the label",
      "Change its type…",
      'Hold only in "P"',
      "-",
      "Delete the edge",
    ]);
    for (const item of items) if (item !== "-") item.run();
    expect(calls).toEqual([
      ["show", "b"],
      ["editLabel", "e1"],
      ["changeType", "e1"],
      ["holdIn", "e1", "p"],
      ["deleteEdge", "e1"],
    ]);
    const only = edgeItems(withEdge(), "e2", "c", "p", act);
    expect(find(only, "Hold everywhere").shortcut).toBe("now only in P");
  });
  it("lists a node's edges in its menu, each with its own menu", () => {
    const items = nodeMenuItems(withEdge(), { node: "a", group: "ga" }, recorder().act);
    const edges = find(items, "Edges (2)");
    expect(labels(edges.items)).toEqual(["often → B", "→ C"]);
    expect(labels(edges.items[0].items)[0]).toBe('Show "B"');
  });
});

describe("a tag pill's menu", () => {
  it("switches within a one-per-node set, takes it off, filters by it, colours and edits it", () => {
    const graph = sample();
    graph.tagSets.get("s").single = true;
    const { act, calls } = recorder();
    const items = tagPillItems(graph, "a", "t1", [], act);
    expect(labels(items)).toEqual([
      "Change to Wish",
      "-",
      "Take Tried off",
      "Show only nodes tagged Tried",
      "-",
      "Colour of Tried",
      "Edit the tag Tried…",
    ]);
    items[0].run();
    find(items, "Take Tried off").run();
    find(items, "Show only nodes tagged Tried").run();
    find(items, "Colour of Tried")
      .items.find((c) => c.label === "Blue")
      .run();
    find(items, "Edit the tag Tried…").run();
    expect(calls).toEqual([
      ["setTag", ["a"], "t2", true],
      ["setTag", ["a"], "t1", false],
      ["filter", ["t1"]],
      ["tagColor", "t1", "blue"],
      ["manageTags", "t1"],
    ]);
    const filtered = tagPillItems(graph, "a", "t1", ["t1", "t3"], act);
    expect(find(filtered, "Stop showing only Tried").checked).toBe(true);
  });
});

describe("tidy", () => {
  it("drops left-out items, empty submenus and extra separators", () => {
    const a = { label: "A" };
    const b = { label: "B" };
    expect(tidy(["-", a, false, "-", null, "-", { label: "Sub", items: [false, "-"] }, b, "-"])).toEqual([a, "-", b]);
    expect(tidy([{ label: "Sub", items: ["-", a, "-"] }])).toEqual([{ label: "Sub", items: [a] }]);
  });
});
