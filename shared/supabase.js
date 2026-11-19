// The concept map's tables and files in the user's Supabase, as the signed-in user (docs/ARCHITECTURE.md › Supabase
// for plugins): PostgREST and Storage over fetch, so the backend (Node) and the panel (a browser) use the same code.
// It gives what layr_code's plugin tables gave (`select`, `insert`, `upsert`, `update`, `delete`, `rpc`; layr_code
// packages/protocol/src/tables.ts) and its plugin storage (`upload`, `download`, `list`, `remove`), so the shared code
// ported from there runs unchanged. Row level security keeps every call to the user's own rows (`auth.uid()`).

/** The plugin whose tables (`concepts_<name>`) and Storage folder (`<user id>/concepts/…`) these are. */
const PLUGIN = "concepts";
/** One private bucket for every plugin's files (layr_code migration 0023). */
export const BUCKET = "plugin-files";
/** Rows per request: PostgREST answers at most 1000, so longer lists are read in pages. */
const PAGE = 1000;
/** Values in one `in.(…)` filter: longer lists are split, so the address stays short enough. */
const IN_CHUNK = 150;

/** The Postgres table behind a plugin table name. */
export function pluginTable(name) {
  const table = `${PLUGIN}_${name}`;
  if (!/^[a-z][a-z0-9]*_[a-z][a-z0-9_]*$/.test(table)) throw new Error(`Not a plugin table name: "${table}"`);
  return table;
}

/** Where a file is in the bucket; refuses paths that would leave the plugin's folder. */
export function storagePath(userId, path) {
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i.test(path)) throw new Error(`Not a file path: "${path}"`);
  return `${userId}/${PLUGIN}/${path}`;
}

/** The filter's conditions; refuses an empty filter where every row would match (`update`, `delete`). */
function filterEntries(filter, required = false) {
  const entries = Object.entries(filter ?? {});
  for (const [column] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(column)) throw new Error(`Not a column name: "${column}"`);
  }
  if (required && !entries.length) throw new Error("Give a filter; it would change every row");
  return entries;
}

