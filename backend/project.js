// Project maps (shared/project.ts): reading one, setting one up from the template, agents filing what they find into
// a project's Features, statuses that move with pipeline tasks, and the gardener: what in Features breaks the
// standard (task #200). Commands for the pipeline, MCP tools for agents.
import { findType } from "../shared/edges.js";
import { firstLine, Graph } from "../shared/graph.js";
import { findCycles } from "../shared/inspect.js";
import { shortId } from "../shared/outline.js";
import {
  advances,
  DROPPED,
  findRulesNode,
  findSections,
  HISTORY_TITLE,
  INBOX_TITLE,
  likelySame,
  NEEDS,
  OLD_ORDER_TYPES,
  RULES_TITLE,
  SEE_ALSO,
  sectionRules,
  STATUS_ORDER,
  STATUS_SET,
  TAG_SETS,
  TEMPLATE,
  titleWords,
} from "../shared/project.js";
import { applyBundle } from "../shared/rows.js";
const PAGE = 500;
/** Under Plan: what the correction miner found. */
const LESSONS_TITLE = "Lessons";
const text = (graph, id) => (graph.node(id)?.data.text ?? "").trim().replace(/\s*\n\s*/g, " ");
const kids = (graph, id) =>
  graph.children(id).map((g) => ({ id: g.data.to, title: firstLine(graph.node(g.data.to)?.data.text ?? "") }));
