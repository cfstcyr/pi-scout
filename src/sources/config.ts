// pi-scout source and product configuration (from scout-v7 sources/config.ts; product keys added, benchmark file gated).
// DEFAULT (no file): workspace only (local files + git log), no MCP server, no web, researcher on with the session
// provider's small model, settle reminder after task-like prompts.
//
// Where the config comes from (loaded once per session, at session_start, with the project's trust state):
//   base (user level)   $SCOUT_SOURCES (a file the user/launcher names), else <agent dir>/scout-sources.json (<agent dir> =
//                       $PI_CODING_AGENT_DIR or ~/.pi/agent). $HARNESS_TOOLS_CONFIG (experiment harness) is read only when
//                       SCOUT_BENCH=1. Only the base can add servers, commands, tools, openWorld, capture, discover or a model.
//   project (restrict)  <cwd>/.pi/scout-sources.json, read only in trusted projects, may only RESTRICT the base: deny
//                       servers, disable workspace / grep / a server / the researcher / its LLM / the reminder, narrow tools,
//                       lower budgets. Anything else in it is ignored and logged.
// {
//   "workspace": { "enabled": true, "budgetMs": 2000 },
//   "grep":      { "enabled": false, "tool": "builtin" | "<pi tool, e.g. ffgrep (needs capture)>", "budgetMs": 1500 },
//   "mcp": { "<server>": {
//       "route": "client" | "pi",                 client (default) = the scout's own MCP client; pi = through pi's tools,
//                                                  only from inside the scout tool (ctx.executeTool)
//       "config": { "command": "...", "args": [...], "env": {...} } | { "url": "..." } | null,   null = pi's mcp.json entry
//       "searchTools": ["search_notes"],          REQUIRED: the only tools used as searches
//       "fetchTools": ["get_note"],               tools used to name an item (locator) or read it for the researcher
//       "openWorld": false,                       true = opt in: this server may receive the words of YOUR prompt (never
//                                                  folder-derived words); also required for tools with openWorldHint
//       "external": true,                         externally writable content (mail, web, chat, CRM…): default see externalDefault
//       "agentPrefix": "mcp__<server>__",         how the agent sees the server's tools; default as pi
//       "budgetMs": 3000, "enabled": true } },
//   "externalDefault": "all" | "openWorld",       servers without "external": all = every server external (0.1.0 default);
//                                                  openWorld = only openWorld servers (web URLs are always external)
//   "deny": ["server-or-prefix"],
//   "capture": false, "discover": "off" | "log",
//   "research": { "enabled": true,                background researcher at task-like prompts
//                 "llm": true,                    false = lexical only (no model call at all)
//                 "model": "provider/id" | "session",   default: the session provider's small model; never another provider
//                 "minTaskTerms": 5,              prompts with fewer distinct content words are "trivial" (no researcher, no reminder)
//                 "maxRunsPerSession": 30, "maxTokensPerSession": 600000, "maxTokensPerRun": 40000, "ledgerWaitMs": 15000 },
//   "judgeModel": "provider/id",                  legacy alias of research.model
//   "reminder": "always" | "sources" | "off",     settle reminder to call `scout` (after task-like prompts only)
//   "map": { "maxExternal": 3 },                  at most this many externally written items in one map
//   "calls": { "perServer": 12, "total": 30, "perCallMs": 3000, "breakAfter": 2, "perPrompt": 60 }   caps (lower only);
//            perServer / total also lower the researcher's own caps (24 / 48); perPrompt caps tool + researcher together
// }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpClient, type McpServerConfig, type McpTool } from "./mcp-client.ts";
import { McpSource, clientRoute, mcpToolName, queryParam, type McpRoute } from "./mcp.ts";
import { GrepToolSource } from "./greptool.ts";
import { CallBudget } from "./budget.ts";
import { benchConfigFromTools } from "./bench.ts";
import { normName } from "../safety.ts";
import type { Source } from "../types.ts";

