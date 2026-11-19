// A node can hold one picture: the file in the plugin's Storage folder, its row in `concepts_images` (migration 0023).
// Panels shrink a picture before saving it; a file AI attaches from the PC is saved as it is, so it has limits here.
/** The types a picture can be, with their extensions. No SVG: it can hold scripts. */
export const IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
export const IMAGE_FOLDER = "images";
export const imagePath = (id, mimeType) => `${IMAGE_FOLDER}/${id}.${IMAGE_TYPES[mimeType]}`;
/** Longest side of a saved picture from a panel: about what Claude looks at anyway. */
export const IMAGE_SIDE = 1600;
/** A file AI attaches: Claude refuses a picture over 5 MB once in base64, so it could never look at a larger one. */
export const MAX_ATTACHED_BYTES = 3.5 * 1024 * 1024;
/** A day: an upload's row is written within moments, so a younger file without one may still get it. */
const STRAY_AFTER_MS = 24 * 60 * 60 * 1000;
const starts = (bytes, signature, at = 0) => signature.every((b, i) => bytes[at + i] === b);
const ascii = (text) => [...text].map((c) => c.charCodeAt(0));
/** The picture type of these bytes, whatever the file is called; null when they aren't a picture. */
export function imageType(bytes) {
  if (starts(bytes, [0x89, ...ascii("PNG\r\n\x1a\n")])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, ascii("GIF8"))) return "image/gif";
  if (starts(bytes, ascii("RIFF")) && starts(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}
/** Files no row points to: left when a node was deleted, since SQL can't delete a file. */
export function strayFiles(files, rows, now) {
  const kept = new Set(rows.map((r) => r.path));
  return files.filter((f) => !kept.has(f.path) && now - Date.parse(f.created_at) > STRAY_AFTER_MS).map((f) => f.path);
}
