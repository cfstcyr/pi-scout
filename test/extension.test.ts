// pi-scout extension wiring with a mock pi (handlers, tool, UI, model registry). No pi process, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import piScout, { REMINDER_TEXT } from "../src/extension.ts";

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscout-ext-"));
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
  w("governance/2025-10-14-board-minutes.md", "# Board meeting 14 October 2025\nThe board adopts these rules for the bulletin: members never customers.\n");
  w("projects/booking/plan.md", "# Room booking plan\nThe room booking system launches 7 April for members.\n");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "import"], { cwd: dir });
  return dir;
}
const SAVED: Record<string, string | undefined> = {};
afterAll(() => { for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
type Reply = (system: string, prompt: string) => string | Error;
function harness(o: { provider: string; models: { provider: string; id: string }[]; reply?: Reply; config?: any; env?: Record<string, string> }) {
  const dir = fixture();
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "piscout-agent-"));
  const logFile = path.join(agent, "scout.jsonl");
  if (o.config) fs.writeFileSync(path.join(agent, "scout-sources.json"), JSON.stringify(o.config));
  const handlers: Record<string, Function[]> = {};
  let tool: any = null;
  const calls: { model: string; system: string }[] = [];
  const notes: string[] = [], statuses: (string | undefined)[] = [];
  const pi: any = {
    on: (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); },
    registerTool: (t: any) => { tool = t; }, registerCommand: () => {},
    getAllTools: () => [], getActiveTools: () => ["read", "scout"],
  };
  const ctx: any = {
    cwd: dir, hasUI: true, isProjectTrusted: () => false,
    model: { provider: o.provider, id: "main" },
    sessionManager: { getSessionId: () => "t" },
    ui: { notify: (t: string) => notes.push(t), setStatus: (_k: string, t?: string) => statuses.push(t), setWidget: () => {} },
    modelRegistry: {
      getAvailable: () => o.models,
      find: (p: string, id: string) => o.models.find((m) => m.provider === p && m.id === id),
      streamSimple: (m: any, c: any) => ({ result: async () => {
        calls.push({ model: `${m.provider}/${m.id}`, system: c.systemPrompt });
        const r = (o.reply ?? (() => "{}"))(c.systemPrompt, c.messages[0].content[0].text);
        if (r instanceof Error) return { content: [], stopReason: "error", errorMessage: r.message, usage: { input: 5, output: 0 } };
        return { content: [{ type: "text", text: r }], stopReason: "stop", usage: { input: 100, output: 20 } };
      } }),
    },
  };
  // the extension reads process.env at load and at session_start: set for this test, restored after the file
  const env: Record<string, string> = { PI_CODING_AGENT_DIR: agent, SCOUT_LOG: logFile, SCOUT_SOURCES: "", HARNESS_TOOLS_CONFIG: "", SCOUT_PUSH: "", SCOUT_AUDIT: "", SCOUT_TEST_MAP_FIRST: "", SCOUT_QUERY_MODEL: "", SCOUT_RESEARCH: "", SCOUT_REMINDER: "", SCOUT_DELIVERY: "pull", SCOUT_TOOL: "", ...(o.env ?? {}) };
  for (const [k, v] of Object.entries(env)) { if (!(k in SAVED)) SAVED[k] = process.env[k]; if (v === "") delete process.env[k]; else process.env[k] = v; }
  piScout(pi);
  const fire = async (ev: string, e: any = {}) => { let out: any; for (const h of handlers[ev] ?? []) out = (await h(e, ctx)) ?? out; return out; };
  const events = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const settleResearch = async () => { for (let i = 0; i < 100; i++) { const ev = events(); if (ev.some((x) => /^research_(done|error|skipped|budget)$/.test(x.event))) return; await new Promise((r) => setTimeout(r, 20)); } };
  return { pi, ctx, fire, events, calls, notes, statuses, tool: () => tool, settleResearch, dir };
}
const PLAN = JSON.stringify({ queries: ["room booking launch", "bulletin rules"], folders: ["governance"] });
const reply: Reply = (system, prompt) => {
  if (/You plan the research/.test(system)) return PLAN;
  const m = prompt.match(/(\d+)\. projects\/booking\/plan\.md/);
  return JSON.stringify({ picks: m ? [{ n: Number(m[1]), kind: "fact", gist: "launch date" }] : [], follow_queries: [], follow_folders: [] });
};
const TASK = "Write the member bulletin about the room booking launch for the cooperative.";

