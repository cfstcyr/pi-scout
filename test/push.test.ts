// PUSHMAP: SCOUT_DELIVERY=push-map (push.ts + extension wiring) with a mock pi. No pi process, no network.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import piScout from "../src/extension.ts";
import { PUSH_CFG, dropOpened, firstK, deliveryMode } from "../src/push.ts";
import type { Map7Entry } from "../src/map7.ts";

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piscout-push-"));
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
  w("governance/2025-10-14-board-minutes.md", "# Board meeting 14 October 2025\nThe board adopts these rules for the bulletin: members never customers.\n");
  w("projects/booking/plan.md", "# Room booking plan\nThe room booking system launches 7 April for members.\n");
  w("projects/booking/2026-01-12-update.md", "# Room booking update 12 January 2026\nThe room booking launch moves to 14 April for members of the cooperative.\n");
  for (let i = 0; i < 30; i++) w(`notes/n${i}.md`, `# Note ${i}\nRoom booking bulletin member cooperative launch item ${i} with filler words number ${i}.\n`);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "import"], { cwd: dir });
  return dir;
}
const SAVED: Record<string, string | undefined> = {};
afterAll(() => { for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const PLAN = JSON.stringify({ queries: ["room booking launch", "bulletin rules"], folders: ["governance"] });
function harness(o: { env?: Record<string, string>; gate?: Promise<void>; idle?: () => boolean; config?: any } = {}) {
  const dir = fixture();
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "piscout-push-agent-"));
  if (o.config) fs.writeFileSync(path.join(agent, "scout-sources.json"), JSON.stringify(o.config));
  const logFile = path.join(agent, "scout.jsonl");
  const handlers: Record<string, Function[]> = {};
  let tool: any = null;
  const sent: { msg: any; opts: any }[] = [];
  const pi: any = {
    on: (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); },
    registerTool: (t: any) => { tool = t; }, registerCommand: () => {},
    getAllTools: () => [], getActiveTools: () => ["read", "scout"],
    sendMessage: (msg: any, opts: any) => { sent.push({ msg, opts }); },
  };
  const models = [{ provider: "anthropic", id: "claude-haiku-5-5" }];
  const ctx: any = {
    cwd: dir, hasUI: false, isProjectTrusted: () => false, isIdle: o.idle ?? (() => false),
    model: { provider: "anthropic", id: "main" }, sessionManager: { getSessionId: () => "t" },
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    modelRegistry: {
      getAvailable: () => models, find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
      streamSimple: (_m: any, c: any) => ({ result: async () => {
        if (o.gate) await o.gate;
        const sys = c.systemPrompt, prompt = c.messages[0].content[0].text;
        let text: string;
        if (/You plan the research/.test(sys)) text = PLAN;
        else {
          const a = prompt.match(/(\d+)\. projects\/booking\/2026-01-12-update\.md/), b = prompt.match(/(\d+)\. governance\/2025-10-14-board-minutes\.md/);
          text = JSON.stringify({ picks: [...(a ? [{ n: Number(a[1]), kind: "update", gist: "new launch date" }] : []), ...(b ? [{ n: Number(b[1]), kind: "rule", gist: "wording" }] : [])], follow_queries: [], follow_folders: [] });
        }
        return { content: [{ type: "text", text }], stopReason: "stop", usage: { input: 100, output: 20 } };
      } }),
    },
  };
  const env: Record<string, string> = { PI_CODING_AGENT_DIR: agent, SCOUT_LOG: logFile, SCOUT_SOURCES: "", HARNESS_TOOLS_CONFIG: "", SCOUT_QUERY_MODEL: "", SCOUT_RESEARCH: "", SCOUT_REMINDER: "", SCOUT_TOOL: "", SCOUT_TOOL_GUIDELINE: "", SCOUT_DELIVERY: "push-map", SCOUT_LEDGER_WAIT_MS: "", SCOUT_BENCH: "", ...(o.env ?? {}) };
  for (const [k, v] of Object.entries(env)) { if (!(k in SAVED)) SAVED[k] = process.env[k]; if (v === "") delete process.env[k]; else process.env[k] = v; }
  piScout(pi);
  const fire = async (ev: string, e: any = {}) => { let out: any; for (const h of handlers[ev] ?? []) out = (await h(e, ctx)) ?? out; return out; };
  const events = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const until = async (pred: () => boolean) => { for (let i = 0; i < 200; i++) { if (pred()) return; await new Promise((r) => setTimeout(r, 15)); } };
  const researchDone = () => until(() => events().some((x) => /^research_(done|error|skipped|budget)$/.test(x.event)));
  return { fire, events, sent, tool: () => tool, until, researchDone, dir };
}
const TASK = "Write the member bulletin about the room booking launch for the cooperative.";
const read = (p: string) => ({ toolName: "read", input: { path: p }, content: [{ type: "text", text: "..." }], isError: false });

