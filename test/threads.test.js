import { describe, expect, it } from "./expect.js";
import { callerThread, currentActor, describeThread, threads, touch } from "../backend/threads.js";
/** The parts of a plugin context the thread links use, recording `mark` calls. */
function fakeCtx(options = {}) {
  const marks = [];
  const t3Reads = [];
  const claudeReads = [];
  const ctx = {
    claude: {
      threadTitle: async (id) => {
        claudeReads.push(id);
        if (id === "gone") throw new Error(`No thread "${id}"`);
        return "Tidy the map";
      },
    },
    t3: {
      connected: async () => options.t3 ?? true,
      call: async (_tool, args) => {
        t3Reads.push(args.threadId);
        if (args.threadId === "gone") throw new Error("Thread not found");
        return { thread: { title: "Fix login" } };
      },
    },
    commands: {
      run: async (id, args) => {
        if (id === "chat.chats") return [{ id: "c1", title: "Pancakes" }];
        if (id === "pipeline.threads" && options.pipeline) {
          return { projects: [], threads: { [args.threadId]: { taskId: "task-7", number: 7, title: "Login" } } };
        }
        throw new Error(`No backend handles ${id}`);
      },
    },
    // The pipeline's `task` tool through the hub: task 7 (layr_code's id "task-7") is there, others aren't.
    pipeline: options.pipeline
      ? { task: async (id) => (id === "7" || id === "task-7" ? { number: 7, title: "Login" } : null) }
      : undefined,
    tables: {
      rpc: async (name, args) => {
        marks.push({ name, ...args });
        return (args.node_ids ?? []).length;
      },
    },
    log: () => {},
  };
  return { ctx, marks, t3Reads, claudeReads };
}
describe("thread links", () => {
  it("finds a thread of the threads plugin by its id, with its title, once", async () => {
    const { ctx, claudeReads } = fakeCtx();
    const links = threads(ctx);
    const who = await links.actor({}, "th_1");
    expect(who).toEqual({
      thread: "layr://threads/thread/th_1",
      href: "layr://threads/thread/th_1",
      title: "Tidy the map",
    });
    expect(await links.actor({}, "layr://threads/thread/th_1")).toEqual(who);
    expect(claudeReads).toEqual(["th_1"]);
    // Its link from before the plugin was renamed (`claude`) is the same thread, under the new link.
    expect(await links.actor({}, "layr://claude/thread/th_1")).toEqual(who);
    await expect(links.actor({}, "gone")).rejects.toThrow(/No thread "gone"/);
    // Without the threads plugin, it can't tell the title.
    const bare = fakeCtx().ctx;
    delete bare.claude;
    expect((await threads(bare).actor({}, "th_2"))?.title).toBeNull();
  });
  it("finds a T3 thread by its link (from layr_code), with its title, once", async () => {
    const { ctx, t3Reads } = fakeCtx();
    const links = threads(ctx);
    const who = await links.actor({}, "layr://t3threads/thread/mcp%3Aabc");
    expect(who).toEqual({
      thread: "layr://t3threads/thread/mcp%3Aabc",
      href: "layr://t3threads/thread/mcp%3Aabc",
      title: "Fix login",
    });
    expect(await links.actor({}, "layr://t3threads/thread/mcp%3Aabc")).toEqual(who);
    expect(t3Reads).toEqual(["mcp:abc"]);
  });
  it("keeps a pipeline thread as its task, and moves what it did as a T3 thread there", async () => {
    const { ctx, marks } = fakeCtx({ pipeline: true });
    const task = { thread: "layr://pipeline/task/task-7", href: "layr://pipeline/task/task-7", title: "#7 Login" };
    expect(await threads(ctx).actor({}, "layr://t3threads/thread/t1")).toEqual(task);
    expect(marks).toEqual([
      {
        name: "relink",
        thread_key: "layr://t3threads/thread/t1",
        new_key: task.thread,
        new_href: task.thread,
        new_title: "#7 Login",
      },
    ]);
  });
  it("moves a thread's rows under its old `claude` link with it, and retitles them in place", async () => {
    const { ctx, marks } = fakeCtx();
    const links = threads(ctx);
    const task = { thread: "layr://pipeline/task/task-7", title: "#7 Login" };
    await links.relink("layr://threads/thread/t1", task);
    expect(marks.map((m) => [m.thread_key, m.new_key])).toEqual([
      ["layr://threads/thread/t1", task.thread],
      ["layr://claude/thread/t1", task.thread],
    ]);
    marks.length = 0;
    await links.relink("layr://threads/thread/t1", { thread: "layr://threads/thread/t1", title: "New title" });
    expect(marks.map((m) => [m.thread_key, m.new_key, m.new_title])).toEqual([
      ["layr://threads/thread/t1", "layr://threads/thread/t1", "New title"],
      ["layr://claude/thread/t1", "layr://claude/thread/t1", "New title"],
    ]);
    marks.length = 0;
    await links.relink("layr://pipeline/task/task-7", null);
    expect(marks.map((m) => [m.thread_key, m.new_key])).toEqual([["layr://pipeline/task/task-7", null]]);
  });
  it("takes a pipeline task's link as the thread, and refuses one the pipeline doesn't have", async () => {
    const links = threads(fakeCtx({ pipeline: true }).ctx);
    expect(await links.actor({}, "layr://pipeline/task/task-7")).toEqual({
      thread: "layr://pipeline/task/task-7",
      href: "layr://pipeline/task/task-7",
      title: "#7 Login",
    });
    await expect(links.actor({}, "layr://pipeline/task/9")).rejects.toThrow(/No pipeline task "9"/);
    // Without the pipeline running, it can't tell.
    expect((await threads(fakeCtx().ctx).actor({}, "layr://pipeline/task/9"))?.title).toBeNull();
  });
  it("marks a link, a mention and a change apart", async () => {
    const { ctx, marks } = fakeCtx();
    const links = threads(ctx);
    const who = { thread: "layr://pipeline/task/7", href: "layr://pipeline/task/7", title: "#7 Login" };
    await links.mark(who, ["n1"], "linked");
    await links.mark(who, ["n1"], "mentioned", "kept the cache");
    expect(marks).toEqual([
      expect.objectContaining({ node_ids: ["n1"], changed: false, linked: true, note_text: null }),
      expect.objectContaining({ node_ids: ["n1"], changed: false, linked: false, note_text: "kept the cache" }),
    ]);
  });
  it("refuses a thread T3 doesn't know, and works without T3", async () => {
    const gone = "layr://t3threads/thread/gone";
    await expect(threads(fakeCtx().ctx).actor({}, gone)).rejects.toThrow(/No T3 thread "gone"/);
    const offline = await threads(fakeCtx({ t3: false }).ctx).actor({}, gone);
    expect(offline?.title).toBeNull();
  });
  it("takes the run's caller (an AI chat) over a named thread, and nobody without either", async () => {
    const links = threads(fakeCtx().ctx);
    expect(await links.actor({ caller: "layr://chat/chat/c1" }, "t1")).toEqual({
      thread: "layr://chat/chat/c1",
      href: "layr://chat/chat/c1",
      title: "Pancakes",
    });
    expect(await links.actor({})).toBeUndefined();
    expect(await links.actor({}, "  ")).toBeUndefined();
  });
  it("marks the nodes a change touched as changed by its thread, each call on its own", async () => {
    const { ctx, marks } = fakeCtx();
    const links = threads(ctx);
    const a = { thread: "layr://t3threads/thread/a", href: "layr://t3threads/thread/a", title: "A" };
    const b = { thread: "layr://t3threads/thread/b", href: "layr://t3threads/thread/b", title: "B" };
    const work = (nodes) => async () => {
      touch([nodes[0]]);
      await new Promise((r) => setTimeout(r, 5));
      touch(nodes);
      return currentActor()?.title;
    };
    const results = await Promise.all([links.runAs(a, work(["n1", "n2"])), links.runAs(b, work(["n3"]))]);
    expect(results).toEqual(["A", "B"]);
    expect(marks).toHaveLength(2);
    expect(marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "mark", thread_key: a.thread, node_ids: ["n1", "n2"], changed: true }),
        expect.objectContaining({ name: "mark", thread_key: b.thread, node_ids: ["n3"], changed: true }),
      ]),
    );
    await links.runAs(undefined, work(["n4"]));
    await links.runAs(a, async () => {});
    expect(marks).toHaveLength(2);
  });
  it("knows the calling thread from the hub's _meta, unless `thread` names one", async () => {
    const agent = (label, plugin = "threads") => ({ "layr/caller": { kind: "agent", plugin, label } });
    expect(callerThread(agent("t_k3j9x2m1q8"))).toBe("layr://threads/thread/t_k3j9x2m1q8");
    expect(callerThread(agent("t_k3j9x2m1q8", "claude"))).toBe("layr://threads/thread/t_k3j9x2m1q8");
    expect(callerThread(agent("Claude Code threads"))).toBe(undefined);
    expect(callerThread(agent("t_1", "other"))).toBe(undefined);
    expect(callerThread({ "layr/caller": { kind: "backend", plugin: "threads" } })).toBe(undefined);
    expect(callerThread(undefined)).toBe(undefined);
    const { ctx, claudeReads } = fakeCtx();
    const links = threads(ctx);
    const call = { thread: callerThread(agent("t_abc")) };
    expect((await links.actor(call, undefined)).thread).toBe("layr://threads/thread/t_abc");
    expect((await links.actor(call, "layr://pipeline/task/7")).thread).toBe("layr://pipeline/task/7");
    expect(claudeReads).toEqual(["t_abc"]);
  });
  it("describes a link for the AI", () => {
    const line = describeThread({
      title: "Fix [login]",
      href: "layr://pipeline/task/7",
      changed_at: "2026-10-28T10:00:00Z",
      mentioned_at: "2026-10-28T11:30:00Z",
      linked_at: "2026-10-27T09:00:00Z",
      note: "decided to keep the cache",
    });
    expect(line).toBe(
      "[Fix  login ](layr://pipeline/task/7) linked 2026-10-27 09:00 UTC, changed it 2026-10-28 10:00 UTC, " +
        "mentioned it 2026-10-28 11:30 UTC: decided to keep the cache",
    );
  });
});
