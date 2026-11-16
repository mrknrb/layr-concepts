import { describe, expect, it } from "./expect.js";
import { Graph } from "../shared/graph.js";
import { nodeMenuItems, tidy } from "../panels/nodemenu.js";

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
  const act = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
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
    expect(items[1]).toBe("-");
    items[0].run();
    expect(calls).toEqual([["edit", "b"]]);
  });
  it("has a row's actions in groups, with their keys, and no separators at the ends or twice", () => {
    const items = nodeMenuItems(sample(), { node: "b", group: "gb" }, recorder().act);
    expect(labels(items)).toEqual([
      "Edit",
      "-",
      "Add inside",
      "Add below",
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
      "Add a picture…",
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
    expect(labels(tags.items)).toEqual(["Status", "Loose", "-", "New tag…"]);
    const status = tags.items[0].items;
    expect(status.map((t) => [t.label, t.checked])).toEqual([
      ["Tried", true],
      ["Wish", false],
    ]);
    status[0].run();
    status[1].run();
    tags.items[3].run();
    expect(calls).toEqual([
      ["setTag", "a", "t1", false],
      ["setTag", "a", "t2", true],
      ["newTag", "a"],
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
      ["setColor", "b", null],
    ]);
  });
  it("calls each row action with its node or group", () => {
    const { act, calls } = recorder();
    const items = nodeMenuItems(sample(), { node: "b", group: "gb" }, act);
    const picked = ["Add inside", "Add below", "Move up", "Move to…", "Take out of this group", "Delete everywhere…"];
    for (const label of picked) find(items, label).run();
    expect(calls).toEqual([
      ["addInside", "b", "gb"],
      ["addBelow", "gb"],
      ["move", "gb", -1],
      ["moveTo", "gb"],
      ["takeOut", "gb"],
      ["delete", "b"],
    ]);
  });
  it("is empty for a node that isn't loaded", () => {
    expect(nodeMenuItems(sample(), { node: "nope" }, recorder().act)).toEqual([]);
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
