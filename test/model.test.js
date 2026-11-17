import { describe, expect, it } from "./expect.js";
import { Graph } from "../shared/graph.js";
import {
  acceptMove,
  areaSize,
  clickSelect,
  dimmed,
  edgeText,
  extendSelection,
  fitAll,
  isTypeBadge,
  nextZoom,
  segment,
  shiftOrder,
  sortTypes,
  step,
  zoomAt,
} from "../panels/model.js";

const at = "2026-01-01T00:00:00Z";
/** p holds a and b; a holds x. "is a" is an edge type; a is a B. */
function sample() {
  const graph = new Graph();
  for (const id of ["p", "a", "b", "x"]) graph.setNode({ id, data: { text: id.toUpperCase() }, created_at: at });
  graph.setNode({ id: "isa", data: { text: "is a" }, created_at: at });
  const group = (id, from, to, pos) => graph.setConn({ id, data: { type: "group", from, to, pos }, created_at: at });
  group("ga", "p", "a", "a0");
  group("gb", "p", "b", "a1");
  group("gx", "a", "x", "a0");
  graph.setConn({ id: "e1", data: { type: "edge", from: "a", to: "b", relation: "isa" }, created_at: at });
  graph.setConn({ id: "e2", data: { type: "edge", from: "x", to: "a", label: "part of" }, created_at: at });
  return graph;
}

describe("selecting rows", () => {
  const rows = ["r1", "r2", "r3", "r4"];
  it("adds a row with Ctrl+click and takes it off again", () => {
    expect(clickSelect([], rows, null, "r2", false)).toEqual({ selection: ["r2"], anchor: "r2" });
    expect(clickSelect(["r2", "r4"], rows, "r2", "r2", false)).toEqual({ selection: ["r4"], anchor: "r2" });
  });
  it("selects the rows from the anchor with Shift+click, either way", () => {
    expect(clickSelect(["r1"], rows, "r1", "r3", true).selection).toEqual(["r1", "r2", "r3"]);
    expect(clickSelect([], rows, "r4", "r2", true).selection).toEqual(["r2", "r3", "r4"]);
  });
  it("grows the selection with Shift+↑↓ from the anchor, and stops at the ends", () => {
    expect(extendSelection(rows, "r2", "r2", 1)).toEqual({ selection: ["r2", "r3"], cursor: "r3", anchor: "r2" });
    expect(extendSelection(rows, "r2", "r3", -1)).toEqual({ selection: ["r2"], cursor: "r2", anchor: "r2" });
    expect(extendSelection(rows, "r1", "r1", -1)).toBe(null);
  });
});

describe("edges as rows show them", () => {
  it("shows 'is a' edges without a label as a type badge", () => {
    const graph = sample();
    expect(isTypeBadge(graph, graph.edge("e1"), "a")).toBe(true);
    expect(isTypeBadge(graph, graph.edge("e1"), "b")).toBe(false);
    expect(isTypeBadge(graph, graph.edge("e2"), "x")).toBe(false);
  });
  it("words an edge from either end, the arrow pointing at its target", () => {
    const graph = sample();
    expect(edgeText(graph, graph.edge("e1"), "a")).toBe("is a → B");
    expect(edgeText(graph, graph.edge("e1"), "b")).toBe("A is a →");
    expect(edgeText(graph, graph.edge("e2"), "x")).toBe("part of → A");
  });
  it("puts the type used last first", () => {
    const types = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
    expect(sortTypes(types, "t3").map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
    expect(sortTypes(types, null).map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("where dragged rows may go", () => {
  it("not into themselves, what is inside them, or the group they are all in", () => {
    const graph = sample();
    expect(acceptMove(graph, ["gb"], { kind: "into", node: "a" })).toBe(true);
    expect(acceptMove(graph, ["ga"], { kind: "into", node: "a" })).toBe(false);
    expect(acceptMove(graph, ["ga"], { kind: "into", node: "x" })).toBe(false);
    expect(acceptMove(graph, ["ga", "gb"], { kind: "into", node: "p" })).toBe(false);
    expect(acceptMove(graph, ["ga"], { kind: "gap", parent: "p", index: 2 })).toBe(true);
    expect(acceptMove(graph, ["gx"], { kind: "free", parent: "p" })).toBe(true);
  });
});

describe("tags", () => {
  it("dims nodes without any of the tags filtered by", () => {
    const graph = sample();
    graph.setNodeTag({ id: "nt", node: "a", tag: "t1" });
    expect(dimmed(graph, "a", ["t1"])).toBe(false);
    expect(dimmed(graph, "b", ["t1"])).toBe(true);
    expect(dimmed(graph, "b", [])).toBe(false);
  });
  it("moves a tag one place, writing only the places that change", () => {
    const list = [
      { id: "a", pos: 1 },
      { id: "b", pos: 2 },
      { id: "c", pos: 3 },
    ];
    expect(shiftOrder(list, "c", -1)).toEqual([
      ["c", 2],
      ["b", 3],
    ]);
    expect(shiftOrder(list, "a", -1)).toEqual([]);
  });
});

describe("free layouts and prototypes", () => {
  it("measures boxes to multiples of 8", () => {
    expect(step(1)).toBe(8);
    expect(step(16)).toBe(16);
    expect(step(17)).toBe(24);
  });
  it("draws a line from border to border, aimed at the centres", () => {
    const s = segment({ x: 0, y: 0, w: 100, h: 20 }, { x: 200, y: 0, w: 100, h: 20 });
    expect(s).toEqual({ a: { x: 100, y: 10 }, b: { x: 200, y: 10 } });
  });
  it("is big enough for every box", () => {
    expect(areaSize([{ x: 10, y: 10, w: 500, h: 300 }])).toEqual({ w: 526, h: 326 });
    expect(areaSize([])).toEqual({ w: 320, h: 160 });
  });
  it("zooms at a point, keeping it where it is, and fits everything", () => {
    const z = zoomAt({ x: 0, y: 0, zoom: 1 }, 2, 100, 50);
    expect(z).toEqual({ x: -100, y: -50, zoom: 2 });
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 9, 0, 0).zoom).toBe(2);
    expect(fitAll(2000, 1000, 1000, 1000)).toEqual({ zoom: 0.5, x: 0, y: 250 });
    expect(fitAll(100, 100, 1000, 1000).zoom).toBe(1);
  });
  it("steps a prototype's zoom through browser-like levels, 25 to 300", () => {
    expect(nextZoom(100, 1)).toBe(110);
    expect(nextZoom(100, -1)).toBe(90);
    expect(nextZoom(105, -1)).toBe(100);
    expect(nextZoom(300, 1)).toBe(300);
    expect(nextZoom(25, -1)).toBe(25);
  });
});