export type ServerCfg = {
  route?: "client" | "pi"; config?: McpServerConfig | null; searchTools?: string[]; fetchTools?: string[];
  openWorld?: boolean; external?: boolean; agentPrefix?: string; budgetMs?: number; enabled?: boolean;
};
export type SourcesConfig = {
  workspace?: { enabled?: boolean; budgetMs?: number };
  grep?: { enabled?: boolean; tool?: string; budgetMs?: number };
  mcp?: Record<string, ServerCfg>;
  capture?: boolean;
  discover?: "off" | "log";
  deny?: string[];
  judgeModel?: string;
  calls?: { perServer?: number; total?: number; perCallMs?: number; breakAfter?: number; perPrompt?: number };
  /** Researcher's own MCP call caps per prompt (defaults 24 / 48, lowered by the user's `calls`). */
  researchCalls?: { perServer: number; total: number; perCallMs: number; breakAfter: number };
  research?: ResearchOpts;
  reminder?: "always" | "sources" | "off";
  map?: { maxExternal: number };
  externalDefault?: "all" | "openWorld";
  /** 0.2: "push" (default) = the researcher's dated map is injected once per prompt, no tool; "pull" = 0.1 behaviour. */
  delivery?: "push" | "pull";
  /** 0.2: register the `scout` tool (default: only with delivery "pull"). */
  tool?: boolean;
};
export type ResearchOpts = { enabled: boolean; llm: boolean; model?: string; minTaskTerms: number; maxRunsPerSession: number; maxTokensPerSession: number; maxTokensPerRun: number; ledgerWaitMs: number };
export const DEFAULT_RESEARCH: Readonly<ResearchOpts> = Object.freeze({ enabled: true, llm: true, minTaskTerms: 5, maxRunsPerSession: 30, maxTokensPerSession: 600_000, maxTokensPerRun: 40_000, ledgerWaitMs: 15_000 });
export const DEFAULT_CALLS = Object.freeze({ perServer: 12, total: 30, perCallMs: 3000, breakAfter: 2, perPrompt: 60 });
export const DEFAULT_RESEARCH_CALLS = Object.freeze({ perServer: 24, total: 48 });
const MODEL_RE = /^[\w.-]+\/[\w.:-]+$/;
export const DEFAULT_CONFIG: Readonly<SourcesConfig> = Object.freeze({ workspace: { enabled: true, budgetMs: 2000 }, grep: { enabled: false }, mcp: {}, capture: false, discover: "off", deny: [] });

const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return undefined; } };
export const agentDir = (env: Record<string, string | undefined> = process.env) => env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const minPos = (a: number | undefined, b: number | undefined) => (b !== undefined && Number.isFinite(b) && b > 0 ? (a === undefined ? b : Math.min(a, b)) : a);

