// Overlap removal for boxes: VPSC, the variable placement with separation constraints solver (Dwyer, Marriott,
// Stuckey, "Fast node overlap removal", 2005). Each box moves as little as possible (least squares) while every pair
// that overlapped ends up apart, first horizontally where that is the shorter way out, then vertically.
//
// Rewritten from WebCola's src/vpsc.ts and src/rectangle.ts (https://github.com/tgdwyer/WebCola):
//   The MIT License (MIT). Copyright (c) 2013 Tim Dwyer.
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
//   copyright notice and this permission notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
//   SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//   OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
// Changes: no variable scales, equality constraints or groups (not needed here); the scan line is a sorted array and
// ties sort by index (WebCola's red-black tree drops boxes with the same centre); a cap on solver rounds.
const LAGRANGIAN_TOLERANCE = -1e-4;
const ZERO_UPPERBOUND = -1e-10;
class Variable {
  desired;
  weight;
  offset = 0;
  block;
  cIn = [];
  cOut = [];
  constructor(desired, weight = 1) {
    this.desired = desired;
    this.weight = weight;
  }
  dfdv() {
    return 2 * this.weight * (this.position() - this.desired);
  }
  position() {
    return this.block.posn + this.offset;
  }
  /** Neighbours by active constraints within the same block, except `prev`. */
  visitNeighbours(prev, f) {
    for (const c of this.cOut) if (c.active && prev !== c.right) f(c, c.right);
    for (const c of this.cIn) if (c.active && prev !== c.left) f(c, c.left);
  }
}
/** `left + gap <= right`. */
class Constraint {
  left;
  right;
  gap;
  lm = 0;
  active = false;
  unsatisfiable = false;
  constructor(left, right, gap) {
    this.left = left;
    this.right = right;
    this.gap = gap;
  }
  slack() {
    return this.unsatisfiable ? Number.MAX_VALUE : this.right.position() - this.gap - this.left.position();
  }
}
/** Variables held at fixed offsets from each other by active constraints, placed together. */
class Block {
  vars = [];
  posn = 0;
  index = 0;
  ab = 0;
  ad = 0;
  a2 = 0;
  constructor(v) {
    v.offset = 0;
    this.add(v);
  }
  stats(v) {
    this.ab += v.weight * v.offset;
    this.ad += v.weight * v.desired;
    this.a2 += v.weight;
  }
  add(v) {
    v.block = this;
    this.vars.push(v);
    this.stats(v);
    this.posn = (this.ad - this.ab) / this.a2;
  }
  /** Move the block where it costs least. */
  updateWeightedPosition() {
    this.ab = this.ad = this.a2 = 0;
    for (const v of this.vars) this.stats(v);
    this.posn = (this.ad - this.ab) / this.a2;
  }
  computeLm(v, u, post) {
    let dfdv = v.dfdv();
    v.visitNeighbours(u, (c, next) => {
      const d = this.computeLm(next, v, post);
      dfdv += d;
      c.lm = next === c.right ? d : -d;
      post(c);
    });
    return dfdv;
  }
  populateSplitBlock(v, prev) {
    v.visitNeighbours(prev, (c, next) => {
      next.offset = v.offset + (next === c.right ? c.gap : -c.gap);
      this.add(next);
      this.populateSplitBlock(next, v);
    });
  }
  /** The active constraint with the smallest Lagrange multiplier: a split candidate when negative. */
  findMinLM() {
    let m = null;
    this.computeLm(this.vars[0], null, (c) => {
      if (m === null || c.lm < m.lm) m = c;
    });
    return m;
  }
  findMinLMBetween(lv, rv) {
    this.computeLm(lv, null, () => {});
    let m = null;
    this.findPath(lv, null, rv, (c, next) => {
      if (c.right === next && (m === null || c.lm < m.lm)) m = c;
    });
    return m;
  }
  findPath(v, prev, to, visit) {
    let found = false;
    v.visitNeighbours(prev, (c, next) => {
      if (!found && (next === to || this.findPath(next, v, to, visit))) {
        found = true;
        visit(c, next);
      }
    });
    return found;
  }
  /** A directed path of active constraints from `u` to `v`. */
  isActiveDirectedPathBetween(u, v) {
    if (u === v) return true;
    for (let i = u.cOut.length - 1; i >= 0; i--) {
      const c = u.cOut[i];
      if (c.active && this.isActiveDirectedPathBetween(c.right, v)) return true;
    }
    return false;
  }
  /** Two blocks, by deactivating `c`. */
  static split(c) {
    c.active = false;
    return [Block.splitBlock(c.left), Block.splitBlock(c.right)];
  }
  static splitBlock(start) {
    const b = new Block(start);
    b.populateSplitBlock(start, null);
    return b;
  }
  /** Split somewhere between two of its variables. */
  splitBetween(vl, vr) {
    const c = this.findMinLMBetween(vl, vr);
    if (!c) return null;
    const [lb, rb] = Block.split(c);
    return { constraint: c, lb, rb };
  }
  mergeAcross(b, c, dist) {
    c.active = true;
    for (const v of b.vars) {
      v.offset += dist;
      this.add(v);
    }
  }
  cost() {
    let sum = 0;
    for (const v of this.vars) {
      const d = v.position() - v.desired;
      sum += d * d * v.weight;
    }
    return sum;
  }
}
class Blocks {
  list = [];
  constructor(vs) {
    for (let n = vs.length - 1; n >= 0; n--) {
      const b = new Block(vs[n]);
      this.list[n] = b;
      b.index = n;
    }
  }
  cost() {
    let sum = 0;
    for (const b of this.list) sum += b.cost();
    return sum;
  }
  insert(b) {
    b.index = this.list.length;
    this.list.push(b);
  }
  remove(b) {
    const last = this.list.length - 1;
    const swap = this.list[last];
    this.list.length = last;
    if (b !== swap) {
      this.list[b.index] = swap;
      swap.index = b.index;
    }
  }
  /** Merge the blocks on both sides of `c`, the smaller into the larger. */
  merge(c) {
    const l = c.left.block;
    const r = c.right.block;
    const dist = c.right.offset - c.left.offset - c.gap;
    if (l.vars.length < r.vars.length) {
      r.mergeAcross(l, c, dist);
      this.remove(l);
    } else {
      l.mergeAcross(r, c, -dist);
      this.remove(r);
    }
  }
  /** Split each block across its constraint with the smallest Lagrange multiplier, if negative. */
  split(inactive) {
    for (const b of this.list) b.updateWeightedPosition();
    // Only the blocks there were at the start, like Array.forEach: new ones are appended, removed ones skipped.
    const n = this.list.length;
    for (let i = 0; i < n && i < this.list.length; i++) {
      const v = this.list[i].findMinLM();
      if (v === null || v.lm >= LAGRANGIAN_TOLERANCE) continue;
      const b = v.left.block;
      for (const nb of Block.split(v)) this.insert(nb);
      this.remove(b);
      inactive.push(v);
    }
  }
}
class Solver {
  vs;
  bs = null;
  inactive;
  constructor(vs, cs) {
    this.vs = vs;
    for (const c of cs) {
      c.left.cOut.push(c);
      c.right.cIn.push(c);
    }
    this.inactive = [...cs];
  }
  mostViolated() {
    let minSlack = Number.MAX_VALUE;
    let v = null;
    const l = this.inactive;
    const n = l.length;
    let deletePoint = n;
    for (let i = 0; i < n; i++) {
      const c = l[i];
      if (c.unsatisfiable) continue;
      const slack = c.slack();
      if (slack < minSlack) {
        minSlack = slack;
        v = c;
        deletePoint = i;
      }
    }
    if (v && deletePoint !== n && minSlack < ZERO_UPPERBOUND && !v.active) {
      l[deletePoint] = l[n - 1];
      l.length = n - 1;
    }
    return v;
  }
  /** Satisfy the constraints by merging blocks over violated ones, splitting where needed. */
  satisfy() {
    if (!this.bs) this.bs = new Blocks(this.vs);
    const bs = this.bs;
    bs.split(this.inactive);
    let v;
    while ((v = this.mostViolated()) && v.slack() < ZERO_UPPERBOUND && !v.active) {
      const lb = v.left.block;
      const rb = v.right.block;
      if (lb !== rb) {
        bs.merge(v);
        continue;
      }
      if (lb.isActiveDirectedPathBetween(v.right, v.left)) {
        v.unsatisfiable = true;
        continue;
      }
      const split = lb.splitBetween(v.left, v.right);
      if (!split) {
        v.unsatisfiable = true;
        continue;
      }
      bs.insert(split.lb);
      bs.insert(split.rb);
      bs.remove(lb);
      this.inactive.push(split.constraint);
      if (v.slack() >= 0) this.inactive.push(v);
      else bs.merge(v);
    }
  }
  /** Build and split blocks until the cost stops falling. */
  solve() {
    this.satisfy();
    let last = Number.MAX_VALUE;
    let cost = this.bs.cost();
    for (let round = 0; round < 100 && Math.abs(last - cost) > 0.0001; round++) {
      this.satisfy();
      last = cost;
      cost = this.bs.cost();
    }
  }
}
// ---------- separation constraints from boxes ----------
/**
 * A box as its edges: `x`..`X` across, `y`..`Y` down.
 * @typedef {{ x: number, X: number, y: number, Y: number }} Box
 */
