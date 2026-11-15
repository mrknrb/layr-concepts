// The threads that changed, mentioned or were linked to a node (layr_code migrations 0014, 0015): who a tool call acts
// for, and recording it on nodes. An agent names its thread itself (`thread`): in the new layr a Claude thread's id
// (the claude plugin's threads, `layr://claude/thread/<id>`); from layr_code a T3 thread's id or link, or a pipeline
// task's link. The hub is shared by every thread and can't tell them apart. A thread the pipeline holds is kept as its
// task, from proposal to landing. The rows are shared with layr_code, so its links (T3 threads, chats) still read.
import { AsyncLocalStorage } from "node:async_hooks";
const calls = new AsyncLocalStorage();
/** For `Ops`: the nodes a change touched belong to the tool call running it. */
export const touch = (nodes) => {
  const call = calls.getStore();
  if (call) for (const n of nodes) call.touched.add(n);
};
/** Who the running tool call acts for, if anyone: proposals keep it, so accepting one is still that thread's change. */
export const currentActor = () => calls.getStore()?.actor;
const T3_THREAD = "layr://t3threads/thread/";
const CLAUDE_THREAD = "layr://claude/thread/";
const TASK = "layr://pipeline/task/";
const KEEP_MS = 10 * 60_000;
/** A pipeline task's title as its links show it. */
export const taskTitle = (number, title) => `#${number}${title ? ` ${title}` : ""}`;
export function threads(ctx) {
  const known = new Map();
  /** Move the rows of `thread` to `to` (or only retitle them, `to.thread` being the same), or delete them (null). */
  const relink = (thread, to) => {
    for (const key of [thread, to?.thread]) if (key) known.delete(key);
    return ctx.tables.rpc("relink", {
      thread_key: thread,
      new_key: to?.thread ?? null,
      new_href: to ? (to.href ?? to.thread) : null,
      new_title: to?.title ?? null,
    });
  };
  /**
   * A T3 thread's title, or its pipeline task when the pipeline holds it: then the rows it made as a T3 thread (before
   * it was in the pipeline, or with an older layr) go to the task. Checks that the thread exists.
   */
  async function t3Thread(id) {
    const thread = T3_THREAD + encodeURIComponent(id);
    let title = null;
    if (await ctx.t3.connected().catch(() => false)) {
      try {
        const read = await ctx.t3.call("t3_thread_read", {
          threadId: id,
          limit: 1,
          maxCharsPerItem: 1,
        });
        title = read.thread.title || null;
      } catch {
        throw new Error(
          `No T3 thread "${id}": \`thread\` is your own thread's id, \`parentThreadId\` from T3's ` +
            "orchestrator_capabilities",
        );
      }
    }
    const task = await ctx.commands
      .run("pipeline.threads", {
        threadId: id,
      })
      .then((r) => r.threads[id])
      .catch(() => undefined);
    if (!task) return { thread, href: thread, title };
    const link = TASK + encodeURIComponent(task.taskId);
    const actor = { thread: link, href: link, title: taskTitle(task.number, task.title ?? title ?? "") };
    await relink(thread, actor).catch((error) => ctx.log(`could not move the links of ${thread}:`, String(error)));
    return actor;
  }
  /** A Claude thread of the claude plugin, with its title; refused when the claude plugin says there is no such thread. */
  async function claudeThread(id) {
    const thread = CLAUDE_THREAD + encodeURIComponent(id);
    const title = ctx.claude ? await ctx.claude.threadTitle(id) : null;
    return { thread, href: thread, title };
  }
  /** A pipeline task by its link, with its title; checks that it exists when the pipeline runs. */
  async function pipelineTask(link) {
    const id = decodeURIComponent(link.slice(TASK.length));
    const tasks = await ctx.commands.run("pipeline.tasks", { taskId: id }).catch(() => undefined);
    const task = tasks?.find((t) => t.taskId === id);
    if (tasks && !task) throw new Error(`No pipeline task "${id}"`);
    return { thread: link, href: link, title: task ? taskTitle(task.number, task.title) : null };
  }
  async function chat(link) {
    const id = decodeURIComponent(link.slice("layr://chat/chat/".length));
    const chats = await ctx.commands.run("chat.chats").catch(() => []);
    return { thread: link, href: link, title: chats.find((c) => c.id === id)?.title ?? null };
  }
  /**
   * Who a tool call acts for: the run's caller (an AI chat), else the thread the agent named (a T3 thread's id or
   * `layr://t3threads/thread/…` link, or a pipeline task's `layr://pipeline/task/…` link), else the Claude thread
   * that called (`call.thread`, from the hub's `_meta`: callerThread). None when none says.
   */
  async function actor(call, thread) {
    const named = thread?.trim();
    const link = named && (named.startsWith("layr://") ? named : CLAUDE_THREAD + encodeURIComponent(named));
    const key = call.caller ?? link ?? call.thread;
    if (!key) return undefined;
    const cached = known.get(key);
    if (cached && Date.now() - cached.at < KEEP_MS) return cached.actor;
    const found = key.startsWith("layr://chat/chat/")
      ? await chat(key)
      : key.startsWith(CLAUDE_THREAD)
        ? await claudeThread(decodeURIComponent(key.slice(CLAUDE_THREAD.length)))
        : key.startsWith(T3_THREAD)
          ? await t3Thread(decodeURIComponent(key.slice(T3_THREAD.length)))
          : key.startsWith(TASK)
            ? await pipelineTask(key)
            : { thread: key, href: key, title: null };
    known.set(key, { actor: found, at: Date.now() });
    return found;
  }
  /**
   * Record that `who` changed `nodes`, mentioned them (with a note) or was linked to them (by hand, or made from
   * them). Returns how many.
   */
  const mark = (who, nodes, what, note) =>
    ctx.tables.rpc("mark", {
      node_ids: nodes,
      thread_key: who.thread,
      link: who.href,
      thread_title: who.title,
      changed: what === "changed",
      note_text: note ?? null,
      linked: what === "linked",
    });
  /** Run a change as `who`: the nodes it touched are marked changed by that thread once it is done. */
  async function runAs(who, change) {
    const call = { actor: who, touched: new Set() };
    const result = await calls.run(call, change);
    if (who && call.touched.size) {
      await mark(who, [...call.touched], "changed").catch((error) =>
        ctx.log(`could not link ${call.touched.size} node(s) to ${who.thread}:`, String(error)),
      );
    }
    return result;
  }
  return { actor, mark, relink, runAs };
}
/**
 * The Claude thread that called a tool, as its link, from the MCP request's `_meta["layr/caller"]` (docs/ARCHITECTURE.md
 * › The MCP hub): the claude plugin gives each thread an agent token labelled with the thread's id. Else undefined.
 */
export function callerThread(meta) {
  const caller = meta?.["layr/caller"];
  if (caller?.kind !== "agent" || caller.plugin !== "claude") return undefined;
  const id = String(caller.label ?? "").trim();
  return /^t_[A-Za-z0-9_-]+$/.test(id) ? CLAUDE_THREAD + encodeURIComponent(id) : undefined;
}
/** A thread link as a line for the AI: title, what it did, when, and its note. */
export function describeThread(t) {
  const when = (at) => `${at.slice(0, 16).replace("T", " ")} UTC`;
  const did = [
    t.linked_at ? `linked ${when(t.linked_at)}` : "",
    t.changed_at ? `changed it ${when(t.changed_at)}` : "",
    t.mentioned_at ? `mentioned it ${when(t.mentioned_at)}` : "",
  ].filter(Boolean);
  const note = t.note ? `: ${t.note}` : "";
  return `[${(t.title ?? "Untitled thread").replace(/[[\]\n]/g, " ")}](${t.href}) ${did.join(", ")}${note}`;
}
