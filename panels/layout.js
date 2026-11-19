// Automatic free layouts for the view, in a Web Worker (layout.worker.js). Where a worker can't start, they run here
// instead: same code, same result, only slower to come back.
import { arrange } from "../shared/layout/index.js";

let worker;
let nextId = 0;
const waiting = new Map();

function start() {
  try {
    const w = new Worker(new URL("./layout.worker.js", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      waiting.get(e.data.id)?.resolve(e.data.positions);
      waiting.delete(e.data.id);
    };
    w.onerror = () => {
      // Blocked or crashed: from now on here, starting with what was waiting.
      worker = null;
      w.terminate();
      for (const [id, job] of waiting) {
        waiting.delete(id);
        job.resolve(arrange(job.input));
      }
    };
    return w;
  } catch {
    return null;
  }
}

/** Where the boxes go (top lefts, by index): `input` as shared/layout's `arrange` takes it. */
export function layOut(input) {
  if (worker === undefined) worker = start();
  if (!worker) return Promise.resolve(arrange(input));
  const id = ++nextId;
  return new Promise((resolve) => {
    waiting.set(id, { input, resolve });
    worker.postMessage({ id, input });
  });
}
