import { describe, expect, it } from "./expect.js";
import { editAction, rowAction, shownText, textToSave } from "../panels/keys.js";

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

describe("keys while a node's text is typed in its row", () => {
  it("Enter adds a node below, Shift+Enter is a new line, Ctrl+Enter a child", () => {
    expect(editAction(key("Enter"))).toBe("sibling");
    expect(editAction(key("Enter", { shiftKey: true }))).toBe(null);
    expect(editAction(key("Enter", { ctrlKey: true }))).toBe("child");
    expect(editAction(key("Enter", { metaKey: true }))).toBe("child");
  });
  it("Esc stops, Tab and Shift+Tab move it in and out, Alt+arrows move it", () => {
    expect(editAction(key("Escape"))).toBe("stop");
    expect(editAction(key("Tab"))).toBe("indent");
    expect(editAction(key("Tab", { shiftKey: true }))).toBe("outdent");
    expect(editAction(key("ArrowUp", { altKey: true }))).toBe("up");
    expect(editAction(key("ArrowDown", { altKey: true }))).toBe("down");
    expect(editAction(key("ArrowDown"))).toBe(null);
    expect(editAction(key("a"))).toBe(null);
  });
  it("Backspace deletes only an empty node that may go", () => {
    expect(editAction(key("Backspace"), { empty: true, deletable: true })).toBe("delete");
    expect(editAction(key("Backspace"), { empty: true, deletable: false })).toBe(null);
    expect(editAction(key("Backspace"), { empty: false, deletable: true })).toBe(null);
  });
  it("leaves keys alone while an input method composes", () => {
    expect(editAction(key("Enter", { isComposing: true }))).toBe(null);
  });
});

describe("keys on the picked row while nothing is typed", () => {
  it("walks, opens, closes and types", () => {
    expect(rowAction(key("ArrowDown"))).toBe("next");
    expect(rowAction(key("ArrowUp"))).toBe("prev");
    expect(rowAction(key("ArrowRight"))).toBe("right");
    expect(rowAction(key("ArrowLeft"))).toBe("left");
    expect(rowAction(key("Enter"))).toBe("edit");
    expect(rowAction(key("F2"))).toBe("edit");
    expect(rowAction(key(" "))).toBe("toggle");
    expect(rowAction(key("Escape"))).toBe("clear");
  });
  it("moves, adds a child, removes and opens the menu", () => {
    expect(rowAction(key("ArrowUp", { altKey: true }))).toBe("up");
    expect(rowAction(key("ArrowDown", { altKey: true }))).toBe("down");
    expect(rowAction(key("Enter", { ctrlKey: true }))).toBe("child");
    expect(rowAction(key("Delete"))).toBe("remove");
    expect(rowAction(key("ContextMenu"))).toBe("menu");
    expect(rowAction(key("F10", { shiftKey: true }))).toBe("menu");
  });
  it("grows the selection, selects children or parents, and has letters for connect, tags and move", () => {
    expect(rowAction(key("ArrowDown", { shiftKey: true }))).toBe("extend-down");
    expect(rowAction(key("ArrowUp", { shiftKey: true }))).toBe("extend-up");
    expect(rowAction(key("ArrowDown", { ctrlKey: true, shiftKey: true }))).toBe("select-children");
    expect(rowAction(key("ArrowUp", { ctrlKey: true, shiftKey: true }))).toBe("select-parents");
    expect(rowAction(key("Enter", { altKey: true }))).toBe("details");
    expect(rowAction(key("c"))).toBe("connect");
    expect(rowAction(key("T"))).toBe("tags");
    expect(rowAction(key("m"))).toBe("move");
    expect(rowAction(key("C", { shiftKey: true }))).toBe(null);
  });
  it("leaves other keys and shortcuts to the page", () => {
    expect(rowAction(key("a"))).toBe(null);
    expect(rowAction(key("c", { ctrlKey: true }))).toBe(null);
    expect(rowAction(key("F10"))).toBe(null);
    expect(rowAction(key("ArrowDown", { ctrlKey: true }))).toBe(null);
  });
});

describe("what typing saves", () => {
  it("saves changed text without the spaces around it", () => {
    expect(textToSave("  Rye bread \n", "Rye")).toBe("Rye bread");
    expect(textToSave("First line\nsecond line", "First line")).toBe("First line\nsecond line");
  });
  it("saves nothing when it didn't change or is empty", () => {
    expect(textToSave("Rye", "Rye")).toBe(null);
    expect(textToSave("Rye  ", "Rye")).toBe(null);
    expect(textToSave("   \n", "Rye")).toBe(null);
    expect(textToSave("", "")).toBe(null);
  });
  it("shows every line, links as their label", () => {
    expect(shownText(" See [the plan](layr://concepts/node/abc) \nand more ")).toBe("See the plan \nand more");
    expect(shownText(undefined)).toBe("");
  });
});