/** A value inside `in.(…)`: always quoted, so commas and parentheses in it can't split it. */
const quoted = (v) => `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** PostgREST query parameters for filter entries: `eq`, `is.null`, `in` for arrays. */
function filterParams(entries) {
  return entries.map(([column, value]) => {
    if (Array.isArray(value)) return `${column}=in.(${value.map(quoted).join(",")})`;
    if (value === null) return `${column}=is.null`;
    return `${column}=eq.${encodeURIComponent(String(value))}`;
  });
}

/** Filters with a long array split into several, each with a short enough `in` list (empty arrays match nothing). */
function splitFilter(entries) {
  const long = entries.findIndex(([, v]) => Array.isArray(v) && v.length > IN_CHUNK);
  if (long < 0) return [entries];
  const [column, values] = entries[long];
  const parts = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    const part = entries.slice();
    part[long] = [column, values.slice(i, i + IN_CHUNK)];
    parts.push(...splitFilter(part));
  }
  return parts;
}

const list = (rows) => (Array.isArray(rows) ? rows : [rows]);

/** The message of a failed PostgREST or Storage answer. */
async function failure(res, what) {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const body = JSON.parse(text);
    message = body.message || body.error_description || body.msg || body.error || text;
    if (body.details) message += ` (${body.details})`;
  } catch {
    // not JSON
  }
  const error = new Error(`${what}: ${message || res.statusText} (${res.status})`);
  error.status = res.status;
  error.code = (() => {
    try {
      return JSON.parse(text).code;
    } catch {
      return undefined;
    }
  })();
  return error;
}

/**
 * The client. `session({ fresh })` gives `{url, key, accessToken, expiresAt, userId}` (layr__supabase_session);
 * it is asked again when the token is about to expire, and once more (fresh) after a 401. `headers` go with every
 * database request (the backend says `x-layr-actor: ai`, so the history can tell the AI's changes from the user's).
 */
export function createSupabase({ session, headers = {}, fetch: fetcher = globalThis.fetch.bind(globalThis) }) {
  let current = null;
  let asking = null;

  async function auth(fresh = false) {
    const now = Date.now() / 1000;
    if (!fresh && current && (!current.expiresAt || current.expiresAt - now > 60)) return current;
    asking ??= Promise.resolve(session({ fresh })).finally(() => (asking = null));
    current = await asking;
    if (!current?.accessToken) throw new Error("Not signed in: sign in to layr (Settings) to use the concept map");
    return current;
  }

  /** A request with the user's token; a 401 asks for a fresh session and tries once more. */
  async function request(path, init = {}, what = "Request") {
    for (let attempt = 0; ; attempt++) {
      const s = await auth(attempt > 0);
      const res = await fetcher(`${s.url}${path}`, {
        ...init,
        headers: { apikey: s.key, Authorization: `Bearer ${s.accessToken}`, ...init.headers },
      });
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) throw await failure(res, what);
      return res;
    }
  }

  const json = async (res) => {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  const dbHeaders = (extra = {}) => ({ "Content-Type": "application/json", ...headers, ...extra });
  /** `columns=` for a bulk write: every key any row has, so rows may differ in which they give. */
  const columns = (rows) => [...new Set(rows.flatMap((r) => Object.keys(r)))].map((c) => `"${c}"`).join(",");
  const own = async (rows) => {
    const { userId } = await auth();
    return list(rows).map((row) => ({ ...row, user_id: userId }));
  };

  const tables = {
    /** Rows matching `filter` (all rows without one), in pages, so any number of rows. */
    async select(name, filter) {
      const table = pluginTable(name);
      const rows = [];
      for (const part of splitFilter(filterEntries(filter))) {
        if (part.some(([, v]) => Array.isArray(v) && !v.length)) continue;
        for (let offset = 0; ; offset += PAGE) {
          const params = ["select=*", ...filterParams(part), "order=id", `offset=${offset}`, `limit=${PAGE}`];
          const res = await request(
            `/rest/v1/${table}?${params.join("&")}`,
            { headers: dbHeaders() },
            `Reading ${name}`,
          );
          const page = await json(res);
          rows.push(...page);
          if (page.length < PAGE) break;
        }
      }
      return rows;
    },
    /** Returns the saved rows, with their defaults (`id`, `created_at`, …). */
    async insert(name, rows) {
      const body = await own(rows);
      const res = await request(
        `/rest/v1/${pluginTable(name)}?columns=${encodeURIComponent(columns(body))}`,
        {
          method: "POST",
          headers: dbHeaders({ Prefer: "return=representation,missing=default" }),
          body: JSON.stringify(body),
        },
        `Saving ${name}`,
      );
      return json(res);
    },
    /** Insert, or replace the given columns of rows whose `id` exists, in one statement. */
    async upsert(name, rows) {
      const body = await own(rows);
      const res = await request(
        `/rest/v1/${pluginTable(name)}?on_conflict=id&columns=${encodeURIComponent(columns(body))}`,
        {
          method: "POST",
          headers: dbHeaders({ Prefer: "return=representation,resolution=merge-duplicates,missing=default" }),
          body: JSON.stringify(body),
        },
        `Saving ${name}`,
      );
      return json(res);
    },
    /** Change the rows matching `filter` (which must not be empty). Returns them. */
    async update(name, filter, patch) {
      const { user_id: _, ...values } = patch;
      const out = [];
      for (const part of splitFilter(filterEntries(filter, true))) {
        const res = await request(
          `/rest/v1/${pluginTable(name)}?${filterParams(part).join("&")}`,
          { method: "PATCH", headers: dbHeaders({ Prefer: "return=representation" }), body: JSON.stringify(values) },
          `Changing ${name}`,
        );
        out.push(...(await json(res)));
      }
      return out;
    },
    /** Delete the rows matching `filter` (which must not be empty); foreign keys may cascade. */
    async delete(name, filter) {
      for (const part of splitFilter(filterEntries(filter, true))) {
        await request(
          `/rest/v1/${pluginTable(name)}?${filterParams(part).join("&")}`,
          { method: "DELETE", headers: dbHeaders() },
          `Deleting ${name}`,
        );
      }
    },
    /** The plugin's function `concepts_<name>` with `args` plus `caller` (every one takes it; migration 0008). */
    async rpc(name, args = {}) {
      const { userId } = await auth();
      const res = await request(
        `/rest/v1/rpc/${pluginTable(name)}`,
        { method: "POST", headers: dbHeaders(), body: JSON.stringify({ ...args, caller: userId }) },
        `Reading ${name}`,
      );
      return json(res);
    },
    /** Live changes aren't followed here: the backend emits `concepts:changed` after its writes instead. */
    subscribe() {
      return () => {};
    },
  };

  const objectPath = async (path) => {
    const { userId } = await auth();
    return storagePath(userId, path).split("/").map(encodeURIComponent).join("/");
  };

  const storage = {
    /** Save a file (`data` in base64). */
    async upload(path, data, mimeType) {
      const bytes = typeof data === "string" ? base64ToBytes(data) : data;
      await request(
        `/storage/v1/object/${BUCKET}/${await objectPath(path)}`,
        { method: "POST", headers: { "Content-Type": mimeType, "x-upsert": "false" }, body: bytes },
        "Saving the picture",
      );
    },
    /** A file as `{data (base64), mimeType}`. */
    async download(path) {
      const res = await request(
        `/storage/v1/object/authenticated/${BUCKET}/${await objectPath(path)}`,
        {},
        "Reading the picture",
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { data: bytesToBase64(bytes), mimeType: res.headers.get("content-type") ?? "application/octet-stream" };
    },
    /** The files in a folder (not its subfolders): `[{path, created_at}]`. */
    async list(folder) {
      const { userId } = await auth();
      const prefix = storagePath(userId, folder);
      const files = [];
      for (let offset = 0; ; offset += PAGE) {
        const res = await request(
          `/storage/v1/object/list/${BUCKET}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: "name", order: "asc" } }),
          },
          "Listing pictures",
        );
        const page = (await json(res)) ?? [];
        // Subfolders come back too, without an id.
        for (const { id, name, created_at } of page)
          if (id && created_at) files.push({ path: `${folder}/${name}`, created_at });
        if (page.length < PAGE) return files;
      }
    },
    async remove(paths) {
      if (!paths.length) return;
      const { userId } = await auth();
      await request(
        `/storage/v1/object/${BUCKET}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prefixes: paths.map((p) => storagePath(userId, p)) }),
        },
        "Deleting pictures",
      );
    },
    /** A short-lived address that shows the file (for `<img>`). */
    async signedUrl(path, expiresIn = 3600) {
      const s = await auth();
      const res = await request(
        `/storage/v1/object/sign/${BUCKET}/${await objectPath(path)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn }) },
        "Showing the picture",
      );
      const { signedURL } = await json(res);
      return `${s.url}/storage/v1${signedURL}`;
    },
  };

  return { tables, storage, auth };
}

export function base64ToBytes(b64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
