import { describe, expect, it } from "../expect.js";
import { applyEdits, checkPage } from "../../shared/prototype.js";
describe("applyEdits", () => {
  it("makes each edit in turn", () => {
    const page = applyEdits("<b>one</b><i>two</i>", [
      { find: "one", replace: "1" },
      { find: "<i>two", replace: "<i>2" },
    ]);
    expect(page).toBe("<b>1</b><i>2</i>");
  });
  it("takes `replace` as it is", () => {
    expect(applyEdits("a", [{ find: "a", replace: "$&$&" }])).toBe("$&$&");
  });
  it("refuses a `find` that isn't there once", () => {
    expect(() => applyEdits("a", [{ find: "b", replace: "c" }])).toThrow("0 times");
    expect(() => applyEdits("aa", [{ find: "a", replace: "c" }])).toThrow("2 times");
    expect(() => applyEdits("a", [{ find: "", replace: "c" }])).toThrow("needs a `find`");
  });
});
describe("checkPage", () => {
  it("refuses an empty page and a huge one", () => {
    expect(checkPage("<p>")).toBe("<p>");
    expect(() => checkPage("  ")).toThrow("no HTML");
    expect(() => checkPage("x".repeat(400_001))).toThrow("over");
  });
});
