// pi-scout: the validated scout v7b pull configuration as a daily-use pi extension (README.md, CHANGES.md).
//
//   session_start        config (~/.pi/agent/scout-sources.json), log file, workspace index (time-sliced, in the
//                        background), sources, the `scout` tool; no model call
//   before_agent_start   a task-like user prompt starts the background researcher (research.ts) with a model of the
//                        session's provider (or the one the user configured); trivial prompts are skipped; session caps
//   tool_result          seen-tracking (what the agent opened) for "opened / not opened" in the map
//   agent_before_settle  once per task-like prompt, if the agent never called `scout`: one fixed reminder message
//   scout tool           pull: dated map of locators (tool.ts / map7.ts)
//   /scout               status for the user (model, researcher, budgets, sources)
//
// Defaults: workspace only (files + git log); MCP / web / custom tools only when the user lists them; read-only tools
// only; open-world sources only with opt-in and only with the words of the user's prompt; never writes a file, never
// calls a write tool; log in ~/.cache/pi-scout/ (or $SCOUT_LOG). No push, no draft audit (v6 code removed).
// SCOUT_DISABLE=1 = complete no-op.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Index } from "./index.ts";
import { Tracker, textOf } from "./tracker.ts";
import { WorkspaceSource } from "./sources/workspace.ts";
import { type Loaded, DEFAULT_RESEARCH, buildSources, loadSourcesConfig } from "./sources/config.ts";
import { CallBudget } from "./sources/budget.ts";
import type { McpClient } from "./sources/mcp-client.ts";
import type { Source } from "./types.ts";
import { Observed } from "./observed.ts";
import { type Llm, estTok } from "./llm.ts";
import { codeHash, retrievalHash, VERSION } from "./hash.ts";
import { RESEARCH_CFG, research } from "./research.ts";
import { MAP7_CFG } from "./map7.ts";
import { type ResearchState, makeScoutTool } from "./tool.ts";
import { BudgetError, TokenBudget, chooseModel, looksLikeTask } from "./policy.ts";
import { PUSH_CFG, buildPushMap, deliveryMode } from "./push.ts";

const env = process.env;
const n = (k: string, d: number) => (env[k] !== undefined && env[k] !== "" ? Number(env[k]) : d);
export const REMINDER_TEXT = "[Scout] Before you finish: `scout` lists related rules, templates and newer updates across all enabled sources (locators and dates only). Call it with the subject of your work if you have not. No need to mention this note.";
/** Env knobs (all optional; the config file is the normal way to configure). Removed v6/v7 knobs are logged if set. */
export const ENV_CFG = () => ({
  tool: env.SCOUT_TOOL === "0" ? false : env.SCOUT_TOOL === "1" ? true : null, // null = config (default: no tool in push mode)
  toolGuideline: env.SCOUT_TOOL_GUIDELINE !== "0", // pull mode only
  research: env.SCOUT_RESEARCH !== "0", // 0 = no researcher at all (lexical map only)
  reminder: env.SCOUT_REMINDER === "0" || env.SCOUT_REMINDER === "off" ? "off" : env.SCOUT_REMINDER === "1" ? "sources" : null,
  model: env.SCOUT_QUERY_MODEL || null,
  ledgerWaitMs: env.SCOUT_LEDGER_WAIT_MS ? Math.min(n("SCOUT_LEDGER_WAIT_MS", 15000), 30000) : null,
  genTimeoutMs: n("SCOUT_GEN_TIMEOUT_MS", 15000),
  benchExternal: env.SCOUT_BENCH === "1" ? (env.SCOUT_BENCH_EXTERNAL ?? "kind") : null, // tester PS1: logged only
  delivery: env.SCOUT_DELIVERY ? deliveryMode(env.SCOUT_DELIVERY) : null, // 0.2: null = config (default "push"); "pull" = 0.1 pull tool + guideline + reminder
});
const REMOVED_ENV = ["SCOUT_PUSH", "SCOUT_AUDIT", "SCOUT_AUDIT_AFTER", "SCOUT_HOLD_MS", "SCOUT_DEBOUNCE_MS", "SCOUT_TEST_MAP_FIRST"];
const splitModel = (s: string) => { const i = s.indexOf("/"); return { provider: s.slice(0, i), id: s.slice(i + 1) }; };