/** Base config (user level). Unknown / malformed values fall back to the safe defaults. */
export function sanitizeBase(raw: any): SourcesConfig {
  const c: SourcesConfig = { workspace: { ...DEFAULT_CONFIG.workspace }, grep: { enabled: false }, mcp: {}, capture: false, discover: "off", deny: [], research: { ...DEFAULT_RESEARCH }, reminder: "always", map: { maxExternal: 3 }, calls: { ...DEFAULT_CALLS }, researchCalls: { ...DEFAULT_RESEARCH_CALLS, perCallMs: DEFAULT_CALLS.perCallMs, breakAfter: DEFAULT_CALLS.breakAfter } };
  if (!raw || typeof raw !== "object") return c;
  if (raw.workspace && typeof raw.workspace === "object") c.workspace = { enabled: raw.workspace.enabled !== false, budgetMs: Number(raw.workspace.budgetMs) > 0 ? Number(raw.workspace.budgetMs) : 2000 };
  if (raw.grep && typeof raw.grep === "object") c.grep = { enabled: raw.grep.enabled === true, tool: typeof raw.grep.tool === "string" ? raw.grep.tool : "builtin", budgetMs: Number(raw.grep.budgetMs) > 0 ? Number(raw.grep.budgetMs) : 1500 };
  c.capture = raw.capture === true;
  c.discover = raw.discover === "log" || raw.discover === "readonly" ? "log" : "off"; // "readonly" (v5.0) now only logs
  c.deny = Array.isArray(raw.deny) ? raw.deny.map(String) : [];
  if (typeof raw.judgeModel === "string" && MODEL_RE.test(raw.judgeModel)) c.research!.model = raw.judgeModel;
  const r = raw.research;
  if (r && typeof r === "object") {
    if (r.enabled === false) c.research!.enabled = false;
    if (r.llm === false) c.research!.llm = false;
    if (typeof r.model === "string" && (r.model === "session" || MODEL_RE.test(r.model))) c.research!.model = r.model;
    for (const k of ["minTaskTerms", "maxRunsPerSession", "maxTokensPerSession", "maxTokensPerRun", "ledgerWaitMs"] as const) {
      const v = Number(r[k]);
      if (r[k] !== undefined && Number.isFinite(v) && v >= 0) (c.research as any)[k] = k === "minTaskTerms" ? Math.min(Math.max(1, v), 30) : k === "ledgerWaitMs" ? Math.min(v, 30_000) : v;
    }
  }
  if (raw.reminder === "off" || raw.reminder === false) c.reminder = "off"; else if (raw.reminder === "sources") c.reminder = "sources";
  if (raw.map && typeof raw.map === "object" && Number.isFinite(Number(raw.map.maxExternal)) && Number(raw.map.maxExternal) >= 0) c.map = { maxExternal: Math.min(Number(raw.map.maxExternal), 12) };
  if (raw.calls && typeof raw.calls === "object") {
    c.calls = { perServer: minPos(12, raw.calls.perServer), total: minPos(30, raw.calls.total), perCallMs: minPos(3000, raw.calls.perCallMs), breakAfter: minPos(2, raw.calls.breakAfter), perPrompt: minPos(DEFAULT_CALLS.perPrompt, raw.calls.perPrompt) };
    c.researchCalls = { perServer: minPos(DEFAULT_RESEARCH_CALLS.perServer, raw.calls.perServer)!, total: minPos(DEFAULT_RESEARCH_CALLS.total, raw.calls.total)!, perCallMs: c.calls.perCallMs!, breakAfter: c.calls.breakAfter! };
  }
  c.externalDefault = raw.externalDefault === "openWorld" ? "openWorld" : "all";
  if (raw.delivery === "pull") c.delivery = "pull";
  if (typeof raw.tool === "boolean") c.tool = raw.tool;
  for (const [name, sc] of Object.entries<any>(raw.mcp ?? {})) {
    if (!sc || typeof sc !== "object" || !Array.isArray(sc.searchTools) || !sc.searchTools.length) continue; // opt-in names its search tools
    c.mcp![name] = {
      route: sc.route === "pi" ? "pi" : "client", config: sc.config === undefined ? null : sc.config,
      searchTools: sc.searchTools.map(String), fetchTools: Array.isArray(sc.fetchTools) ? sc.fetchTools.map(String) : [],
      openWorld: sc.openWorld === true, external: sc.external === true || (sc.external !== false && (c.externalDefault === "all" || sc.openWorld === true)), agentPrefix: typeof sc.agentPrefix === "string" ? sc.agentPrefix : undefined,
      budgetMs: Number(sc.budgetMs) > 0 ? Math.min(Number(sc.budgetMs), 10000) : 3000, enabled: sc.enabled !== false,
    };
  }
  return c;
}
/** Apply a project file: restrictions only. Returns the merged config and what was ignored. */
export function applyProjectRestrictions(base: SourcesConfig, proj: any): { cfg: SourcesConfig; ignored: string[] } {
  const cfg: SourcesConfig = JSON.parse(JSON.stringify(base));
  const ignored: string[] = [];
  if (!proj || typeof proj !== "object") return { cfg, ignored };
  for (const [k, v] of Object.entries<any>(proj)) {
    if (k === "deny" && Array.isArray(v)) cfg.deny = [...(cfg.deny ?? []), ...v.map(String)];
    else if (k === "capture") { if (v === false) cfg.capture = false; else ignored.push("capture"); }
    else if (k === "discover") { if (v === "off") cfg.discover = "off"; else ignored.push("discover"); }
    else if (k === "research" && v && typeof v === "object") {
      for (const [f, val] of Object.entries<any>(v)) {
        if (f === "enabled" && val === false) cfg.research!.enabled = false;
        else if (f === "llm" && val === false) cfg.research!.llm = false;
        else if (["maxRunsPerSession", "maxTokensPerSession", "maxTokensPerRun", "ledgerWaitMs"].includes(f) && Number(val) >= 0) (cfg.research as any)[f] = Math.min((cfg.research as any)[f], Number(val));
        else if (f === "minTaskTerms" && Number(val) > 0) cfg.research!.minTaskTerms = Math.max(cfg.research!.minTaskTerms, Math.min(Number(val), 30));
        else ignored.push(`research.${f}`);
      }
    }
    else if (k === "tool") { if (v === false) cfg.tool = false; else ignored.push("tool"); }
    else if (k === "reminder") { if (v === "off" || v === false) cfg.reminder = "off"; else ignored.push("reminder"); }
    else if (k === "map" && v && typeof v === "object" && Number(v.maxExternal) >= 0) cfg.map = { maxExternal: Math.min(cfg.map?.maxExternal ?? 3, Number(v.maxExternal)) };
    else if (k === "calls" && v && typeof v === "object") {
      const lower = (o: any, f: string) => { if (o && Number(v[f]) > 0) o[f] = Math.min(o[f] ?? Infinity, Number(v[f])); };
      for (const f of ["perServer", "total", "perCallMs", "breakAfter", "perPrompt"]) lower(cfg.calls, f);
      for (const f of ["perServer", "total", "perCallMs", "breakAfter"]) lower(cfg.researchCalls, f);
    }
    else if (k === "workspace" && v && typeof v === "object") { if (v.enabled === false) cfg.workspace!.enabled = false; cfg.workspace!.budgetMs = minPos(cfg.workspace!.budgetMs, v.budgetMs); }
    else if (k === "grep" && v && typeof v === "object") { if (v.enabled === false) cfg.grep!.enabled = false; else if (v.enabled === true || v.tool) ignored.push("grep"); cfg.grep!.budgetMs = minPos(cfg.grep!.budgetMs, v.budgetMs); }
    else if (k === "mcp" && v && typeof v === "object") {
      for (const [name, sc] of Object.entries<any>(v)) {
        const key = Object.keys(cfg.mcp ?? {}).find((n) => normName(n) === normName(name));
        if (!key) { ignored.push(`mcp.${name} (not in the user config)`); continue; }
        const t = cfg.mcp![key];
        for (const [f, val] of Object.entries<any>(sc ?? {})) {
          if (f === "enabled" && val === false) t.enabled = false;
          else if (f === "searchTools" && Array.isArray(val)) t.searchTools = (t.searchTools ?? []).filter((x) => val.includes(x));
          else if (f === "fetchTools" && Array.isArray(val)) t.fetchTools = (t.fetchTools ?? []).filter((x) => val.includes(x));
          else if (f === "openWorld" && val === false) t.openWorld = false;
          else if (f === "external" && val === true) t.external = true;
          else if (f === "budgetMs") t.budgetMs = minPos(t.budgetMs, val);
          else ignored.push(`mcp.${name}.${f}`);
        }
      }
    } else ignored.push(k);
  }
  return { cfg, ignored };
}
export type Loaded = { cfg: SourcesConfig; file: string | null; projectFile: string | null; ignored: string[]; bench: boolean };
/** Load once per session (session_start), with the project's trust state. */
export function loadSourcesConfig(cwd: string, trusted: boolean, env: Record<string, string | undefined> = process.env): Loaded {
  let base: SourcesConfig = sanitizeBase(undefined), file: string | null = null, bench = false;
  if (env.SCOUT_SOURCES) { const j = readJson(env.SCOUT_SOURCES); if (j) { base = sanitizeBase(j); file = env.SCOUT_SOURCES; } }
  else if (env.HARNESS_TOOLS_CONFIG && env.SCOUT_BENCH === "1") { const j = readJson(env.HARNESS_TOOLS_CONFIG); if (j) { base = sanitizeBase(benchConfigFromTools(j, env.SCOUT_BENCH_EXTERNAL ?? "kind")); file = env.HARNESS_TOOLS_CONFIG; bench = true; } }
  else { const f = path.join(agentDir(env), "scout-sources.json"); const j = readJson(f); if (j) { base = sanitizeBase(j); file = f; } }
  let projectFile: string | null = null, ignored: string[] = [];
  if (trusted) {
    const f = path.join(cwd, ".pi", "scout-sources.json");
    const j = readJson(f);
    if (j) { projectFile = f; const r = applyProjectRestrictions(base, j); base = r.cfg; ignored = r.ignored; }
  }
  return { cfg: base, file, projectFile, ignored, bench };
}
export const denied = (cfg: SourcesConfig, name: string) => (cfg.deny ?? []).some((d) => normName(d) === normName(name));
/** Servers that are configured, enabled and not denied. */
export const activeServers = (cfg: SourcesConfig) => Object.entries(cfg.mcp ?? {}).filter(([n, s]) => s.enabled !== false && !denied(cfg, n));

