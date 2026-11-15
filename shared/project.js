// A project's node on the concept map (task #179): one node per project, set in its Pipeline Settings, with sections
// of fixed titles inside (Rules, Brainstorm, Features, Plan). Each section's first child is its Rules node; the Rules
// section is the project's own rules. Agents find the sections by title and get the rules in their launch message,
// so nobody has to search for where things go. Set up project map makes what is missing from this template. The
// template's rules are the standard every project follows (task #200): they come from here, not from the nodes.
export const RULES_TITLE = "Rules";
export const INBOX_TITLE = "Inbox";
/** The edge type for order between nodes: "A needs B" means B is built first (task #200). */
export const NEEDS = "needs";
/** The edge type from a second area to a node whose home is elsewhere (task #200: everything has one home). */
export const SEE_ALSO = "see also";
/** Edge types older maps used for order, which the standard calls "needs". */
export const OLD_ORDER_TYPES = ["blocks", "after"];
/** A feature's child that holds what was built when (task #200), so its description reads as documentation. */
export const HISTORY_TITLE = "History";
/** The whole map's rules for how the map is laid out: what changes its layout needs, not a worker. */
const MAP_LAYOUT_RULES = [
  "This node is the project's map: Rules, Brainstorm, Features and Plan sit inside it with these titles, and " +
    "agents find them by title.",
  "Every section's first child is its Rules node: follow it before changing anything in that section. The rules " +
    "every project shares come from layr; a Rules node holds only this project's own.",
];
/** The whole map's rules for the work; a worker's launch message carries the first. */
const DATABASE_RULE =
  "Production data: every database change (schema, migrations, data) is a question for the user, asked before it is " +
  "made.";
const MAP_WORK_RULES = [
  DATABASE_RULE,
  `Order between nodes is one edge type, "${NEEDS}": A ${NEEDS} B means B is built first.`,
];
/**
 * The standard every project map follows (task #200). Its rules live here, in code, and reach every worker and agent
 * as they are; a section's Rules node holds only that project's own rules, added after these.
 */
export const TEMPLATE = [
  {
    key: "rules",
    title: RULES_TITLE,
    rules: [...MAP_LAYOUT_RULES, ...MAP_WORK_RULES],
    forWorkers: [DATABASE_RULE],
  },
  {
    key: "brainstorm",
    title: "Brainstorm",
    rules: [
      "The user's: free form, any nesting, order doesn't matter.",
      "AI reads it only when the user points at a node, and never moves, edits or tidies anything here.",
      'An idea made from a note goes into Features, with a "leads to" edge from the note; the note stays.',
    ],
    forWorkers: [],
  },
  {
    key: "features",
    title: "Features",
    rules: [
      "Features documents what the app does now, as one tree: areas are the parts of the app as its code splits " +
        "them (as Workflow › The parts lists them, where the project has it), nested as deep as needed, and hold " +
        "features. A node with a Status tag is a feature; one without is an area.",
      "Everything has one home: a node sits in one place under Features (a Plan milestone may hold it too). When it " +
        `concerns another area as well, link it from there with a "${SEE_ALSO}" edge, never a second place.`,
      "A feature's first child says in a sentence or two what it does now, written as documentation. " +
        `"Decision: …" children follow it, and a ${HISTORY_TITLE} child holds what was built when ("Task #12: …"), ` +
        "so the description never reads as a log.",
      "A change (an idea, a bug, a rework not built yet) is a child of the feature it changes, or of its area for a " +
        "new feature. Once it is built, the worker rewrites the feature's description to match and the change moves " +
        `into the feature's ${HISTORY_TITLE}, tagged Done.`,
      `A change that can only be built after another gets a "${NEEDS}" edge to it: the pipeline then starts its ` +
        "task only once the other's task has landed.",
      "Tags: Status (Idea, Planned, In progress, To try, Done, Dropped), Kind (Feature, Bug), Source (You, Agent, " +
        "Scout).",
      "A bug or idea an agent finds outside its task isn't fixed but filed with concepts__file, under the feature or " +
        "area it concerns, or in Inbox.",
      "A task that built a feature tags it Done; a task that only plans adds Idea or Planned features and marks " +
        "nothing Done.",
    ],
    forWorkers: [],
    children: [INBOX_TITLE],
  },
  {
    key: "plan",
    title: "Plan",
    rules: [
      'Vision is the user\'s: AI only suggests a change, as a child starting with "?".',
      "Now, Next and Later hold milestones; a milestone holds the features and changes that make it (the same nodes " +
        `as in Features, which stay their home), and the order to build them in is "${NEEDS}" edges, not groups.`,
      "Ideas that serve a Now milestone go first.",
    ],
    forWorkers: [],
    children: ["Vision", "Now", "Next", "Later"],
  },
];
/**
 * Rules the template had before task #200, which Set up project map copied into every map's Rules nodes. A Rules
 * node child that says one of these is left out: the standard above says it now.
 */
