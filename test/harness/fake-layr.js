// A stand-in for the core's /_layr/layr.js in test/ui.e2e.js: the panel runs in a plain browser page with the concept
// map's tables in memory (the same calls as shared/supabase.js gives, `rpc`s included, shaped as the database's), so
// its parts can be clicked through and photographed without a core or an account. `window.__seed` fills the tables;
// `window.__layr` records what the panel asked of layr (notifications, panels opened, tool calls).
(function () {
  const seed = window.__seed ?? {};
  const T = {};
  for (const name of [
    "nodes",
    "groups",
    "edges",
    "views",
    "details",
    "pages",
    "images",
    "looks",
    "settings",
    "proposals",
    "threads",
    "tag_sets",
    "tags",
    "node_tags",
  ])
    T[name] = (seed[name] ?? []).map((r) => ({ ...r }));
  const now = () => new Date().toISOString();
  const uid = () => crypto.randomUUID();
  const record = (window.__layr = { notes: [], opened: [], calls: [], state: null, title: "" });

  const matches = (row, filter = {}) =>
    Object.entries(filter).every(([k, v]) =>
      Array.isArray(v) ? v.includes(row[k]) : v === null ? row[k] == null : row[k] === v,
    );
  const later = (v) => new Promise((resolve) => setTimeout(() => resolve(structuredClone(v)), 5));

  const childrenOf = (p) =>
    T.groups.filter((g) => g.parent === p).sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : 0));
  const parentsOf = (n) => T.groups.filter((g) => g.child === n);
  function nodeJson(n) {
    return {
      ...n,
      prototype: T.pages.some((p) => p.node === n.id),
      image: T.images.some((p) => p.node === n.id),
      children: childrenOf(n.id).length,
      parents: parentsOf(n.id).length,
      threads: T.threads.filter((t) => t.node === n.id).length,
      tags: T.node_tags.filter((t) => t.node === n.id).map((t) => ({ id: t.id, tag: t.tag })),
    };
  }
  /** A bundle of these nodes (and these groups): their edges among what it holds, details and tags. */
  function bundle(ids, groups = [], expanded = []) {
    const set = new Set(ids);
    const nodes = T.nodes.filter((n) => set.has(n.id)).map(nodeJson);
    const edges = T.edges.filter((e) => set.has(e.from_node) || set.has(e.to_node));
    for (const e of edges)
      for (const id of [e.from_node, e.to_node, e.type])
        if (id && !set.has(id)) {
          const n = T.nodes.find((x) => x.id === id);
          if (n) {
            set.add(id);
            nodes.push(nodeJson(n));
          }
        }
    return { nodes, groups, edges, details: T.details.filter((d) => set.has(d.node)), expanded };
  }
  function level(parents, skip = 0, size = 100) {
    const groups = parents.flatMap((p) => childrenOf(p).slice(skip, skip + size));
    return bundle([...parents, ...groups.map((g) => g.child)], groups, parents);
  }
  function path(id) {
    const out = [];
    let at = parentsOf(id)[0]?.parent;
    const seen = new Set();
    while (at && !seen.has(at)) {
      seen.add(at);
      out.unshift({ id: at, text: T.nodes.find((n) => n.id === at)?.text ?? "" });
      at = parentsOf(at)[0]?.parent;
    }
    return out;
  }
  const RPC = {
    view: ({ view_id, page_size }) => {
      const view = T.views.find((v) => v.id === view_id);
      const b = level([view.root], 0, page_size);
      return { ...b, view, looks: T.looks.filter((l) => l.view === view_id) };
    },
    level: ({ parents, skip, page_size }) => level(parents, skip, page_size),
    get: ({ ids }) => bundle(ids),
    search: ({ q, max_hits }) =>
      T.nodes
        .filter((n) => n.text.toLowerCase().includes(q.toLowerCase()))
        .slice(0, max_hits)
        .map((n) => ({ id: n.id, text: n.text, path: path(n.id) })),
    where: ({ node_id }) => ({
      parents: parentsOf(node_id).map((g) => ({
        id: g.parent,
        text: T.nodes.find((n) => n.id === g.parent)?.text ?? "",
      })),
    }),
    types: () => {
      const node = T.settings[0]?.edge_types;
      return {
        types: node
          ? childrenOf(node).map((g) => ({
              id: g.child,
              text: T.nodes.find((n) => n.id === g.child)?.text,
              meaning: null,
            }))
          : [],
      };
    },
    unplaced: () => {
      const roots = new Set(T.views.map((v) => v.root));
      const nodes = T.nodes.filter((n) => !parentsOf(n.id).length && !roots.has(n.id));
      return { nodes: nodes.slice(0, 50).map((n) => ({ id: n.id, text: n.text })), total: nodes.length };
    },
    tag_counts: () => Object.fromEntries(T.tags.map((t) => [t.id, T.node_tags.filter((x) => x.tag === t.id).length])),
    mark: (a) => {
      for (const node of a.node_ids) {
        T.threads.push({
          id: uid(),
          node,
          thread: a.thread_key,
          href: a.link,
          title: a.thread_title,
          at: now(),
          linked_at: a.linked ? now() : null,
          changed_at: a.changed ? now() : null,
          mentioned_at: null,
          note: a.note_text,
        });
      }
      return a.node_ids.length;
    },
  };
  const cascade = (table, rows) => {
    if (table !== "nodes") return;
    const ids = new Set(rows.map((r) => r.id));
    T.groups = T.groups.filter((g) => !ids.has(g.parent) && !ids.has(g.child));
    T.edges = T.edges.filter((e) => !ids.has(e.from_node) && !ids.has(e.to_node) && !ids.has(e.in_group));
    T.looks = T.looks.filter((l) => !ids.has(l.node));
    T.node_tags = T.node_tags.filter((t) => !ids.has(t.node));
    T.views = T.views.filter((v) => !ids.has(v.root));
  };
  window.conceptsTestTables = {
    select: (table, filter) => later(T[table].filter((r) => matches(r, filter))),
    insert: (table, rows) => {
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: uid(), created_at: now(), ...r }));
      // A tag of a one-per-node set replaces the node's other tag of that set (the database's trigger).
      if (table === "node_tags") {
        for (const r of list) {
          const set = T.tags.find((t) => t.id === r.tag)?.tag_set;
          if (!T.tag_sets.find((s) => s.id === set)?.single) continue;
          const same = new Set(T.tags.filter((t) => t.tag_set === set).map((t) => t.id));
          T.node_tags = T.node_tags.filter((x) => x.node !== r.node || !same.has(x.tag));
        }
      }
      T[table].push(...list);
      return later(Array.isArray(rows) ? list : list[0]);
    },
    upsert: (table, rows) => {
      for (const r of rows) {
        const i = T[table].findIndex((x) => x.id === r.id);
        if (i >= 0) T[table][i] = { ...T[table][i], ...r };
        else T[table].push({ created_at: now(), ...r });
      }
      return later(rows);
    },
    update: (table, filter, values) => {
      for (const r of T[table]) if (matches(r, filter)) Object.assign(r, values);
      return later(null);
    },
    delete: (table, filter) => {
      const gone = T[table].filter((r) => matches(r, filter));
      T[table] = T[table].filter((r) => !matches(r, filter));
      cascade(table, gone);
      return later(null);
    },
    rpc: (name, args) => {
      if (!RPC[name]) return Promise.reject(new Error(`No rpc ${name} in the test tables`));
      return later(RPC[name](args ?? {}));
    },
  };
  window.conceptsTestStorage = {
    signedUrl: async () => "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>",
    upload: async () => null,
    remove: async () => null,
  };
  window.__tables = T;

  const params = new URLSearchParams(location.search);
  const theme = params.get("theme") ?? "dark";
  document.documentElement.setAttribute("data-theme", theme);
  const listeners = new Map();
  const info = {
    plugin: "concepts",
    panel: location.pathname.includes("prototypes") ? "prototypes" : "map",
    instance: "p_test",
    params: JSON.parse(params.get("params") ?? "{}"),
    state: JSON.parse(params.get("state") ?? "null"),
    device: { id: "d_test", kind: "pc", name: "Test" },
    theme: { mode: theme },
  };
  const otherTools = seed.otherTools ?? {};
  window.layr = {
    ready: Promise.resolve(),
    info,
    errors: { NOT_AVAILABLE: -32003 },
    call: async (method, p) => {
      record.calls.push({ method, params: p });
      return null;
    },
    tools: {
      run: async (tool, args, opts = {}) => {
        record.calls.push({ tool, args, plugin: opts.plugin ?? "concepts" });
        const fake = otherTools[`${opts.plugin ?? "concepts"}__${tool}`];
        if (fake !== undefined) return structuredClone(fake);
        throw new Error(`No tool ${tool} in the test`);
      },
      list: async ({ plugin } = {}) =>
        Object.keys(otherTools)
          .filter((k) => k.startsWith(`${plugin}__`))
          .map((k) => ({ plugin, name: k.slice(plugin.length + 2) })),
    },
    panel: {
      setState: async (s) => void (record.state = s),
      setTitle: async (t) => void (record.title = t),
      onParams: (fn) => (listeners.set("params", fn), () => {}),
    },
    panels: { open: async (panel, p, opts) => void record.opened.push({ panel, params: p, opts }) },
    ui: { notify: async (text, kind) => void record.notes.push({ text, kind }) },
    events: { on: () => () => {}, emit: async () => null },
  };
})();