const cx = (r) => (r.x + r.X) / 2;
const cy = (r) => (r.y + r.Y) / 2;
function overlapX(a, b) {
  const [ua, ub] = [cx(a), cx(b)];
  if (ua <= ub && b.x < a.X) return a.X - b.x;
  if (ub <= ua && a.x < b.X) return b.X - a.x;
  return 0;
}
function overlapY(a, b) {
  const [ua, ub] = [cy(a), cy(b)];
  if (ua <= ub && b.y < a.Y) return a.Y - b.y;
  if (ub <= ua && a.y < b.Y) return b.Y - a.y;
  return 0;
}
const compareNodes = (a, b) => a.pos - b.pos || a.index - b.index;
/** The boxes crossing the sweep line, sorted by centre, then index. */
class ScanLine {
  items = [];
  find(v) {
    let [lo, hi] = [0, this.items.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareNodes(this.items[mid], v) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  insert(v) {
    this.items.splice(this.find(v), 0, v);
  }
  remove(v) {
    this.items.splice(this.find(v), 1);
  }
}
/** Across: neighbours that overlap less across than down (cheaper to separate across), and the first apart. */
function xNeighbours(v, line) {
  const at = line.find(v);
  for (let i = at + 1; i < line.items.length; i++) {
    const u = line.items[i];
    const o = overlapX(u.r, v.r);
    if (o <= 0 || o <= overlapY(u.r, v.r)) {
      v.next.add(u);
      u.prev.add(v);
    }
    if (o <= 0) break;
  }
  for (let i = at - 1; i >= 0; i--) {
    const u = line.items[i];
    const o = overlapX(u.r, v.r);
    if (o <= 0 || o <= overlapY(u.r, v.r)) {
      v.prev.add(u);
      u.next.add(v);
    }
    if (o <= 0) break;
  }
}
/** Down: the next box on each side, if they overlap across. */
function yNeighbours(v, line) {
  const at = line.find(v);
  const next = line.items[at + 1];
  if (next && overlapX(next.r, v.r) > 0) {
    v.next.add(next);
    next.prev.add(v);
  }
  const prev = line.items[at - 1];
  if (prev && overlapX(prev.r, v.r) > 0) {
    v.prev.add(prev);
    prev.next.add(v);
  }
}
const X_AXIS = { centre: cx, open: (r) => r.y, close: (r) => r.Y, size: (r) => r.X - r.x, neighbours: xNeighbours };
const Y_AXIS = { centre: cy, open: (r) => r.x, close: (r) => r.X, size: (r) => r.Y - r.y, neighbours: yNeighbours };
/** Sweep across the boxes and make a separation constraint between each pair of neighbours along `axis`. */
function constraints(rs, vars, axis) {
  const n = rs.length;
  const nodes = rs.map((r, index) => ({
    v: vars[index],
    r,
    pos: axis.centre(r),
    index,
    prev: new Set(),
    next: new Set(),
  }));
  const events = [
    ...nodes.map((v) => ({ open: true, v, pos: axis.open(v.r) })),
    ...nodes.map((v) => ({ open: false, v, pos: axis.close(v.r) })),
  ];
  events.sort((a, b) => a.pos - b.pos || (a.open === b.open ? 0 : a.open ? -1 : 1));
  const cs = [];
  const line = new ScanLine();
  const sep = (l, r) => cs.push(new Constraint(l.v, r.v, (axis.size(l.r) + axis.size(r.r)) / 2 + 1e-6));
  for (let i = 0; i < 2 * n; i++) {
    const { open, v } = events[i];
    if (open) {
      line.insert(v);
      axis.neighbours(v, line);
      continue;
    }
    line.remove(v);
    for (const u of [...v.prev].sort(compareNodes)) {
      sep(u, v);
      u.next.delete(v);
    }
    for (const u of [...v.next].sort(compareNodes)) {
      sep(v, u);
      u.prev.delete(v);
    }
  }
  return cs;
}
/**
 * Move boxes (top left `x`, `y`) apart so that none overlap and `gap` is left between them, each as little as
 * possible. Returns new top lefts.
 */
export function removeOverlaps(rects, gap) {
  const half = gap / 2;
  const rs = rects.map((r) => ({ x: r.x - half, X: r.x + r.w + half, y: r.y - half, Y: r.y + r.h + half }));
  if (rs.length > 1) {
    for (const axis of [X_AXIS, Y_AXIS]) {
      const vs = rs.map((r) => new Variable(axis.centre(r)));
      new Solver(vs, constraints(rs, vs, axis)).solve();
      vs.forEach((v, i) => {
        const r = rs[i];
        const d = v.position() - axis.centre(r);
        if (axis === X_AXIS) [r.x, r.X] = [r.x + d, r.X + d];
        else [r.y, r.Y] = [r.y + d, r.Y + d];
      });
    }
  }
  return rs.map((r) => ({ x: r.x + half, y: r.y + half }));
}