describe("push.ts helpers", () => {
  const E = (n: number, o: Partial<Map7Entry> = {}): Map7Entry => ({ item: { id: `file:f${n}.md` } as any, from: "ledger", n, olderThan: [], newerThan: [], ...o });
  test("deliveryMode (0.2): push is the default, only 'pull' switches back", () => {
    expect(deliveryMode("push-map")).toBe("push-map");
    expect(deliveryMode(undefined)).toBe("push-map");
    expect(deliveryMode("push")).toBe("push-map");
    expect(deliveryMode("pull")).toBe("pull");
  });
  test("dropOpened removes opened entries, keeps an opened one linked to a shown entry, renumbers links", () => {
    const es = [E(1, { newerThan: [2] }), E(2, { olderThan: [1] }), E(3), E(4)];
    // f1 (newer) opened, f2 (older) not: f1 stays because f2 links to it. f3 opened alone: dropped.
    const seen = new Set(["file:f1.md", "file:f3.md"]);
    const out = dropOpened(es, (id) => seen.has(id));
    expect(out.map((e) => e.item.id)).toEqual(["file:f1.md", "file:f2.md", "file:f4.md"]);
    expect(out.map((e) => e.n)).toEqual([1, 2, 3]);
    expect(out[1].olderThan).toEqual([1]);
    expect(dropOpened([E(1), E(2)], () => true)).toEqual([]);
  });
  test("firstK drops links to removed entries", () => {
    const out = firstK([E(1, { newerThan: [3] }), E(2), E(3, { olderThan: [1] })], 2);
    expect(out.length).toBe(2);
    expect(out[0].newerThan).toEqual([]);
  });
});