export default function piScout(pi: ExtensionAPI) {
  if (env.SCOUT_DISABLE === "1") return;
  const E = ENV_CFG();
  // 0.2: effective delivery (config `delivery`, env overrides), set at session_start. Default: push-map, no tool.
  const modeRef = { delivery: "push-map" as "push-map" | "pull", tool: false, guideline: false };
  let ctxRef: ExtensionContext | null = null;
  let logPath = "";
  const t0 = Date.now();
  let promptAt = 0;
  let idx: Index | null = null;
  let tracker: Tracker | null = null;
  let obs = new Observed();
  let workspace: WorkspaceSource | null = null;
  let sources: Source[] = [];
  let clients: McpClient[] = [];
  let loaded: Loaded | null = null;
  let stopped = false;
  let model: string | null = null, modelWhy = "";
  // per-prompt MCP call caps: one shared meter (calls.perPrompt) over the tool's and the researcher's budgets
  let meter = new CallBudget({ perServer: Infinity, total: 60 });
  let calls = new CallBudget({}, meter);
  let rcalls = new CallBudget({ perServer: 24, total: 48 }, meter);
  let tokens = new TokenBudget(DEFAULT_RESEARCH.maxTokensPerSession, DEFAULT_RESEARCH.maxTokensPerRun, DEFAULT_RESEARCH.maxRunsPerSession);
  const scoutToolIds = new Set<string>();
  const log = (event: string, d: Record<string, unknown> = {}) => { if (logPath) try { fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), tRel: Date.now() - t0, event, ...d }) + "\n"); } catch {} };
  const safe = <A extends any[], R>(name: string, fn: (...a: A) => R | Promise<R>) => async (...a: A): Promise<R | undefined> => {
    try { return await fn(...a); } catch (e) { log("handler_error", { handler: name, error: String((e as any)?.stack || e).slice(0, 500) }); return undefined; }
  };
  // ---------------- user-visible status ----------------
  const notified = new Set<string>();
  const status = (text: string | undefined) => { try { if ((ctxRef as any)?.hasUI) ctxRef!.ui.setStatus("scout", text); } catch {} };
  const notifyOnce = (key: string, text: string, level: "info" | "warning" | "error" = "warning") => {
    if (notified.has(key)) return;
    notified.add(key);
    log("notice", { key, text });
    try { if ((ctxRef as any)?.hasUI) ctxRef!.ui.notify(text, level); } catch {}
  };

  const task = { toolCalled: false, reminded: false, isTask: false };
  // PUSHMAP: one pushed map per task-like prompt (research done → steer; else at settle)
  const push = { gen: 0, state: "idle" as "idle" | "pending" | "settling" | "queued" | "done", id: "", toolHadLedger: false, turn: 0, queuedAt: 0 };
  const stats = { prompts: 0, taskPrompts: 0, toolCalls: 0, researches: 0, researchSkipped: 0, researchErrors: 0, researchTokens: 0, llmCalls: 0, reminders: 0, pushes: 0 };
  const rstate: ResearchState = { ledger: [], ready: false, running: null, startedAt: 0, status: "off" };
  let researchAbort: AbortController | null = null;
  let markReady: () => void = () => {};
  let readyP: Promise<void> = new Promise((r) => { markReady = r; }); // index + sources built
  const waitIndex = (ms: number) => Promise.race([readyP.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

  // the researcher's model calls: token caps checked before each call (conservative estimate), usage counted after
  const llmResearch: Llm = async (system, prompt, maxTokens, signal, kind, modelName) => {
    const name = modelName || model;
    if (!name) throw new Error("no model");
    tokens.check(estTok(system + prompt) + maxTokens);
    const m = splitModel(name);
    const mdl = ctxRef!.modelRegistry.find(m.provider, m.id);
    if (!mdl) throw new Error(`model ${name} not found`);
    const t = Date.now();
    const stream: any = (ctxRef!.modelRegistry as any).streamSimple(mdl, { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      { signal: AbortSignal.any([signal, AbortSignal.timeout(E.genTimeoutMs)].filter(Boolean) as AbortSignal[]), maxTokens, cacheRetention: "none" });
    const r: any = await stream.result();
    const usage = { input: r.usage?.input ?? estTok(system + prompt), output: r.usage?.output ?? 0 };
    stats.llmCalls++; stats.researchTokens += usage.input + usage.output;
    tokens.add(usage.input + usage.output);
    if (r.stopReason === "error" || r.stopReason === "aborted") throw new Error(signal?.aborted ? "aborted" : `llm ${r.stopReason}: ${String(r.errorMessage ?? "").slice(0, 160)}`);
    log("generate", { kind, model: name, ms: Date.now() - t, usage, runTokens: tokens.run, sessionTokens: tokens.session });
    return { text: textOf(r.content), ms: Date.now() - t, usage };
  };

  const isSeen = (id: string) => {
    if (!tracker) return false;
    if (id.startsWith("file:")) return ["read", "grep", "write"].some((k) => tracker!.seen[k].has(id.slice(5)));
    if (id.startsWith("commit:")) return tracker.commitSeen(id);
    return obs.saw(id.startsWith("url:") ? id.slice(4) : id.slice(id.indexOf("/") + 1));
  };

  // ---------------- model ----------------
  async function pickModel(ctx: ExtensionContext) {
    const r = loaded?.cfg.research ?? DEFAULT_RESEARCH;
    let available: { provider: string; id: string }[] = [];
    try { available = (((await Promise.resolve((ctx as any).modelRegistry?.getAvailable?.())) ?? []) as any[]).map((m) => ({ provider: String(m?.provider), id: String(m?.id) })); } catch (e) { log("model_error", { error: String(e).slice(0, 200) }); }
    const session = (ctx as any).model?.provider ? { provider: String((ctx as any).model.provider), id: String((ctx as any).model.id) } : null;
    const c = chooseModel({ llm: r.llm && E.research, explicit: E.model ?? r.model ?? null, session, available });
    if (c.model !== model || c.why !== modelWhy) log("model", { model: c.model, why: c.why, session });
    model = c.model; modelWhy = c.why;
    if (!model && r.enabled && E.research && r.llm) notifyOnce(`lexical:${c.why}`, `scout: ${c.why}; running lexical-only (no LLM). Set research.model in ~/.pi/agent/scout-sources.json to choose one.`);
  }

  // ---------------- lifecycle ----------------
  pi.on("session_start", safe("session_start", async (_e: any, ctx: ExtensionContext) => {
    ctxRef = ctx; stopped = false;
    const sid = (() => { try { return String((ctx as any).sessionManager?.getSessionId?.() ?? ""); } catch { return ""; } })().replace(/[^\w.-]/g, "").slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    logPath = env.SCOUT_LOG ? path.resolve(ctx.cwd, env.SCOUT_LOG) : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "pi-scout", `pi-scout-${stamp}${sid ? `-${sid}` : ""}.jsonl`);
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 }); } catch {}
    const trusted = (() => { try { return (ctx as any).isProjectTrusted?.() ?? false; } catch { return false; } })();
    loaded = loadSourcesConfig(ctx.cwd, trusted, env);
    const cfg = loaded.cfg;
    meter = new CallBudget({ perServer: Infinity, total: cfg.calls?.perPrompt ?? 60 });
    calls = new CallBudget(cfg.calls, meter);
    rcalls = new CallBudget(cfg.researchCalls ?? { perServer: 24, total: 48 }, meter);
    calls.log = log; rcalls.log = log;
    const r = cfg.research ?? DEFAULT_RESEARCH;
    tokens = new TokenBudget(r.maxTokensPerSession, r.maxTokensPerRun, r.maxRunsPerSession);
    rstate.status = r.enabled && E.research ? "skipped" : "off";
    await pickModel(ctx);
    readyP = new Promise((res) => { markReady = res; });
    const removed = REMOVED_ENV.filter((k) => env[k] !== undefined);
    modeRef.delivery = E.delivery ?? (cfg.delivery === "pull" ? "pull" : "push-map");
    modeRef.tool = E.tool ?? cfg.tool ?? modeRef.delivery === "pull";
    modeRef.guideline = modeRef.tool && modeRef.delivery === "pull" && E.toolGuideline;
    const piRouted = Object.entries(cfg.mcp ?? {}).filter(([, sc]: any) => sc?.route === "pi" && sc?.enabled !== false).map(([nm]) => nm);
    if (piRouted.length && !modeRef.tool) notifyOnce("pi-route", `scout: ${piRouted.join(", ")} use route "pi", reachable only from the scout tool, which is off in push mode; set route "client" (or "tool": true) to search them.`, "info");
    log("session_start", { version: VERSION, delivery: modeRef.delivery, tool: modeRef.tool, guideline: modeRef.guideline, pushVersion: PUSH_CFG.version, codeHash: codeHash(), retrievalHash: retrievalHash(), researchVersion: RESEARCH_CFG.version, map7Version: MAP7_CFG.version, model, modelWhy, env: E, ignoredEnv: removed, research: r, reminder: cfg.reminder, map: cfg.map, externalDefault: cfg.externalDefault ?? "all", calls: cfg.calls, researchCalls: cfg.researchCalls, cwd: ctx.cwd, hasUI: (ctx as any).hasUI, trusted, sourcesFile: loaded.file, projectFile: loaded.projectFile, ignored: loaded.ignored, bench: loaded.bench });
    void (async () => {
      const builtP = buildSources(cfg, ctx.cwd, trusted, { allTools: () => pi.getAllTools(), executeTool: () => null, agentCanCall: (nm: string) => pi.getActiveTools().includes(nm) || pi.getAllTools().some((t: any) => t.name === nm && (t.exposure === "codemode" || t.exposure === "deferred")) }, [], { calls });
      const ib = new Index(ctx.cwd);
      await ib.buildAsync();
      idx = ib;
      tracker = new Tracker(ctx.cwd, idx, { habit: false, novelty: false });
      if (obs.task) tracker.user(obs.task);
      workspace = cfg.workspace?.enabled === false ? null : new WorkspaceSource(() => idx, { candN: 15 });
      const built = await builtP;
      sources = built.sources; clients = built.clients;
      if (stopped) { for (const c of clients) c.close(); return; }
      log("sources", { workspace: !!workspace, sources: sources.map((s) => ({ id: s.id, describe: s.describe(), available: s.available() })), detail: built.log, index: { files: idx.files.length, chunks: idx.chunks.length, commits: idx.commits.size, ms: idx.buildMs } });
      for (const p of pending) handleResult(p.tool, p.input, p.text, p.isError, p.parent);
      pending.length = 0;
      markReady();
    })().catch((e) => { log("index_error", { error: String((e as any)?.message ?? e).slice(0, 300) }); notifyOnce("index_error", "scout: could not index this folder; the scout tool will be unavailable this session.", "error"); status("scout: unavailable"); });
    if (modeRef.tool) pi.registerTool(makeScoutTool({ pi, getState: () => ({ idx, workspace, sources, task: obs.task, tracker, loaded, calls, cwd: ctx.cwd, isSeen, research: rstate, maxExternal: loaded?.cfg.map?.maxExternal ?? MAP7_CFG.maxExternal }), log, onCall: (id) => { scoutToolIds.add(id); stats.toolCalls++; task.toolCalled = true; }, onMap: (bg: string) => { if (bg === "ready") push.toolHadLedger = true; }, guideline: modeRef.guideline, ledgerWaitMs: E.research && (loaded.cfg.research?.enabled ?? true) ? (E.ledgerWaitMs ?? r.ledgerWaitMs) : 0, waitIndex }) as any);
  }));
  pi.on("session_shutdown", safe("session_shutdown", async (e: any) => {
    stopped = true;
    researchAbort?.abort();
    for (const c of clients) c.close();
    clients = [];
    log("stop", { reason: e?.reason, stats, tokens: { session: tokens.session, runs: tokens.runs }, toolCalls: calls.stats() });
  }));
  pi.registerCommand?.("scout", { description: "Show the scout's status: model, background search, budgets, sources", handler: async (_a: any, ctx: any) => {
    const r = loaded?.cfg.research ?? DEFAULT_RESEARCH;
    const lines = [
      `scout ${VERSION}: model ${model ?? `none (lexical-only: ${modelWhy})`}`,
      `background search: ${rstate.running && !rstate.ready ? "running" : rstate.status}${rstate.ready && rstate.ledger.length ? `, ${rstate.ledger.length} finding(s)` : ""}`,
      `researcher budget: ${tokens.runs}/${r.maxRunsPerSession} runs, ${tokens.session}/${r.maxTokensPerSession} tokens this session`,
      `sources: ${["workspace", ...sources.map((s) => s.id)].join(", ")}${loaded?.file ? ` (config ${loaded.file})` : " (no config file: workspace only)"}`,
      `log: ${logPath}`,
    ];
    try { ctx.ui.notify(lines.join("\n"), "info"); } catch {}
  } } as any);

  pi.on("before_agent_start", safe("before_agent_start", async (e: any, ctx: ExtensionContext) => {
    ctxRef = ctx;
    if (e.messageType !== "user" || !e.prompt) return;
    promptAt = Date.now(); stats.prompts++;
    const r = loaded?.cfg.research ?? DEFAULT_RESEARCH;
    task.toolCalled = false; task.reminded = false;
    push.gen++; push.state = "idle"; push.id = ""; push.toolHadLedger = false; push.turn = 0; push.queuedAt = 0;
    task.isTask = looksLikeTask(e.prompt, r.minTaskTerms);
    if (task.isTask) stats.taskPrompts++;
    meter.reset(); calls.reset(); rcalls.reset();
    obs.setTask(e.prompt);
    tracker?.user(e.prompt);
    tracker?.seen.write.clear(); // a new prompt starts a new deliverable; what was read stays "opened"
    await pickModel(ctx); // the session model may have changed: the researcher follows its provider
    if (modeRef.delivery === "push-map" && task.isTask) push.state = "pending";
    startResearch(e.prompt);
  }));
  pi.on("turn_start", safe("turn_start", async (e: any) => { if (typeof e?.turnIndex === "number") push.turn = e.turnIndex; }));

  // ---------------- background researcher (one per task-like user prompt) ----------------
  function startResearch(prompt: string) {
    researchAbort?.abort();
    const r = loaded?.cfg.research ?? DEFAULT_RESEARCH;
    Object.assign(rstate, { ledger: [], ready: false, running: null, startedAt: Date.now() });
    const skip = (why: string, st: ResearchState["status"], show?: string) => {
      rstate.status = st; rstate.ready = true; stats.researchSkipped++;
      log("research_skipped", { why, sincePromptMs: Date.now() - promptAt });
      status(show);
    };
    if (stopped) return;
    if (!r.enabled || !E.research) return skip("disabled by config", "off", "scout: lexical only");
    if (!task.isTask) return skip("trivial prompt", "skipped", undefined);
    if (!model) return skip(`no model: ${modelWhy}`, "off", "scout: lexical only");
    if (!tokens.canStartRun()) {
      notifyOnce("budget", `scout: session budget reached (${tokens.runs} background searches, ${tokens.session} tokens); lexical-only from now on.`);
      return skip("session budget", "off", "scout: budget reached (lexical only)");
    }
    const ac = new AbortController();
    researchAbort = ac;
    stats.researches++;
    tokens.startRun();
    rstate.status = "running";
    status("scout: searching…");
    rstate.running = (async () => {
      await readyP;
      if (ac.signal.aborted) return;
      if (!idx || !workspace) { rstate.ready = true; rstate.status = workspace || !idx ? "failed" : "off"; log(idx ? "research_skipped" : "research_error", { why: idx ? "workspace source disabled" : "index unavailable" }); status(undefined); return; }
      log("research_start", { sincePromptMs: Date.now() - promptAt, version: RESEARCH_CFG.version, model, files: idx.files.length, sources: sources.map((s) => s.id) });
      const res = await research({ task: prompt, idx, workspace, sources, llm: llmResearch, model: model!, signal: ac.signal, log, budget: rcalls });
      if (ac.signal.aborted) return;
      rstate.ledger = res.ledger; rstate.ready = true;
      const budgetHit = !!res.error && /token cap/.test(res.error);
      rstate.status = res.error && !res.ledger.length && !budgetHit ? "failed" : "ready";
      log("research_done", { sincePromptMs: Date.now() - promptAt, ms: res.ms, calls: res.calls, usage: res.usage, sourceCalls: res.sourceCalls, toolCalls: rcalls.stats(), pools: res.pools, plan: res.plan, follow: res.follow, error: res.error ?? null, trace: res.trace.map((t) => ({ stage: t.stage, ms: t.ms })), ledger: res.ledger.map((x) => ({ id: x.item.id, kind: x.kind, round: x.round, date: x.item.date ?? null, external: !!x.item.external, gist: x.gist })) });
      if (res.error) {
        stats.researchErrors++;
        log(budgetHit ? "research_budget" : "research_error", { error: res.error, ledger: res.ledger.length });
        if (budgetHit) notifyOnce("run_budget", `scout: background search stopped at its token cap (${res.error}); partial results kept.`, "info");
        else notifyOnce("research_error", `scout: background search failed (${res.error.slice(0, 120)}); the scout tool falls back to a lexical search.`);
      }
      status(rstate.status === "failed" ? "scout: search failed" : `scout: ${res.ledger.length} finding${res.ledger.length === 1 ? "" : "s"}`);
      if (!ac.signal.aborted) void pushNow("research_done");
    })().catch((err) => {
      stats.researchErrors++; rstate.ready = true; rstate.status = "failed";
      const msg = String((err as any)?.message ?? err).slice(0, 300);
      log(err instanceof BudgetError ? "research_budget" : "research_error", { error: msg });
      notifyOnce("research_error", `scout: background search failed (${msg.slice(0, 120)}); the scout tool falls back to a lexical search.`);
      status("scout: search failed");
    });
  }

  const pending: { tool: string; input: any; text: string; isError: boolean; parent?: string }[] = [];
  function handleResult(tool: string, input: any, text: string, isError: boolean, parent?: string) {
    if (parent && (scoutToolIds.has(parent) || [...scoutToolIds].some((id) => parent.startsWith(id)))) return; // the scout's own nested calls
    if (!tracker) { pending.push({ tool, input, text, isError, parent }); return; }
    tracker.call(tool, input);
    tracker.result(tool, input, text, isError);
    obs.addResult(tool, `${JSON.stringify(input ?? {}).slice(0, 400)}\n${text}`);
  }
  pi.on("tool_result", safe("tool_result", async (e: any, ctx: ExtensionContext) => {
    ctxRef = ctx;
    if (e.toolName === "scout") return undefined;
    handleResult(e.toolName, e.input, textOf(e.content).slice(0, 40000), !!e.isError, e.parentToolCallId);
    return undefined;
  }));

  // ---------------- PUSHMAP: push the researcher's dated map (SCOUT_DELIVERY=push-map) ----------------
  const pathOf = (it: any) => (it.locator?.type === "file" ? it.locator.path : String(it.id).replace(/^(mcp:[^/]+\/|url:|file:)/, ""));
  async function makePush() {
    if (push.toolHadLedger) return { skip: "tool map already had the finished ledger" };
    if (rstate.status !== "ready") return { skip: `background ${rstate.status}` };
    const written = (id: string) => id.startsWith("file:") && !!tracker?.seen.write.has(id.slice(5));
    const m = await buildPushMap({ prompt: obs.task, ledger: rstate.ledger, background: "ready", idx, workspace, sources, isSeen, isExcluded: written, maxExternal: loaded?.cfg.map?.maxExternal ?? MAP7_CFG.maxExternal });
    return m ? { m } : { skip: "nothing left to show (all opened or none)" };
  }
  const pushMsg = (m: NonNullable<Awaited<ReturnType<typeof buildPushMap>>>, id: string) => ({ customType: "scout", content: m.text, display: true, details: { id, kind: "map", items: m.entries.map((x) => ({ path: pathOf(x.item), item: x.item.id })) } });
  const pushLog = (m: NonNullable<Awaited<ReturnType<typeof buildPushMap>>>, id: string, deliverAs: string, trigger: string) => log("nudge_queued", { id, deliverAs, kind: "map", trigger, turnIndex: push.turn, sincePromptMs: Date.now() - promptAt, tokens: m.tokens, text: m.text, full: m.full, droppedOpened: m.droppedOpened, truncated: m.truncated, mapMs: m.ms, sourceCalls: m.sourceCalls, items: m.entries.map((x) => ({ item: x.item.id, n: x.n, from: x.from, date: x.item.date ?? null, older: x.olderThan, newer: x.newerThan, opened: isSeen(x.item.id) })) });
  async function pushNow(trigger: string) {
    if (modeRef.delivery !== "push-map" || push.state !== "pending" || stopped) return;
    const gen = push.gen;
    await new Promise((r) => setTimeout(r, 0)); // let a scout call that waited for this ledger take it first
    if (push.state !== "pending" || gen !== push.gen) return;
    if ((ctxRef as any)?.isIdle?.()) { log("push_deferred", { why: "agent idle", trigger, sincePromptMs: Date.now() - promptAt }); return; } // settle delivers (or did)
    const r: any = await makePush();
    if (gen !== push.gen || push.state !== "pending" || stopped) return;
    if (r.skip) { push.state = "done"; log("push_skipped", { why: r.skip, trigger, sincePromptMs: Date.now() - promptAt }); return; }
    stats.pushes++;
    push.id = `M${stats.pushes}`; push.state = "queued"; push.queuedAt = Date.now();
    try { pi.sendMessage(pushMsg(r.m, push.id) as any, { deliverAs: "steer" } as any); }
    catch (err) { push.state = "pending"; log("nudge_error", { id: push.id, error: String(err).slice(0, 200) }); return; }
    pushLog(r.m, push.id, "steer", trigger);
  }

  // ---------------- settle reminder (fallback 1 of v6, the validated v7b arm) ----------------
  pi.on("agent_before_settle", safe("agent_before_settle", async (e: any) => {
    if (stopped) return;
    if (modeRef.delivery === "push-map") { // no reminder in push mode: the map itself is the programmatic delivery
      if (push.state === "queued" && !delivered.has(push.id)) log("push_undelivered_at_settle", { id: push.id, sincePromptMs: Date.now() - promptAt });
      if (push.state !== "pending") return;
      const gen = push.gen;
      push.state = "settling"; // research completion must not steer meanwhile
      const waitMs = E.ledgerWaitMs ?? (loaded?.cfg.research ?? DEFAULT_RESEARCH).ledgerWaitMs;
      const w = Date.now();
      if (!rstate.ready && rstate.running) await Promise.race([rstate.running.catch(() => null), new Promise((r) => setTimeout(r, waitMs))]);
      if (gen !== push.gen || stopped) return;
      const r: any = await makePush();
      push.state = "done";
      if (r.skip) { log("push_skipped", { why: r.skip, trigger: "settle", waitedMs: Date.now() - w, sincePromptMs: Date.now() - promptAt }); return; }
      stats.pushes++;
      push.id = `M${stats.pushes}`;
      pushLog(r.m, push.id, "agent_before_settle", "settle");
      const msg = pushMsg(r.m, push.id);
      return { entries: [...(e.entries ?? []), { type: "custom_message", ...msg }], continue: true };
    }
    // pull mode only (opt-in): reminder to call the tool (push mode returned above)
    const mode = E.reminder ?? loaded?.cfg.reminder ?? "always";
    if (mode === "off" || !modeRef.tool || task.reminded || task.toolCalled || !task.isTask) return;
    if (mode === "sources" && !sources.length) return;
    task.reminded = true; stats.reminders++;
    const id = `R${stats.reminders}`;
    log("nudge_queued", { id, deliverAs: "agent_before_settle", kind: "reminder", sincePromptMs: Date.now() - promptAt, tokens: estTok(REMINDER_TEXT), text: REMINDER_TEXT, items: [] });
    return { entries: [...(e.entries ?? []), { type: "custom_message", customType: "scout", content: REMINDER_TEXT, display: true, details: { id, items: [] } }], continue: true };
  }));
  const delivered = new Set<string>();
  pi.on("context", safe("context", async (e: any) => {
    for (const [i, m] of (e.messages as any[]).entries()) {
      if (m?.customType !== "scout" || !m?.details?.id || delivered.has(m.details.id)) continue;
      delivered.add(m.details.id);
      log("nudge_delivered", { id: m.details.id, kind: m.details.kind ?? null, msgIndex: i, turnIndex: push.turn, sincePromptMs: Date.now() - promptAt, sinceQueuedMs: m.details.kind === "map" && push.queuedAt ? Date.now() - push.queuedAt : null });
    }
    return undefined;
  }));
}
