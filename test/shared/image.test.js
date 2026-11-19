import { describe, expect, it } from "../expect.js";
import { imagePath, imageType, strayFiles } from "../../shared/image.js";
const bytes = (...parts) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "number" ? [p] : [...p].map((c) => c.charCodeAt(0)))));
describe("imageType", () => {
  it("knows a picture by its bytes", () => {
    expect(imageType(bytes(0x89, "PNG\r\n\x1a\n", 0, 0))).toBe("image/png");
    expect(imageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(imageType(bytes("GIF89a"))).toBe("image/gif");
    expect(imageType(bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "))).toBe("image/webp");
  });
  it("refuses everything else, however it is named", () => {
    expect(imageType(bytes("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
    expect(imageType(bytes("SUPABASE_SECRET_KEY=abc"))).toBeNull();
    expect(imageType(bytes("RIFF", 0, 0, 0, 0, "WAVEfmt "))).toBeNull();
    expect(imageType(bytes())).toBeNull();
  });
});
describe("imagePath", () => {
  it("names a file by its id and type", () => {
    expect(imagePath("abc", "image/jpeg")).toBe("images/abc.jpg");
  });
});
describe("strayFiles", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const old = "2026-11-01T12:00:00Z";
  const young = "2026-11-04T11:59:00Z";
  it("takes old files no row points to", () => {
    const files = [
      { path: "images/kept.webp", created_at: old },
      { path: "images/gone.webp", created_at: old },
    ];
    expect(strayFiles(files, [{ path: "images/kept.webp" }], now)).toEqual(["images/gone.webp"]);
  });
  it("leaves a file just uploaded, whose row may still come", () => {
    expect(strayFiles([{ path: "images/new.webp", created_at: young }], [], now)).toEqual([]);
  });
});
