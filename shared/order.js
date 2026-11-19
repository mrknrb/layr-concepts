// A group's order is a key on each child's group conn (`pos`). Keys are fractional indexes: there is always a key
// between two others, so putting a child somewhere writes only that child's group conn. The database refuses two
// children of a group with the same key.
import { generateKeyBetween, generateNKeysBetween } from "../vendor/fractional-indexing.js";
/** Children's order: `pos` in plain string order (byte by byte, as the database compares it), then age, then id. */
export function compareMembers(a, b) {
  return compare(a.data.pos, b.data.pos) || compare(a.created_at, b.created_at) || compare(a.id, b.id);
}
const compare = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
/**
 * A key between the keys of two neighbours (none at an end). Undefined when there is none: both have the same key
 * (possible in memory for a moment, when two devices placed a child at once) or one is not a valid key.
 */
export function keyBetween(before, after) {
  const [a, b] = [before?.data.pos ?? null, after?.data.pos ?? null];
  if (a !== null && b !== null && a >= b) return undefined;
  try {
    return generateKeyBetween(a, b);
  } catch {
    return undefined;
  }
}
/** Fresh keys for `n` children in a row: `a0`, `a1`, … */
export const freshKeys = (n) => generateNKeysBetween(null, null, n);
