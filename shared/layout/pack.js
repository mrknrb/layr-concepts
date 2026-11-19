// Layouts that only fill space: tight packing, rows like text, a grid of columns and rows, one row of columns.
/** How much wider than tall the rows and grid layouts aim to be. */
const ASPECT = 1.6;
/**
 * Pack boxes into a near-square area, tallest first, each into the smallest free space it fits. Returns top lefts.
 *
 * Rewritten from potpack (https://github.com/mapbox/potpack): ISC License, Copyright (c) 2025, Mapbox. Permission to
 * use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided
 * that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS"
 * AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR
 * CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 * Changes: boxes keep their place in the input (positions come back by index), `gap` between them, and the area aims
 * at `ASPECT` instead of a square.
 */
export function pack(boxes, gap) {
  const out = boxes.map(() => ({ x: 0, y: 0 }));
  let area = 0;
  let maxWidth = 0;
  for (const b of boxes) {
    area += (b.w + gap) * (b.h + gap);
    maxWidth = Math.max(maxWidth, b.w + gap);
  }
  const order = [...boxes.keys()].sort((a, b) => boxes[b].h - boxes[a].h);
  const startWidth = Math.max(Math.ceil(Math.sqrt((area * ASPECT) / 0.95)), maxWidth);
  const spaces = [{ x: 0, y: 0, w: startWidth, h: Infinity }];
  for (const index of order) {
    const box = { w: boxes[index].w + gap, h: boxes[index].h + gap };
    // Smaller spaces first: they are at the end.
    for (let i = spaces.length - 1; i >= 0; i--) {
      const space = spaces[i];
      if (box.w > space.w || box.h > space.h) continue;
      out[index] = { x: space.x, y: space.y };
      if (box.w === space.w && box.h === space.h) {
        const last = spaces.pop();
        if (i < spaces.length) spaces[i] = last;
      } else if (box.h === space.h) {
        space.x += box.w;
        space.w -= box.w;
      } else if (box.w === space.w) {
        space.y += box.h;
        space.h -= box.h;
      } else {
        spaces.push({ x: space.x + box.w, y: space.y, w: space.w - box.w, h: box.h });
        space.y += box.h;
        space.h -= box.h;
      }
      break;
    }
  }
  return out;
}
/** Left to right in `order`, a new row when the next box doesn't fit the width. Rows are as tall as their tallest. */
export function rows(boxes, order, gap) {
  const out = boxes.map(() => ({ x: 0, y: 0 }));
  let area = 0;
  let widest = 0;
  for (const b of boxes) {
    area += (b.w + gap) * (b.h + gap);
    widest = Math.max(widest, b.w);
  }
  const width = Math.max(widest, Math.sqrt(area * ASPECT));
  let [x, y, height] = [0, 0, 0];
  for (const i of order) {
    const b = boxes[i];
    if (x > 0 && x + b.w > width) [x, y, height] = [0, y + height + gap, 0];
    out[i] = { x, y };
    x += b.w + gap;
    height = Math.max(height, b.h);
  }
  return out;
}
/** Columns and rows in `order`, row by row: each column as wide as its widest box, each row as tall as its tallest. */
export function grid(boxes, order, gap) {
  const n = boxes.length;
  let [sw, sh] = [0, 0];
  for (const b of boxes) [sw, sh] = [sw + b.w, sh + b.h];
  const cols = Math.min(n, Math.max(1, Math.round(Math.sqrt((n * ASPECT * sh) / Math.max(1, sw)))));
  const colWidth = new Array(cols).fill(0);
  const rowHeight = new Array(Math.ceil(n / cols)).fill(0);
  order.forEach((i, k) => {
    colWidth[k % cols] = Math.max(colWidth[k % cols], boxes[i].w);
    rowHeight[Math.floor(k / cols)] = Math.max(rowHeight[Math.floor(k / cols)], boxes[i].h);
  });
  const colX = [0];
  for (let c = 1; c < cols; c++) colX.push(colX[c - 1] + colWidth[c - 1] + gap);
  const rowY = [0];
  for (let r = 1; r < rowHeight.length; r++) rowY.push(rowY[r - 1] + rowHeight[r - 1] + gap);
  const out = boxes.map(() => ({ x: 0, y: 0 }));
  order.forEach((i, k) => (out[i] = { x: colX[k % cols], y: rowY[Math.floor(k / cols)] }));
  return out;
}
/** All in one row, left to right in the group's order, tops aligned: each box a column. */
export function columns(boxes, gap) {
  let x = 0;
  return boxes.map((b) => {
    const at = { x, y: 0 };
    x += b.w + gap;
    return at;
  });
}
