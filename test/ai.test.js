import { describe, expect, it } from "./expect.js";
import { COMMAND_TOOLS, createContext } from "../backend/context.js";
/** A hub that offers the given tools and answers `claude__ask` with `answer`, recording the calls. */
function fakeHub(names, answer = { text: "A short version.", model: "haiku" }) {
  const calls = [];
  return {
    calls,
    available: true,
    toolNames: async () => names,
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === "claude__ask") return answer;
      throw new Error(`No tool ${name}`);
    },
  };
}
const supabase = { tables: {}, storage: {} };

describe("AI through the claude plugin's ask", () => {
  it("is available only when the hub offers claude__ask", async () => {
    expect(await createContext({ supabase, hub: fakeHub(["claude__ask"]) }).ctx.ai.available()).toBe(true);
    expect(await createContext({ supabase, hub: fakeHub(["claude__usage"]) }).ctx.ai.available()).toBe(false);
    const noHub = { ...fakeHub(["claude__ask"]), available: false };
    expect(await createContext({ supabase, hub: noHub }).ctx.ai.available()).toBe(false);
  });
  it("runs a one-shot answer with haiku by default", async () => {
    const hub = fakeHub(["claude__ask"]);
    const { ctx } = createContext({ supabase, hub });
    const r = await ctx.ai.run({ system: "Be short.", prompt: "Outline" });
    expect(r.text).toBe("A short version.");
    expect(hub.calls[0]).toEqual({
      name: "claude__ask",
      args: { prompt: "Outline", system: "Be short.", model: "haiku" },
    });
  });
  it("offers summarize to the panel as a tool", () => {
    expect(COMMAND_TOOLS["concepts.summarize"].tool).toBe("summarize");
  });
});

describe("pipeline task titles through the pipeline's task tool", () => {
  /** A hub with the pipeline's `task` tool: task 12 is there. */
  const pipelineHub = (names = ["pipeline__task"]) => {
    const calls = [];
    return {
      calls,
      available: true,
      toolNames: async () => names,
      call: async (name, args) => {
        calls.push({ name, args });
        if (name === "pipeline__task" && args.number === 12) return { number: 12, title: "Fix login" };
        throw new Error(`There is no task #${args.number}: see tasks`);
      },
    };
  };
  it("reads a task by its number, and says when there is none", async () => {
    const hub = pipelineHub();
    const { ctx } = createContext({ supabase, hub });
    expect(await ctx.pipeline.task("12")).toEqual({ number: 12, title: "Fix login" });
    expect(await ctx.pipeline.task("13")).toBe(null);
    expect(hub.calls).toEqual([
      { name: "pipeline__task", args: { number: 12 } },
      { name: "pipeline__task", args: { number: 13 } },
    ]);
  });
  it("can't tell without the pipeline's tool, or for a task id from layr_code", async () => {
    expect(await createContext({ supabase, hub: pipelineHub([]) }).ctx.pipeline.task("12")).toBe(undefined);
    const hub = pipelineHub();
    expect(await createContext({ supabase, hub }).ctx.pipeline.task("task-7")).toBe(undefined);
    expect(hub.calls).toEqual([]);
  });
});