describe("SCOUT_DELIVERY=push-map", () => {
  test("0.2 default (no env, no config): push, no scout tool, no guideline, no reminder", async () => {
    const h = harness({ env: { SCOUT_DELIVERY: "" } });
    await h.fire("session_start");
    expect(h.tool()).toBeNull();
    const ss = h.events().find((e) => e.event === "session_start");
    expect([ss.delivery, ss.tool, ss.guideline]).toEqual(["push-map", false, false]);
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.researchDone();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].msg.content).toContain("[Scout]");
    const r = await h.fire("agent_before_settle", { entries: [] });
    expect(r).toBeUndefined();
  });
  test("config delivery \"pull\" restores the tool + guideline + reminder", async () => {
    const h = harness({ env: { SCOUT_DELIVERY: "" }, config: { delivery: "pull" } });
    await h.fire("session_start");
    expect(h.tool()).not.toBeNull();
  });
  test("research done → one steer message with the dated map, ≤ cap, locators only; no settle reminder", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.researchDone();
    await h.until(() => h.sent.length > 0);
    expect(h.sent.length).toBe(1);
    const { msg, opts } = h.sent[0];
    expect(opts.deliverAs).toBe("steer");
    expect(msg.customType).toBe("scout");
    expect(msg.content).toContain("[Scout] The scout's background search for this task finished");
    expect(msg.content).toContain("`projects/booking/2026-01-12-update.md`");
    expect(msg.content).toContain("found by the scout (update)");
    expect(msg.content).not.toContain("14 April"); // no content
    expect(Math.ceil(msg.content.length / 3.5)).toBeLessThanOrEqual(PUSH_CFG.maxTokens);
    expect(msg.details.items.some((i: any) => i.item === "file:projects/booking/2026-01-12-update.md" && i.path === "projects/booking/2026-01-12-update.md")).toBe(true);
    const q = h.events().find((e) => e.event === "nudge_queued");
    expect(q.kind).toBe("map"); expect(q.deliverAs).toBe("steer"); expect(q.trigger).toBe("research_done");
    // delivery is logged when the message reaches the model's context
    await h.fire("context", { messages: [{ role: "user" }, { role: "custom", customType: "scout", details: msg.details }] });
    expect(h.events().some((e) => e.event === "nudge_delivered" && e.id === msg.details.id && e.kind === "map")).toBe(true);
    // settle: no reminder, no second push
    expect(await h.fire("agent_before_settle", { entries: [] })).toBeUndefined();
    expect(h.sent.length).toBe(1);
  });
  test("entries the agent already opened are skipped", async () => {
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const h = harness({ gate });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await new Promise((r) => setTimeout(r, 100));
    await h.fire("tool_result", read("governance/2025-10-14-board-minutes.md"));
    open();
    await h.researchDone();
    await h.until(() => h.sent.length > 0);
    expect(h.sent.length).toBe(1);
    expect(h.sent[0].msg.content).not.toContain("board-minutes");
    expect(h.sent[0].msg.content).not.toMatch(/, (?<!not )opened/);
    expect(h.events().find((e) => e.event === "nudge_queued").droppedOpened).toBeGreaterThanOrEqual(1);
  });
  test("settle before the researcher finished: waits, delivers once at settle (continue), never steers afterwards", async () => {
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const h = harness({ gate });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    const p = h.fire("agent_before_settle", { entries: [] });
    setTimeout(open, 80);
    const r = await p;
    expect(r.continue).toBe(true);
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].type).toBe("custom_message");
    expect(r.entries[0].content).toContain("2026-01-12-update.md");
    await new Promise((res) => setTimeout(res, 100));
    expect(h.sent.length).toBe(0);
    expect(h.events().find((e) => e.event === "nudge_queued").trigger).toBe("settle");
    expect(await h.fire("agent_before_settle", { entries: [] })).toBeUndefined();
  });
  test("agent idle when the researcher finishes: deferred to settle", async () => {
    const h = harness({ idle: () => true });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.researchDone();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sent.length).toBe(0);
    expect(h.events().some((e) => e.event === "push_deferred")).toBe(true);
    const r = await h.fire("agent_before_settle", { entries: [] });
    expect(r.entries[0].content).toContain("[Scout]");
  });
  test("the agent already got the finished ledger from the scout tool: no push", async () => {
    let open!: () => void; const gate = new Promise<void>((r) => { open = r; });
    const h = harness({ gate, env: { SCOUT_TOOL: "1" } }); // opt-in tool alongside push
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    setTimeout(open, 50);
    const t = await h.tool().execute("c1", { query: "room booking" }, undefined, undefined, {});
    expect(t.content[0].text).toContain("found by the scout");
    await h.researchDone();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sent.length).toBe(0);
    expect(h.events().some((e) => e.event === "push_skipped" && /tool map/.test(e.why))).toBe(true);
  });
  test("one push per prompt; a new task prompt gets its own; trivial prompts get none", async () => {
    const h = harness();
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.until(() => h.sent.length === 1);
    await h.fire("before_agent_start", { messageType: "user", prompt: "thanks, continue" });
    await new Promise((r) => setTimeout(r, 100));
    expect(h.sent.length).toBe(1);
    expect(await h.fire("agent_before_settle", { entries: [] })).toBeUndefined();
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK + " Make it shorter for the newsletter." });
    await h.until(() => h.sent.length === 2);
    expect(h.sent.length).toBe(2);
    expect(h.sent[1].msg.details.id).not.toBe(h.sent[0].msg.details.id);
  });
  test("SCOUT_TOOL=0 (push-map-notool): no tool registered, the map is still pushed", async () => {
    const h = harness({ env: { SCOUT_TOOL: "0" } });
    await h.fire("session_start");
    expect(h.tool()).toBeNull();
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.until(() => h.sent.length > 0);
    expect(h.sent.length).toBe(1);
  });
  test("delivery pull (opt-in, 0.1 behaviour): nothing pushed, the settle reminder is unchanged", async () => {
    const h = harness({ env: { SCOUT_DELIVERY: "pull" } });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    await h.researchDone();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.sent.length).toBe(0);
    const r = await h.fire("agent_before_settle", { entries: [] });
    expect(r.entries[0].content).toContain("Before you finish");
  });
  test("researcher failed: no push (logged)", async () => {
    const h = harness({ env: { SCOUT_RESEARCH: "0" } });
    await h.fire("session_start");
    await h.fire("before_agent_start", { messageType: "user", prompt: TASK });
    expect(await h.fire("agent_before_settle", { entries: [] })).toBeUndefined();
    expect(h.events().some((e) => e.event === "push_skipped" && /background off/.test(e.why))).toBe(true);
  });
});
