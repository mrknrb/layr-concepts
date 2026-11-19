// Dragging rows in the view (from layr_code's panels/drag.tsx): to move them between rows, into a node (its row, the
// root's title, a breadcrumb) or into a free layout. Targets are elements marked with `data-drop`:
//   gap   data-parent, data-index   between two rows of a list (index: where it lands)
//   into  data-node, data-group?    a node: inside it, last
//   free  data-parent               a free layout: inside it, where it is dropped
// Ctrl (⌘) held while dropping puts the rows there too instead of moving them.

/** The drop target under the point `x`, `y` (in the panel), and its element. */
export function targetAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest("[data-drop]");
  if (!el) return undefined;
  const d = el.dataset;
  if (d.drop === "gap") return { el, target: { kind: "gap", parent: d.parent, index: Number(d.index) } };
  if (d.drop === "into") return { el, target: { kind: "into", node: d.node, group: d.group || undefined } };
  if (d.drop === "free") {
    // In the layout's own pixels: zoom undone.
    const r = el.getBoundingClientRect();
    const scale = r.width / Math.max(1, el.offsetWidth);
    const at = { x: Math.max(0, Math.round((x - r.left) / scale)), y: Math.max(0, Math.round((y - r.top) / scale)) };
    return { el, target: { kind: "free", parent: d.parent, ...at } };
  }
  return undefined;
}

let marked;
/** Show the target under the pointer (`ok`: it can be dropped there); none clears it. */
export function markTarget(el, ok = true) {
  if (marked !== el) {
    marked?.classList.remove("drop-target", "drop-refused");
    marked = el;
  }
  el?.classList.toggle("drop-target", ok);
  el?.classList.toggle("drop-refused", !ok);
}

/** Whether `el` scrolls (asked once per element in a drag: reading styles on every frame made dragging lag). */
let scrolls = new WeakMap();
function scrollable(el) {
  let yes = scrolls.get(el);
  if (yes === undefined) {
    const style = getComputedStyle(el);
    yes = /(auto|scroll)/.test(style.overflowY + style.overflowX) && !el.classList.contains("canvas-area");
    scrolls.set(el, yes);
  }
  return yes;
}

/** Scroll what is under the pointer (and the view) while the pointer is near its edge; whether anything scrolled. */
function autoScroll(x, y) {
  const under = document.elementFromPoint(x, y);
  const boxes = new Set();
  for (let el = under; el && el !== document.body; el = el.parentElement) if (scrollable(el)) boxes.add(el);
  const body = document.querySelector(".view-body:not(.canvas)");
  if (body) boxes.add(body);
  let moved = false;
  for (const box of boxes) {
    const r = box.getBoundingClientRect();
    const edge = Math.min(40, r.height / 4, r.width / 4);
    const [top, left] = [box.scrollTop, box.scrollLeft];
    if (y < r.top + edge && y >= r.top - 20) box.scrollTop -= 14;
    else if (y > r.bottom - edge && y <= r.bottom + 20) box.scrollTop += 14;
    if (x < r.left + edge && x >= r.left - 20) box.scrollLeft -= 14;
    else if (x > r.right - edge && x <= r.right + 20) box.scrollLeft += 14;
    moved ||= box.scrollTop !== top || box.scrollLeft !== left;
  }
  return moved;
}

/**
 * Drag from the pointer-down `e`. Once it moves a few pixels it is a drag: a label follows the pointer and targets
 * light up when `accept` takes them; dropped on one, `drop(target, copy)` runs. Without moving it is a click
 * (`click`). Esc cancels. `move(x, y, target)` hears every move, right as it happens (a free layout moves the box
 * there); `quiet(target)` hides the label (a box moved within its own layout needs none); `end(dropped, cancelled)`
 * hears the end.
 */
export function dragFrom(e, { label, accept, drop, click, move, quiet, end: ended }) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const [sx, sy] = [e.clientX, e.clientY];
  let last = { x: sx, y: sy, ctrl: e.ctrlKey || e.metaKey };
  let started = false;
  let frame = 0;
  let found;
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";

  const update = () => {
    const at = targetAt(last.x, last.y);
    const ok = !!at && accept(at.target);
    found = ok ? at : undefined;
    const hush = !!quiet?.(found?.target);
    markTarget(hush ? undefined : at?.el, ok);
    ghost.classList.toggle("ok", ok);
    ghost.hidden = hush;
    ghost.textContent = `${last.ctrl ? "Also put in: " : ""}${label}`;
    ghost.style.transform = `translate(${last.x + 14}px, ${last.y + 10}px)`;
    move?.(last.x, last.y, found?.target);
  };
  // Each move is shown as it comes; the frames only scroll near the edges (and show what scrolling brought).
  const tick = () => {
    if (autoScroll(last.x, last.y)) update();
    frame = requestAnimationFrame(tick);
  };
  const onMove = (ev) => {
    last = { x: ev.clientX, y: ev.clientY, ctrl: ev.ctrlKey || ev.metaKey };
    if (!started && Math.hypot(last.x - sx, last.y - sy) < 5) return;
    if (!started) {
      started = true;
      scrolls = new WeakMap();
      document.body.classList.add("dragging");
      document.body.append(ghost);
      frame = requestAnimationFrame(tick);
    }
    update();
  };
  const onKey = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      found = undefined;
      finish();
      ended?.(false, true);
    } else if (ev.key === "Control" || ev.key === "Meta") {
      last = { ...last, ctrl: ev.type === "keydown" };
      if (started) update();
    }
  };
  const finish = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    cancelAnimationFrame(frame);
    markTarget(undefined);
    document.body.classList.remove("dragging");
    ghost.remove();
  };
  const onUp = (ev) => {
    const wasDrag = started;
    if (wasDrag) {
      last = { x: ev.clientX, y: ev.clientY, ctrl: ev.ctrlKey || ev.metaKey };
      update();
    }
    const target = found?.target;
    const copy = last.ctrl;
    finish();
    ended?.(wasDrag && !!target);
    if (!wasDrag) click?.();
    else if (target) drop(target, copy);
  };
  const onCancel = () => {
    finish();
    ended?.(false, true);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
}
