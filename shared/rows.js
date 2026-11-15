export const TABLES = {
  nodes: "nodes",
  groups: "groups",
  edges: "edges",
  views: "views",
  details: "details",
  pages: "pages",
  images: "images",
  looks: "looks",
  settings: "settings",
  proposals: "proposals",
  threads: "threads",
  tagSets: "tag_sets",
  tags: "tags",
  nodeTags: "node_tags",
};
/** Colours a tag can have (none: gray). */
export const TAG_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
export const nodeRow = ({ id, data, created_at }) => ({
  id,
  text: data.text,
  unordered: !!data.unordered,
  ...(data.color ? { color: data.color } : {}),
  created_at,
});
export const groupRow = ({ id, data, created_at }) => ({
  id,
  parent: data.from,
  child: data.to,
  pos: data.pos,
  created_at,
});
export const edgeRow = ({ id, data, created_at }) => ({
  id,
  from_node: data.from,
  to_node: data.to,
  type: data.relation ?? null,
  label: data.label ?? null,
  in_group: data.in ?? null,
  created_at,
});
export const viewRow = ({ id, data, created_at }) => ({
  id,
  root: data.root,
  name: data.name ?? null,
  created_at,
});
export const detailRow = ({ id, data, created_at }) => ({
  id,
  node: data.node,
  kind: data.kind,
  text: data.text,
  outdated: !!data.outdated,
  created_at,
});
const nodeRec = (r) => ({
  id: r.id,
  data: {
    text: r.text,
    ...(r.unordered ? { unordered: true } : {}),
    ...(r.color ? { color: r.color } : {}),
    ...(r.prototype ? { prototype: true } : {}),
    ...(r.image ? { image: true } : {}),
    ...(r.image && r.caption ? { caption: r.caption } : {}),
  },
  created_at: r.created_at,
});
const groupRec = (r) => ({
  id: r.id,
  data: {
    type: "group",
    from: r.parent,
    to: r.child,
    pos: r.pos,
  },
  created_at: r.created_at,
});
const edgeRec = (r) => ({
  id: r.id,
  data: {
    type: "edge",
    from: r.from_node,
    to: r.to_node,
    ...(r.type ? { relation: r.type } : {}),
    ...(r.label ? { label: r.label } : {}),
    ...(r.in_group ? { in: r.in_group } : {}),
  },
  created_at: r.created_at,
});
const viewRec = (r) => ({
  id: r.id,
  data: {
    root: r.root,
    ...(r.name ? { name: r.name } : {}),
  },
  created_at: r.created_at,
});
const detailRec = (r) => ({
  id: r.id,
  data: { node: r.node, kind: r.kind, text: r.text, ...(r.outdated ? { outdated: true } : {}) },
  created_at: r.created_at,
});
/**
 * Put a row into the graph (from `tables.select`, a bundle or a live change), or remove one (a delete carries only
 * the id). Counts are not touched: bundles bring them, and live changes adjust them (`live.ts`).
 */
export function applyRow(graph, table, op, row) {
  if (op === "delete") {
    if (table === TABLES.nodes) graph.deleteNode(row.id);
    else if (table === TABLES.views) graph.deleteView(row.id);
    else if (table === TABLES.details) graph.deleteDetail(row.id);
    else if (table === TABLES.looks) graph.deleteLook(row.id);
    else if (table === TABLES.tags) graph.deleteTag(row.id);
    else if (table === TABLES.tagSets) graph.deleteTagSet(row.id);
    else if (table === TABLES.nodeTags) graph.deleteNodeTag(row.id);
    else if (table === TABLES.groups || table === TABLES.edges) graph.deleteConn(row.id);
  } else if (table === TABLES.nodes) {
    const info = row;
    graph.setNode(nodeRec(info));
    if (typeof info.children === "number") {
      graph.counts.set(info.id, { children: info.children, parents: info.parents, threads: info.threads ?? 0 });
    }
    if (Array.isArray(info.tags)) {
      graph.setNodeTags(
        info.id,
        info.tags.map((t) => ({ ...t, node: info.id, created_at: info.created_at })),
      );
    }
  } else if (table === TABLES.groups) graph.setConn(groupRec(row));
  else if (table === TABLES.edges) graph.setConn(edgeRec(row));
  else if (table === TABLES.views) graph.setView(viewRec(row));
  else if (table === TABLES.details) graph.setDetail(detailRec(row));
  else if (table === TABLES.looks) graph.setLook(row);
  else if (table === TABLES.tags) graph.setTag(row);
  else if (table === TABLES.tagSets) graph.setTagSet(row);
  else if (table === TABLES.nodeTags) graph.setNodeTag(row);
  else if (table === TABLES.settings) graph.edgeTypes = row.edge_types ?? undefined;
}
/** Add a bundle to the graph: its rows, and which nodes' children it brings. */
export function applyBundle(graph, bundle) {
  if (!bundle) return;
  for (const row of bundle.tags ?? []) applyRow(graph, TABLES.tags, "insert", row);
  for (const row of bundle.nodes) applyRow(graph, TABLES.nodes, "insert", row);
  for (const row of bundle.groups) applyRow(graph, TABLES.groups, "insert", row);
  for (const row of bundle.edges) applyRow(graph, TABLES.edges, "insert", row);
  for (const row of bundle.details) applyRow(graph, TABLES.details, "insert", row);
  if (bundle.view) applyRow(graph, TABLES.views, "insert", bundle.view);
  for (const row of bundle.looks ?? []) applyRow(graph, TABLES.looks, "insert", row);
  for (const id of bundle.expanded ?? []) graph.expanded.add(id);
}
