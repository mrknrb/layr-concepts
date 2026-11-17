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

/** Scroll what is under the pointer (and the view) while the pointer is near its edge. */
function autoScroll(x, y) {
  const under = document.elementFromPoint(x, y);
  const boxes = new Set();
  for (let el = under; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && !el.classList.contains("canvas-area")) boxes.add(el);
  }
  const body = document.querySelector(".view-body:not(.canvas)");
  if (body) boxes.add(body);
  for (const box of boxes) {
    const r = box.getBoundingClientRect();
    const edge = Math.min(40, r.height / 4, r.width / 4);
    if (y < r.top + edge && y >= r.top - 20) box.scrollTop -= 14;
    else if (y > r.bottom - edge && y <= r.bottom + 20) box.scrollTop += 14;
    if (x < r.left + edge && x >= r.left - 20) box.scrollLeft -= 14;
    else if (x > r.right - edge && x <= r.right + 20) box.scrollLeft += 14;
  }
}

/**
 * Drag from the pointer-down `e`. Once it moves a few pixels it is a drag: a label follows the pointer and targets
 * light up when `accept` takes them; dropped on one, `drop(target, copy)` runs. Without moving it is a click
 * (`click`). Esc cancels. `move(x, y, target)` hears every move (a free layout shows where the box goes); `end(dropped,
 * cancelled)` hears the end.
 */
export function dragFrom(e, { label, accept, drop, click, move, end: ended }) {
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
    found = targetAt(last.x, last.y);
    const ok = !!found && accept(found.target);
    markTarget(found?.el, ok);
    if (!ok) found = undefined;
    ghost.classList.toggle("ok", ok);
    ghost.textContent = `${last.ctrl ? "Also put in: " : ""}${label}`;
    ghost.style.left = `${last.x + 14}px`;
    ghost.style.top = `${last.y + 10}px`;
    move?.(last.x, last.y, found?.target);
  };
  const tick = () => {
    autoScroll(last.x, last.y);
    update();
    frame = requestAnimationFrame(tick);
  };
  const onMove = (ev) => {
    last = { x: ev.clientX, y: ev.clientY, ctrl: ev.ctrlKey || ev.metaKey };
    if (!started && Math.hypot(last.x - sx, last.y - sy) < 5) return;
    if (!started) {
      started = true;
      document.body.classList.add("dragging");
      document.body.append(ghost);
      frame = requestAnimationFrame(tick);
    }
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