describe("extension", () => {
  test("task prompt: researcher runs with the session provider's small model; tool answers from the ledger", async () => {
    const h = harness({ provider: "anthropic", models: [{ provider: "anthropic", id: "claude-haiku-5-5" }, { provider: "openai", id: "gpt-mini" }], reply });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.settleResearch();
    expect(h.calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(h.calls.map((c) => c.model))).toEqual(new Set(["anthropic/claude-haiku-5-5"]));
    const r = await h.tool().execute("c1", { query: "room booking" }, undefined, undefined, {});
    expect(r.content[0].text).toContain("found by the scout (fact)");
    expect(h.events().find((e) => e.event === "session_start").version).toBe("pi-scout-0.2.0");
    expect(h.statuses.at(-1)).toBe("scout: 1 finding");
  });
  test("trivial prompt: no researcher, no model call, no reminder", async () => {
    const h = harness({ provider: "anthropic", models: [{ provider: "anthropic", id: "claude-haiku-5-5" }], reply });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: "thanks, continue" });
    await h.settleResearch();
    expect(h.calls.length).toBe(0);
    expect(h.events().some((e) => e.event === "research_skipped" && e.why === "trivial prompt")).toBe(true);
    expect(await h.fire("agent_before_settle", { entries: [] })).toBeUndefined();
  });
  test("no small model from the session provider: lexical-only, said once, never another provider", async () => {
    const h = harness({ provider: "acme", models: [{ provider: "acme", id: "big-model" }, { provider: "anthropic", id: "claude-haiku-5-5" }], reply });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK + " Again." });
    await h.settleResearch();
    expect(h.calls.length).toBe(0);
    expect(h.notes.filter((t) => t.includes("lexical-only")).length).toBe(1);
    const r = await h.tool().execute("c1", { query: "room booking launch" }, undefined, undefined, {});
    expect(r.content[0].text).toContain("background search is off");
  });
  test("research.llm false: no model call at all", async () => {
    const h = harness({ provider: "anthropic", models: [{ provider: "anthropic", id: "claude-haiku-5-5" }], reply, config: { research: { llm: false } } });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.settleResearch();
    expect(h.calls.length).toBe(0);
  });
  test("model failure: research_error logged, user notified once, tool still answers", async () => {
    const h = harness({ provider: "anthropic", models: [{ provider: "anthropic", id: "claude-haiku-5-5" }], reply: () => new Error("overloaded") });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.settleResearch();
    expect(h.events().some((e) => e.event === "research_error" && /overloaded/.test(e.error))).toBe(true);
    expect(h.notes.some((t) => t.includes("background search failed"))).toBe(true);
    expect(h.statuses.at(-1)).toBe("scout: search failed");
    const r = await h.tool().execute("c1", { query: "room booking launch" }, undefined, undefined, {});
    expect(r.content[0].text).toContain("failed");
  });
  test("session cap on researcher runs", async () => {
    const h = harness({ provider: "anthropic", models: [{ provider: "anthropic", id: "claude-haiku-5-5" }], reply, config: { research: { maxRunsPerSession: 1 } } });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.settleResearch();
    const n = h.calls.length;
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK + " Second version please." });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.calls.length).toBe(n);
    expect(h.events().some((e) => e.event === "research_skipped" && e.why === "session budget")).toBe(true);
    expect(h.notes.some((t) => t.includes("session budget reached"))).toBe(true);
  });
  test("settle reminder: once, only after a task-like prompt, only if scout was not called", async () => {
    const h = harness({ provider: "anthropic", models: [{ provider: "anthropic", id: "claude-haiku-5-5" }], reply });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    const r1 = await h.fire("agent_before_settle", { entries: [] });
    expect(r1.continue).toBe(true);
    expect(r1.entries[0].content).toBe(REMINDER_TEXT);
    expect(await h.fire("agent_before_settle", { entries: [] })).toBeUndefined();
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK + " Shorter." });
    await h.tool().execute("c2", { query: "room booking" }, undefined, undefined, {});
    expect(await h.fire("agent_before_settle", { entries: [] })).toBeUndefined();
  });
  test("removed knobs: SCOUT_PUSH / SCOUT_AUDIT / SCOUT_TEST_MAP_FIRST are ignored and logged; tool has no draft_path", async () => {
    const h = harness({ provider: "anthropic", models: [{ provider: "anthropic", id: "claude-haiku-5-5" }], reply, env: { SCOUT_PUSH: "1", SCOUT_AUDIT: "1", SCOUT_TEST_MAP_FIRST: "projects/booking/plan.md" } });
    await h.fire("session_start");
    expect(h.events().find((e) => e.event === "session_start").ignoredEnv).toEqual(["SCOUT_PUSH", "SCOUT_AUDIT", "SCOUT_TEST_MAP_FIRST"]);
    expect(Object.keys(h.tool().parameters.properties)).toEqual(["query", "kinds"]);
  });
});
