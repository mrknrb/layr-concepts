import { describe, expect, it } from "../expect.js";
import {
  advances,
  findRulesNode,
  findSections,
  isRulesTitle,
  likelySame,
  sectionRules,
  TEMPLATE,
  titleWords,
} from "../../shared/project.js";
describe("project maps", () => {
  it("finds the sections by title in any case, and leaves other children alone", () => {
    const found = findSections([
      { id: "1", title: "features" },
      { id: "2", title: "Brainstorm" },
      { id: "3", title: "Old notes" },
    ]);
    expect(found).toEqual({ features: "1", brainstorm: "2" });
  });
  it("takes a section's first child titled Rules, or LayrCode's older \"How this map works\", as its rules", () => {
    expect(isRulesTitle("Rules")).toBe(true);
    expect(isRulesTitle("How this map works")).toBe(true);
    expect(isRulesTitle("Rules of thumb for nothing")).toBe(true);
    expect(isRulesTitle("Rule engine")).toBe(false);
    expect(
      findRulesNode([
        { id: "a", title: "Shell" },
        { id: "b", title: "How this map works" },
      ]),
    ).toBe("b");
  });
  it("has a template where every section brings rules", () => {
    expect(TEMPLATE.map((s) => s.title)).toEqual(["Rules", "Brainstorm", "Features", "Plan"]);
    for (const s of TEMPLATE) expect(s.rules.length).toBeGreaterThan(0);
  });
  it("gives the standard's rules first, then the project's own, leaving out copies of the standard", () => {
    const standard = TEMPLATE.find((s) => s.key === "features").rules;
    const own = [
      "Areas hold features, nested as deep as needed: a node with a Status tag is a feature, one without is an area.",
      `  ${standard[0].toUpperCase()}  `,
      "Every bug gets a screenshot.",
      "",
    ];
    expect(sectionRules("features", own)).toEqual([...standard, "Every bug gets a screenshot."]);
    expect(sectionRules("plan", undefined)).toEqual(TEMPLATE.find((s) => s.key === "plan").rules);
  });
  it("gives a worker only the standard's database rule, and every rule of the project's own", () => {
    const all = sectionRules("rules", ["Ship on Fridays."]);
    const worker = sectionRules("rules", ["Ship on Fridays."], true);
    expect(worker.length).toBeLessThan(all.length);
    expect(worker.some((rule) => rule.startsWith("Production data"))).toBe(true);
    expect(worker.some((rule) => rule.startsWith("This node is the project's map"))).toBe(false);
    expect(worker.at(-1)).toBe("Ship on Fridays.");
    expect(sectionRules("plan", ["Milestones get dates."], true)).toEqual(["Milestones get dates."]);
    expect(sectionRules("features", ["Every bug gets a screenshot."], true)).toEqual(["Every bug gets a screenshot."]);
    expect(sectionRules("brainstorm", [], true)).toEqual([]);
    expect(worker.some((rule) => rule.startsWith("Order between nodes"))).toBe(false);
  });
  it("moves a status only forward, and only on nodes that have one", () => {
    expect(advances("Idea", "In progress")).toBe(true);
    expect(advances("Go to Pipeline", "In progress")).toBe(true);
    expect(advances("In progress", "Done")).toBe(true);
    expect(advances("Done", "In progress")).toBe(false);
    expect(advances("In progress", "In progress")).toBe(false);
    expect(advances("Dropped", "Done")).toBe(false);
    expect(advances(undefined, "Done")).toBe(false);
  });
  it("finds the same idea filed twice by the words of its title", () => {
    const words = titleWords("Landing fails on lockfile conflicts");
    expect(words).toEqual(["landing", "fails", "lockfile", "conflicts"]);
    const same = likelySame(
      [
        [{ id: "x", title: "Landings stop on lockfile conflicts" }],
        [],
        [
          { id: "x", title: "Landings stop on lockfile conflicts" },
          { id: "y", title: "Lockfile" },
        ],
        [{ id: "x", title: "Landings stop on lockfile conflicts" }],
      ],
      words.length,
    );
    expect(same.map((s) => s.id)).toEqual(["x"]);
  });
});