export function piMcpEntry(name: string, cwd: string, trusted: boolean, env: Record<string, string | undefined> = process.env): McpServerConfig | null {
  // user file only: a project's mcp.json cannot inject a command into the scout
  const j = readJson(path.join(agentDir(env), "mcp.json"));
  const e = j?.mcpServers?.[name];
  return e?.command || e?.url ? e : null;
}

export type PiHooks = {
  allTools: () => any[]; // pi.getAllTools()
  executeTool: () => ((name: string, args: any, opts?: any) => Promise<any>) | null; // captured tool ctx, if any
  agentCanCall: (name: string) => boolean;
  grepBuiltin?: (pattern: string, signal?: AbortSignal) => Promise<string>;
};
/** pi route for one MCP server: tools from pi.getAllTools() (namespace mcp__<server>), calls through ctx.executeTool. */
export function piRoute(server: string, hooks: PiHooks, prefix?: string): McpRoute {
  const pre = prefix ?? `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;
  const tools = (): McpTool[] => hooks.allTools().filter((t: any) => String(t.name).startsWith(pre))
    .map((t: any) => ({ name: String(t.name).slice(pre.length), description: t.description, inputSchema: t.parameters, annotations: t.annotations }));
  return {
    kind: "pi", tools,
    connected: () => !!hooks.executeTool() && tools().length > 0,
    call: async (tool, args, signal) => { const ex = hooks.executeTool(); if (!ex) throw new Error("no tool context"); const r = await ex(`${pre}${tool}`, args, { signal }); const res = r?.result ?? r ?? {}; return { ...res, isError: r?.isError ?? res?.isError }; },
  };
}
/** discover "log": read-only search tools pi exposes to the agent, for the log only (never called). */
export function discoverPiTools(cfg: SourcesConfig, hooks: PiHooks): { tool: string; server: string }[] {
  if (cfg.discover !== "log") return [];
  return hooks.allTools().filter((t: any) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true && t.sourceInfo?.source !== "builtin" && queryParam({ name: t.name, inputSchema: t.parameters }))
    .map((t: any) => ({ tool: String(t.name), server: String(t.name).match(/^mcp__(.+?)__/)?.[1] ?? String(t.name).split("_")[0] }))
    .filter((x) => !denied(cfg, x.server));
}
export type Built = { sources: Source[]; clients: McpClient[]; log: Record<string, unknown>; calls: CallBudget };
export async function buildSources(cfg: SourcesConfig, cwd: string, trusted: boolean, hooks: PiHooks, extra: Source[] = [], opts: { connectMs?: number; calls?: CallBudget; env?: Record<string, string | undefined>; piRoute?: boolean } = {}): Promise<Built> {
  const sources: Source[] = [...extra];
  const clients: McpClient[] = [];
  const log: Record<string, unknown> = {};
  const calls = opts.calls ?? new CallBudget(cfg.calls);
  if (cfg.grep?.enabled && !opts.piRoute) {
    const tool = cfg.grep.tool ?? "builtin";
    if (tool === "builtin" || cfg.capture) {
      const run = tool === "builtin" ? hooks.grepBuiltin! : async (pattern: string, signal?: AbortSignal) => { const ex = hooks.executeTool(); if (!ex) throw new Error("no tool context"); const r = await ex(tool, { pattern }, { signal }); return (r?.result?.content ?? []).map((c: any) => c.text ?? "").join("\n"); };
      sources.push(new GrepToolSource(`grep:${tool}`, run, () => tool === "builtin" ? !!hooks.grepBuiltin : !!hooks.executeTool(), cfg.grep.budgetMs ?? 1500));
      log.grep = tool;
    } else log.grep = `${tool}: needs capture`;
  }
  const built = await Promise.all(activeServers(cfg).map(async ([name, sc]): Promise<McpSource | null> => {
    let route: McpRoute | null = null;
    if (sc.route === "pi") {
      // v6: no capture. A pi-routed server is reachable only inside the scout tool's execute(), whose ctx.executeTool
      // is passed as hooks.executeTool by tool.ts; event handlers (the settle audit) never see it.
      if (!opts.piRoute) { log[`mcp:${name}`] = "route pi: scout tool only"; return null; }
      route = piRoute(name, hooks, sc.agentPrefix);
    } else if (opts.piRoute) { return null; // the tool reuses the session's client sources
    } else {
      const conf = sc.config ?? piMcpEntry(name, cwd, trusted, opts.env);
      if (!conf) { log[`mcp:${name}`] = "no server config"; return null; }
      const client = new McpClient(name, conf);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), opts.connectMs ?? 8000);
      try { await client.connect(ac.signal); clients.push(client); route = clientRoute(client); }
      catch (e) { client.close(); log[`mcp:${name}`] = `client connect failed: ${String(e).slice(0, 120)}`; return null; }
      finally { clearTimeout(t); }
    }
    const prefix = sc.agentPrefix ?? `mcp__${name.replace(/[^A-Za-z0-9_]/g, "_")}__`;
    const src = new McpSource(name, route, { searchTools: sc.searchTools, fetchTools: sc.fetchTools, openWorld: sc.openWorld, external: sc.external, budgetMs: sc.budgetMs, agentCanCall: hooks.agentCanCall, agentName: (tool) => `${prefix}${tool}`, calls });
    log[`mcp:${name}`] = { route: route.kind, external: src.external, openWorld: !!sc.openWorld, search: src.searchTools().map((t) => t.name), fetch: src.fetchTools().map((t) => t.name), refused: src.refused() };
    return src;
  }));
  for (const s of built) if (s) sources.push(s); // config order (deterministic round-robin)
  return { sources, clients, log, calls };
}
export { mcpToolName };