export function projectMaps(ctx, d) {
  /** The project node's sections and rules, read fresh. */
  async function readMap(node) {
    const graph = new Graph();
    applyBundle(graph, await d.load.get([node]));
    if (!graph.node(node)) throw new Error(`No node ${shortId(node)}`);
    applyBundle(graph, await d.load.level([node], 0, PAGE));
    const sections = findSections(kids(graph, node));
    const ids = Object.values(sections);
    if (ids.length) applyBundle(graph, await d.load.level(ids, 0, PAGE));
    const rulesNodes = {};
    for (const s of TEMPLATE) {
      const id = sections[s.key];
      if (id) rulesNodes[s.key] = s.key === "rules" ? id : findRulesNode(kids(graph, id));
    }
    const inner = TEMPLATE.map((s) => (s.key === "rules" ? undefined : rulesNodes[s.key])).filter((id) => !!id);
    if (inner.length) applyBundle(graph, await d.load.level(inner, 0, PAGE));
    // The standard's rules for every section there is, then the project's own from its Rules node.
    const rules = {};
    const workerRules = {};
    for (const s of TEMPLATE) {
      if (!sections[s.key]) continue;
      const id = rulesNodes[s.key];
      const own = id ? kids(graph, id).map((k) => text(graph, k.id)) : [];
      rules[s.key] = sectionRules(s.key, own);
      workerRules[s.key] = sectionRules(s.key, own, true);
    }
    const inbox = sections.features
      ? kids(graph, sections.features).find((k) => k.title.toLowerCase() === INBOX_TITLE.toLowerCase())?.id
      : undefined;
    const missing = [
      ...TEMPLATE.filter((s) => !sections[s.key]).map((s) => s.title),
      ...TEMPLATE.filter((s) => sections[s.key] && !rulesNodes[s.key]).map((s) => `${s.title} › ${RULES_TITLE}`),
    ];
    return {
      node,
      title: firstLine(graph.node(node).data.text) || "(empty)",
      sections: { ...sections, ...(inbox ? { inbox } : {}) },
      rules,
      workerRules,
      missing,
    };
  }
  /** Every tag set and tag of the template that isn't there yet; returns what it made. */
  async function ensureTags(graph, ops) {
    await d.loadTags(graph);
    const made = [];
    for (const def of TAG_SETS) {
      let set = graph.tagSetByName(def.set)?.id;
      if (!set) {
        set = await ops.createTagSet({ name: def.set, description: def.description, single: true });
        made.push(`tag set ${def.set}`);
      }
      for (const tag of def.tags) {
        if (graph.tagByName(tag.name)) continue;
        await ops.createTag({ name: tag.name, tag_set: set, description: tag.description });
        made.push(`tag ${tag.name}`);
      }
    }
    return made;
  }
  const tagIdOf = (graph, name) => {
    const tag = graph.tagByName(name);
    if (!tag) throw new Error(`No tag "${name}"`);
    return tag.id;
  };
  /** The edge types the standard uses ("needs", "see also"), made when missing; returns what it made. */
  async function ensureEdgeTypes(ops) {
    const types = await d.types();
    const made = [];
    for (const name of [NEEDS, SEE_ALSO]) {
      if (findType(types, name)) continue;
      await ops.addEdgeType(name);
      made.push(`edge type ${name}`);
    }
    return made;
  }
  /**
   * Make what the template has and the node doesn't: sections, Rules nodes, Inbox, tag sets, edge types. Nothing is
   * changed. The standard's rules aren't copied in (they come from the template); a Rules node starts empty, for the
   * project's own.
   */
  async function setup(node) {
    const before = await readMap(node);
    const { graph, ops } = await d.slice([node, ...Object.values(before.sections)]);
    const made = [];
    const missing = new Set(before.missing);
    for (const s of TEMPLATE) {
      const existing = before.sections[s.key];
      if (s.key === "rules") {
        if (!existing) {
          await ops.addNewChild(node, s.title, 0);
          made.push(s.title);
        }
        continue;
      }
      if (!existing) {
        const { node: section } = await ops.addNewChild(node, s.title);
        await ops.addNewChild(section, RULES_TITLE);
        for (const child of s.children ?? []) await ops.addNewChild(section, child);
        made.push(s.title);
        continue;
      }
      if (missing.has(`${s.title} › ${RULES_TITLE}`)) {
        await ops.addNewChild(existing, RULES_TITLE, 0);
        made.push(`${s.title} › ${RULES_TITLE}`);
      }
      if (s.key === "features" && !before.sections.inbox) {
        await ops.addNewChild(existing, INBOX_TITLE);
        made.push(`Features › ${INBOX_TITLE}`);
      }
    }
    made.push(...(await ensureTags(graph, ops)), ...(await ensureEdgeTypes(ops)));
    return { made, map: await readMap(node) };
  }
  /** The Features section from the node given: the project node (its Features child) or Features itself. */
  async function featuresOf(given) {
    const id = await d.resolve(given);
    const graph = new Graph();
    applyBundle(graph, await d.load.get([id]));
    applyBundle(graph, await d.load.level([id], 0, PAGE));
    const sections = findSections(kids(graph, id));
    return sections.features ?? id;
  }
  /** Where a filed node goes: the area named (by id, or its title under Features), else Inbox (made if missing). */
  async function areaOf(features, area) {
    if (area?.trim()) {
      const wanted = area.trim().replace(/^#/, "").toLowerCase();
      const hits = await d.search(area.trim(), 30, features);
      const titled = hits.find((h) => firstLine(h.text).toLowerCase() === wanted || h.id.startsWith(wanted));
      if (titled) return titled.id;
      if (/^[0-9a-f-]{8,}$/i.test(wanted)) return d.resolve(wanted);
    }
    const graph = new Graph();
    applyBundle(graph, await d.load.level([features], 0, PAGE));
    const inbox = kids(graph, features).find((k) => k.title.toLowerCase() === INBOX_TITLE.toLowerCase());
    if (inbox) return inbox.id;
    const { ops } = await d.slice([features]);
    return (await ops.addNewChild(features, INBOX_TITLE)).node;
  }
  /**
   * The gardener (task #200): what in Features breaks the standard. Features without a description, nodes with more
   * than one home under Features, titles that look like the same feature twice, "needs" cycles, and order said with
   * the old edge types. Changes kept in a feature's History are past, so only their home counts. It only reports.
   */
  async function garden(features) {
    const graph = await d.loadTags(new Graph());
    const statusSet = graph.tagSetByName(STATUS_SET);
    const statusTags = [...graph.tags.values()].filter((t) => statusSet && t.tag_set === statusSet.id);
    // `tagged` wants every tag given: one call per status.
    const hits = (await Promise.all(statusTags.map((t) => d.tagged([t.id], features, PAGE)))).flat();
    const byId = new Map(hits.map((h) => [h.id, h]));
    if (!byId.size) return [];
    const ids = [...byId.keys()];
    const below = (h) => h.path.slice(h.path.findIndex((p) => p.id === features) + 1);
    const isHistory = (text) => firstLine(text).trim().toLowerCase() === HISTORY_TITLE.toLowerCase();
    const past = (h) => below(h).some((p) => isHistory(p.text));
    const title = (id) => firstLine(byId.get(id)?.text ?? "") || "(empty)";
    const end = (id) => `${title(id)} (#${shortId(id)})`;
    const problems = [];
    const nodes = new Graph();
    applyBundle(nodes, await d.load.get(ids));
    for (const id of ids) {
      if (nodes.childCount(id) === 0) problems.push(`no description: ${end(id)}`);
    }
    // Groups under Features: Features, the areas and features on the way down to a feature, and the features.
    const under = new Set([features, ...ids, ...hits.flatMap((h) => below(h).map((p) => p.id))]);
    const groups = [];
    for (let i = 0; i < ids.length; i += 100) groups.push(...(await d.groupsOf(ids.slice(i, i + 100))));
    const homes = new Map();
    for (const g of groups) if (under.has(g.parent)) homes.set(g.child, (homes.get(g.child) ?? 0) + 1);
    for (const [id, n] of homes) {
      if (n > 1) problems.push(`in ${n} places under Features: ${end(id)} (keep one home, "${SEE_ALSO}" from others)`);
    }
    const current = hits.filter((h) => !past(h));
    const words = current.map((h) => ({ id: h.id, words: new Set(titleWords(firstLine(h.text))) }));
    let pairs = 0;
    for (let i = 0; i < words.length && pairs < 10; i++) {
      for (let j = i + 1; j < words.length && pairs < 10; j++) {
        const [a, b] = [words[i], words[j]];
        const shared = [...a.words].filter((w) => b.words.has(w)).length;
        if (shared >= Math.max(2, Math.ceil(Math.max(a.words.size, b.words.size) / 2))) {
          problems.push(`maybe the same feature twice: ${end(a.id)} and ${end(b.id)}`);
          pairs++;
        }
      }
    }
    const types = await d.types();
    const among = (typeId) =>
      typeId
        ? ids.flatMap((id) =>
            nodes.outgoing(id, "edge").filter((e) => e.data.relation === typeId && byId.has(e.data.to)),
          )
        : [];
    for (const cycle of findCycles(among(findType(types, NEEDS)?.id)).slice(0, 5)) {
      problems.push(`"${NEEDS}" goes in a circle: ${[...cycle, cycle[0]].map(end).join(" → ")}`);
    }
    for (const name of OLD_ORDER_TYPES) {
      for (const e of among(findType(types, name)?.id).slice(0, 10)) {
        // "A blocks B" is "B needs A"; "A after B" is "A needs B".
        const [from, to] = name === "blocks" ? [e.data.to, e.data.from] : [e.data.from, e.data.to];
        problems.push(`order said with "${name}": make it ${end(from)} ${NEEDS} ${end(to)}`);
      }
    }
    return problems;
  }
  ctx.commands.register("concepts.projectMap", async ({ node }) => readMap(await d.resolve(node)));
  ctx.commands.register("concepts.setupProjectMap", async ({ node }) => setup(await d.resolve(node)));
  /**
   * Pipeline tasks move the Status of the nodes they were made from: forward only (Idea → … → Done), never out of
   * Dropped or Done, and only on nodes that have a status. Nodes that are gone are passed over.
   */
  ctx.commands.register("concepts.advanceStatus", async ({ nodes, status }) => {
    if (!STATUS_ORDER.includes(status)) throw new Error(`Give a status from ${STATUS_ORDER.join(", ")}`);
    const ids = (await Promise.all((nodes ?? []).map((n) => d.resolve(n).catch(() => undefined)))).filter((id) => !!id);
    if (!ids.length) return { changed: [] };
    const { graph, ops } = await d.slice(ids, false);
    await ensureTags(graph, ops);
    const set = graph.tagSetByName(STATUS_SET);
    const next = tagIdOf(graph, status);
    const changed = [];
    for (const id of ids) {
      if (!graph.node(id)) continue;
      const current = graph.tagsOf(id).find((t) => t.tag_set === set?.id)?.name;
      if (current === DROPPED || !advances(current, status)) continue;
      await ops.tag(id, next);
      changed.push(id);
    }
    return { changed };
  });
  /**
   * What these nodes need ("needs" edges from them, task #200), for the pipeline to chain their tasks: per node, the
   * nodes it needs with their Status. Nodes that are gone are passed over; none without a "needs" type.
   */
  ctx.commands.register("concepts.needs", async ({ nodes }) => {
    const needs = findType(await d.types(), NEEDS)?.id;
    const ids = (await Promise.all((nodes ?? []).map((n) => d.resolve(n).catch(() => undefined)))).filter((id) => !!id);
    if (!needs || !ids.length) return [];
    const graph = new Graph();
    applyBundle(graph, await d.load.get(ids));
    const targets = [
      ...new Set(ids.flatMap((id) => graph.outgoing(id, "edge").filter((e) => e.data.relation === needs))),
    ];
    if (!targets.length) return [];
    await d.loadTags(graph);
    applyBundle(graph, await d.load.get([...new Set(targets.map((e) => e.data.to))]));
    const set = graph.tagSetByName(STATUS_SET)?.id;
    return ids
      .map((id) => ({
        node: id,
        needs: targets
          .filter((e) => e.data.from === id && e.data.to !== id)
          .map((e) => ({
            id: e.data.to,
            title: firstLine(graph.node(e.data.to)?.data.text ?? "") || "(empty)",
            status: graph.tagsOf(e.data.to).find((t) => t.tag_set === set)?.name ?? null,
          })),
      }))
      .filter((n) => n.needs.length);
  });
  /**
   * What agents and scouts filed into a project's Features that still waits for the user (Status Idea, Source Agent
   * or Scout), for the pipeline's Decide panel. None when the project node has no Features yet.
   */
  ctx.commands.register("concepts.filedIdeas", async ({ node }) => {
    const map = await readMap(await d.resolve(node));
    const features = map.sections.features;
    if (!features) return [];
    const graph = await d.loadTags(new Graph());
    const idea = graph.tagByName(STATUS_ORDER[0])?.id;
    if (!idea) return [];
    const found = [];
    for (const source of ["Agent", "Scout"]) {
      const tag = graph.tagByName(source)?.id;
      if (!tag) continue;
      for (const hit of await d.tagged([idea, tag], features, 100)) {
        found.push({
          id: hit.id,
          label: firstLine(hit.text) || "(empty)",
          in: hit.path.slice(-2).map((p) => firstLine(p.text) || "(empty)"),
          source,
        });
      }
    }
    return found;
  });
  /**
   * How many of a project's features have each Status, and the first `max` of them (default 30), for the pipeline
   * board's Ideas, Approved and Done: `{ Idea: { count, nodes: [{ id, label, in }] }, … }`, `in` being the area they
   * are in.
   */
  ctx.commands.register("concepts.statusNodes", async ({ node, max }) => {
    const map = await readMap(await d.resolve(node));
    const features = map.sections.features;
    const found = {};
    if (!features) return found;
    const graph = await d.loadTags(new Graph());
    for (const status of [...STATUS_ORDER, DROPPED]) {
      const tag = graph.tagByName(status)?.id;
      const hits = tag ? await d.tagged([tag], features, 1000) : [];
      found[status] = {
        count: hits.length,
        nodes: hits.slice(0, max ?? 30).map((hit) => ({
          id: hit.id,
          label: firstLine(hit.text) || "(empty)",
          // The way down from Features, without the project's own nodes above it.
          in: hit.path
            .slice(hit.path.findIndex((p) => p.id === features) + 1)
            .map((p) => firstLine(p.text) || "(empty)"),
        })),
      };
    }
    return found;
  });
  /**
   * Lessons the correction miner found (rules the user had to give more than once): children of Plan › Lessons
   * (made when missing), tagged Idea, so the user decides which become rules. One already there isn't added twice.
   */
  ctx.commands.register("concepts.addLessons", async ({ node, lessons }) => {
    const map = await readMap(await d.resolve(node));
    const plan = map.sections.plan;
    if (!plan) throw new Error("The project node has no Plan section: Set up project map makes it");
    const graph = new Graph();
    applyBundle(graph, await d.load.level([plan], 0, PAGE));
    let lessonsNode = kids(graph, plan).find((k) => k.title.toLowerCase() === LESSONS_TITLE.toLowerCase())?.id;
    const { graph: g, ops } = await d.slice(lessonsNode ? [plan, lessonsNode] : [plan]);
    if (!lessonsNode) lessonsNode = (await ops.addNewChild(plan, LESSONS_TITLE)).node;
    applyBundle(graph, await d.load.level([lessonsNode], 0, PAGE));
    const have = new Set(kids(graph, lessonsNode).map((k) => k.title.trim().toLowerCase()));
    await ensureTags(g, ops);
    const idea = tagIdOf(g, STATUS_ORDER[0]);
    const added = [];
    for (const lesson of lessons ?? []) {
      const text = lesson.trim();
      if (!text || have.has(text.toLowerCase())) continue;
      const { node: made } = await ops.addNewChild(lessonsNode, text);
      await ops.tag(made, idea);
      have.add(text.toLowerCase());
      added.push(made);
    }
    return { lessons: lessonsNode, added };
  });
  /**
   * You decided against these nodes (the Decide panel's Drop): Status Dropped, and the reason as a "Decision: …"
   * child, as the Features rules say decisions are kept.
   */
  ctx.commands.register("concepts.dropNodes", async ({ nodes, reason }) => {
    const ids = (await Promise.all((nodes ?? []).map((n) => d.resolve(n).catch(() => undefined)))).filter((id) => !!id);
    if (!ids.length) return { dropped: [] };
    const { graph, ops } = await d.slice(ids, false);
    await ensureTags(graph, ops);
    const dropped = tagIdOf(graph, DROPPED);
    const done = [];
    for (const id of ids) {
      if (!graph.node(id)) continue;
      await ops.tag(id, dropped);
      if (reason?.trim()) await ops.addNewChild(id, `Decision: dropped. ${reason.trim()}`);
      done.push(id);
    }
    return { dropped: done };
  });
  ctx.mcp.registerTool({
    name: "project",
    description:
      "A project's node on the concept map: its sections (Rules, Brainstorm, Features, Plan, and Features › Inbox) " +
      "with their ids, every section's rules (the standard's, then the project's own), and what breaks them: " +
      "missing sections, features without a description, nodes in more than one place under Features, likely " +
      'duplicates, "needs" cycles, and order said with old edge types. The project node is `map.node` in ' +
      "pipeline_projects. Read it before changing a project's map, and after, to check it.",
    inputSchema: {
      type: "object",
      properties: { node: { type: "string", description: "The project node (or its Features)" } },
      required: ["node"],
    },
    handler: async ({ node }) => {
      const map = await readMap(await d.resolve(node));
      const problems = map.missing.map((m) => `missing: ${m} (Set up project map in Pipeline Settings makes it)`);
      if (map.sections.features) problems.push(...(await garden(map.sections.features)));
      return { ...map, problems: problems.length ? problems.slice(0, 50) : ["none"] };
    },
  });
  d.writeTool({
    name: "file",
    description:
      "File a bug or idea you noticed outside your task's scope into a project's Features, instead of fixing it: " +
      "one node with your one-sentence description and the evidence, tagged Idea, Kind (Bug or Feature) and Source: " +
      "Agent, under the feature or area it concerns (by #id or title under Features) or in Features › Inbox. " +
      "`features`: the project node or its Features (`map.node` in pipeline_projects, or your launch message). The " +
      "first call returns nodes that may be the same thing: add to one of those instead (concepts__add), or call " +
      "again with `confirm: true`. Mention what you filed under ## Problems in your reply.",
    inputSchema: {
      type: "object",
      properties: {
        features: { type: "string", description: "The project node or its Features node (#id)" },
        kind: { type: "string", enum: ["bug", "idea"] },
        title: { type: "string", description: "Short: what is wrong, or what could be done" },
        description: { type: "string", description: "One or two sentences: what happens, or what it would do" },
        evidence: { type: "string", description: "file:line, a log line, steps to see it, a screenshot path" },
        area: {
          type: "string",
          description: "The feature it changes or the area it belongs in, under Features (#id or title); none: Inbox",
        },
        confirm: { type: "boolean", description: "File it even though similar nodes were found" },
        source: {
          type: "string",
          enum: ["Agent", "Scout"],
          description: "Scout when you were sent to look for ideas (a scout run); default Agent",
        },
      },
      required: ["features", "kind", "title", "description"],
    },
    handler: async ({ features: given, kind, title, description, evidence, area, confirm, source }) => {
      if (!title?.trim() || !description?.trim()) throw new Error("Give `title` and `description`");
      const features = await featuresOf(given);
      if (!confirm) {
        const words = titleWords(title);
        const perWord = await Promise.all(
          words.map(async (w) =>
            (await d.search(w, 30, features)).map((h) => ({ id: h.id, title: firstLine(h.text) })),
          ),
        );
        const same = likelySame(perWord, words.length).slice(0, 5);
        if (same.length) {
          return {
            filed: false,
            likelySame: same.map((s) => ({ id: shortId(s.id), title: s.title })),
            next:
              "If it is one of these, add what you found to it (concepts__add); if it is new, call again with " +
              "confirm: true.",
          };
        }
      }
      const where = await areaOf(features, area);
      const { graph, ops } = await d.slice([where]);
      const { node } = await ops.addNewChild(where, title.trim());
      await ops.addNewChild(node, description.trim());
      if (evidence?.trim()) await ops.addNewChild(node, `Evidence: ${evidence.trim()}`);
      await ensureTags(graph, ops);
      const tags = ["Idea", kind === "bug" ? "Bug" : "Feature", source === "Scout" ? "Scout" : "Agent"];
      for (const name of tags) await ops.tag(node, tagIdOf(graph, name));
      return { filed: true, id: shortId(node), in: firstLine(graph.node(where)?.data.text ?? ""), tags };
    },
  });
  return { readMap };
}