const OLD_RULES = [
  "Every section's first child is its Rules node: follow it before changing anything in that section.",
  "Areas hold features, nested as deep as needed: a node with a Status tag is a feature, one without is an area.",
  'A feature\'s first child says in a sentence or two what it does; details and decisions ("Decision: …") go ' +
    "below it.",
  "A bug or idea an agent finds outside its task isn't fixed but filed with concepts__file, into its area or Inbox.",
  "Now, Next and Later hold milestones; a milestone holds the features that make it (the same nodes as in Features).",
];
const ruleKey = (rule) => rule.trim().replace(/\s+/g, " ").toLowerCase();
const STANDARD = new Set([...TEMPLATE.flatMap((s) => s.rules), ...OLD_RULES].map(ruleKey));
/**
 * A section's rules: the standard's, then the project's own (its Rules node's children that the standard lacks).
 * `forWorkers`: only the standard's rules a worker's launch message carries (`SectionTemplate.forWorkers`).
 */
export function sectionRules(key, own, forWorkers = false) {
  const section = TEMPLATE.find((s) => s.key === key);
  const standard = forWorkers ? (section.forWorkers ?? section.rules) : section.rules;
  return [...standard, ...(own ?? []).filter((rule) => rule.trim() && !STANDARD.has(ruleKey(rule)))];
}
/** A section's Rules node: its first child titled Rules, or "How this map works" (what LayrCode's Features had). */
export const isRulesTitle = (title) => /^(rules|how this (project'?s? )?map works)\b/i.test(title.trim());
const norm = (title) => title.trim().toLowerCase();
/** The project node's sections among its children (first line, id), by title in any case. */
export function findSections(children) {
  const found = {};
  for (const section of TEMPLATE) {
    const hit = children.find((c) => norm(c.title) === norm(section.title));
    if (hit) found[section.key] = hit.id;
  }
  return found;
}
/** A section's Rules node among its children: the first child with a rules title. */
export const findRulesNode = (children) => children.find((c) => isRulesTitle(c.title))?.id;
/** The map as a launch message or MCP instructions put it: where things go, and the rules. */
export function describeMap(map) {
  const id = (key) => (map.sections[key] ? ` (#${map.sections[key].slice(0, 8)})` : "");
  const lines = [
    `This project's node on the concept map is "${map.title}" (#${map.node.slice(0, 8)}). Its sections: ` +
      TEMPLATE.filter((s) => map.sections[s.key])
        .map((s) => `${s.title}${id(s.key)}`)
        .join(", ") +
      (map.sections.inbox ? `; Features › ${INBOX_TITLE}${id("inbox")}` : "") +
      ".",
  ];
  for (const section of TEMPLATE) {
    const rules = map.rules[section.key];
    if (!rules?.length) continue;
    lines.push(`${section.key === "rules" ? "Rules for the whole map" : `Rules for ${section.title}`}:`);
    for (const rule of rules) lines.push(`  - ${rule}`);
  }
  return lines;
}
// ---------- tags ----------
export const STATUS_SET = "Status";
/** Status tags in the order work moves through them; Dropped is apart (nothing moves a node out of it by itself). */
export const STATUS_ORDER = ["Idea", "Go to Pipeline", "Planned", "In progress", "To try", "Done"];
export const DROPPED = "Dropped";
/** The tag sets a project map uses, made by Set up project map when missing (one tag per node in each). */
export const TAG_SETS = [
  {
    set: STATUS_SET,
    description: "Where a feature stands",
    tags: [
      { name: "Idea", description: "Thought of, not decided" },
      { name: "Planned", description: "Decided, not started" },
      { name: "In progress", description: "Being built" },
      { name: "To try", description: "Built, waits for the user to try it" },
      { name: "Done", description: "Built and in use" },
      { name: DROPPED, description: "Decided against" },
    ],
  },
  {
    set: "Kind",
    description: "What a feature node is",
    tags: [
      { name: "Feature", description: "Something the app does or could do" },
      { name: "Bug", description: "Something that doesn't work as it should" },
    ],
  },
  {
    set: "Source",
    description: "Who brought the idea",
    tags: [
      { name: "You", description: "The user" },
      { name: "Agent", description: "An agent noticed it while working on something else" },
      { name: "Scout", description: "A scout found it looking for ideas" },
    ],
  },
];
/**
 * Whether a node with Status `current` moves to `next` by itself: only forward, never out of Dropped or Done, and a
 * node with no status (or one outside the order) isn't a feature the pipeline tracks.
 */
export function advances(current, next) {
  if (!current) return false;
  const from = STATUS_ORDER.findIndex((s) => norm(s) === norm(current));
  if (from < 0) return false;
  return STATUS_ORDER.indexOf(next) > from;
}
/** Significant words of a title, for finding the same idea filed twice. */
export function titleWords(title) {
  const stop = new Set(["the", "and", "for", "with", "from", "into", "when", "that", "this", "what", "your"]);
  return [...new Set(title.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].filter((w) => !stop.has(w)).slice(0, 6);
}
/** Nodes found by at least half of the words (and two), most found first: likely the same idea. */
export function likelySame(hitsPerWord, words) {
  const count = new Map();
  for (const hits of hitsPerWord) {
    for (const hit of new Map(hits.map((h) => [h.id, h])).values()) {
      const seen = count.get(hit.id) ?? { ...hit, n: 0 };
      seen.n++;
      count.set(hit.id, seen);
    }
  }
  const need = Math.max(2, Math.ceil(words / 2));
  return [...count.values()].filter((c) => c.n >= Math.min(need, words)).sort((a, b) => b.n - a.n);
}
