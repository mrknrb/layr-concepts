// Automatic layouts for a group laid out freely (docs/concepts/LAYOUTS.md). Pure functions of their input: the same
// boxes, edges and settings always give the same positions, so generated positions are never saved.
/** How a free layout places its children. Manual (none of these) is where they were dragged. */
export const ARRANGES = ["tidy", "organic", "flow-down", "flow-right", "rows", "grid", "pack", "columns"];
/**
 * A child as a box: its size and, for `tidy`, where it is now (top left).
 * @typedef {{ w: number, h: number, x: number, y: number }} LayoutBox
 */
/**
 * @typedef {object} LayoutInput
 * @property {string} arrange One of `ARRANGES`.
 * @property {LayoutBox[]} boxes The children in their group's order.
 * @property {[number, number][]} edges Edges between children, as indexes into `boxes`, from → to.
 * @property {boolean} useOrder The order counts: consecutive children are linked (organic, flow) or kept in sequence
 *   (rows, grid).
 * @property {number} [gap] Space between boxes; default 24.
 */
/** @typedef {{ x: number, y: number }} Point */
/**
 * A box with its position: `x`, `y` its top left.
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 */
