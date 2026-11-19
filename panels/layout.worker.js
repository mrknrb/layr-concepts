// Runs automatic free layouts off the panel's main thread (layout.js), so typing stays smooth with many children.
import { arrange } from "../shared/layout/index.js";

self.onmessage = (e) => {
  self.postMessage({ id: e.data.id, positions: arrange(e.data.input) });
};
