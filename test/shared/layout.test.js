import assert from "node:assert/strict";
import { describe, expect, it } from "../expect.js";
import { arrange, ARRANGES, MARGIN } from "../../shared/layout/index.js";

/** A repeatable sequence of numbers in [0, 1). */
function numbers(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** `n` boxes of card-like sizes, `m` random edges, plus a few hubs so there are clusters. */
function sample(n, m, seed = 1) {
  const next = numbers(seed);
  const boxes = Array.from({ length: n }, () => ({
    w: 8 * Math.round(10 + next() * 30),
    h: 8 * Math.round(4 + next() * 10),
    x: Math.round(next() * 2000),
    y: Math.round(next() * 2000),
  }));
  const edges = [];
  for (let k = 0; k < m; k++) {
    const a = Math.floor(next() * n);
    const b = next() < 0.5 ? Math.floor(next() * Math.min(n, 20)) : Math.floor(next() * n);
    edges.push([a, b]);
  }
  return { boxes, edges };
}

function overlaps(boxes, at) {
  const found = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, b, p, q] = [boxes[i], boxes[j], at[i], at[j]];
      // 1px of slack for rounding.
      if (p.x + a.w - 1 > q.x && q.x + b.w - 1 > p.x && p.y + a.h - 1 > q.y && q.y + b.h - 1 > p.y) found.push([i, j]);
    }
  }
  return found;
}

const input = (arrange, n, m, useOrder, seed = 1) => ({ arrange, useOrder, ...sample(n, m, seed) });

describe("automatic layouts", () => {
  for (const kind of ARRANGES) {
    for (const useOrder of [false, true]) {
      it(`${kind}${useOrder ? " in order" : ""}: no overlaps, inside the margin, whole pixels`, () => {
        const job = input(kind, 120, 140, useOrder);
        const at = arrange(job);
        expect(at).toHaveLength(120);
        expect(overlaps(job.boxes, at)).toEqual([]);
        for (const p of at) {
          expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
          assert.ok(p.x >= MARGIN, `expected ${p.x} >= ${MARGIN}`);
          assert.ok(p.y >= MARGIN, `expected ${p.y} >= ${MARGIN}`);
        }
      });
    }

    it(`${kind}: the same input always gives the same positions`, () => {
      const a = arrange(input(kind, 200, 260, true, 7));
      const b = arrange(input(kind, 200, 260, true, 7));
      expect(a).toEqual(b);
    });

    it(`${kind}: handles nothing, one box and two boxes on one spot`, () => {
      expect(arrange({ arrange: kind, boxes: [], edges: [], useOrder: true })).toEqual([]);
      expect(arrange({ arrange: kind, boxes: [{ w: 80, h: 40, x: 0, y: 0 }], edges: [], useOrder: true })).toHaveLength(1);
      const two = [
        { w: 80, h: 40, x: 50, y: 50 },
        { w: 80, h: 40, x: 50, y: 50 },
      ];
      const at = arrange({ arrange: kind, boxes: two, edges: [[0, 1]], useOrder: false });
      expect(overlaps(two, at)).toEqual([]);
    });
  }

  it("tidy moves boxes only as far as needed", () => {
    const boxes = [
      { w: 100, h: 40, x: 100, y: 100 },
      { w: 100, h: 40, x: 180, y: 100 },
      { w: 100, h: 40, x: 600, y: 600 },
    ];
    const at = arrange({ arrange: "tidy", boxes, edges: [], useOrder: false, gap: 20 });
    expect(at[2]).toEqual({ x: 600, y: 600 });
    assert.ok(at[1].x - at[0].x >= 120, `expected ${at[1].x - at[0].x} >= 120`);
    expect(at[0].y).toBe(100);
  });

  it("rows in order read left to right, top to bottom", () => {
    const boxes = Array.from({ length: 9 }, () => ({ w: 100, h: 40, x: 0, y: 0 }));
    const at = arrange({ arrange: "rows", boxes, edges: [], useOrder: true });
    for (let i = 1; i < at.length; i++) {
      const [a, b] = [at[i - 1], at[i]];
      expect(b.y > a.y || (b.y === a.y && b.x > a.x)).toBe(true);
    }
  });

  it("columns: one row in order, tops aligned, edges ignored", () => {
    const boxes = [
      { w: 100, h: 40, x: 0, y: 300 },
      { w: 60, h: 200, x: 0, y: 0 },
      { w: 80, h: 90, x: 500, y: 0 },
    ];
    const at = arrange({ arrange: "columns", boxes, edges: [[2, 0]], useOrder: false, gap: 20 });
    expect(at).toEqual([
      { x: MARGIN, y: MARGIN },
      { x: MARGIN + 120, y: MARGIN },
      { x: MARGIN + 200, y: MARGIN },
    ]);
  });

  it("flow puts an edge's target below its source", () => {
    const boxes = Array.from({ length: 4 }, () => ({ w: 100, h: 40, x: 0, y: 0 }));
    const edges = [
      [0, 1],
      [1, 2],
      [0, 3],
    ];
    const down = arrange({ arrange: "flow-down", boxes, edges, useOrder: false });
    for (const [a, b] of edges) expect(down[b].y).toBeGreaterThan(down[a].y);
    const right = arrange({ arrange: "flow-right", boxes, edges, useOrder: false });
    for (const [a, b] of edges) expect(right[b].x).toBeGreaterThan(right[a].x);
  });

  it("flow survives cycles", () => {
    const boxes = Array.from({ length: 5 }, () => ({ w: 60, h: 30, x: 0, y: 0 }));
    const edges = [
      [0, 1],
      [1, 2],
      [2, 0],
      [2, 3],
      [3, 4],
      [4, 2],
    ];
    const at = arrange({ arrange: "flow-down", boxes, edges, useOrder: false });
    expect(overlaps(boxes, at)).toEqual([]);
  });

  it("organic keeps linked boxes nearer than unlinked ones", () => {
    const boxes = Array.from({ length: 20 }, () => ({ w: 80, h: 40, x: 0, y: 0 }));
    // Two rings of ten, joined by one edge.
    const edges = [];
    for (let i = 0; i < 10; i++) edges.push([i, (i + 1) % 10], [10 + i, 10 + ((i + 1) % 10)]);
    edges.push([0, 10]);
    const at = arrange({ arrange: "organic", boxes, edges, useOrder: false });
    const centre = (from) => {
      let [x, y] = [0, 0];
      for (let i = from; i < from + 10; i++) [x, y] = [x + at[i].x / 10, y + at[i].y / 10];
      return { x, y };
    };
    const [a, b] = [centre(0), centre(10)];
    const spread = Math.max(...at.slice(0, 10).map((p) => Math.hypot(p.x - a.x, p.y - a.y)));
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(spread);
  });

  it("1000 boxes: every layout is fast enough for a worker", { timeout: 60_000 }, () => {
    const times = {};
    for (const kind of ARRANGES) {
      const job = input(kind, 1000, 1200, kind !== "organic");
      const start = performance.now();
      const at = arrange(job);
      times[kind] = Math.round(performance.now() - start);
      expect(overlaps(job.boxes, at)).toEqual([]);
    }
    console.log("layout times for 1000 boxes (ms):", times);
    for (const ms of Object.values(times)) expect(ms).toBeLessThan(5000);
  });
});
