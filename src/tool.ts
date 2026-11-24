// pi-scout pull tool `scout` (from scout-v7 tool.ts, v7b product arm). Read-only. Returns a dated map of ≤ 12 locators:
// the background researcher's findings for this task (research.ts ledger) interleaved with a fresh plain search of the
// agent's own words over every enabled source (map7.ts) — never item content, never the title of an externally written
// item. When the researcher is still running, the tool waits for it up to `ledgerWaitMs` (default 15 s), then answers
// with what it has and says the background search is still running.
// Removed vs v7b: `draft_path` and the v6 audit, parked leads, the SCOUT_TEST_MAP_FIRST hook.
// Sources: the workspace index; listed MCP servers through the scout's own client; listed `route: "pi"` servers through
// ctx.executeTool (documented for a tool's execute(); nested calls run every extension's tool_call handlers). Only tools
// with readOnlyHint === true are ever called (sources/mcp.ts gate). Open-world sources get only the user's prompt words.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Index } from "./index.ts";
import type { Source } from "./types.ts";
import type { WorkspaceSource } from "./sources/workspace.ts";
import { type Loaded, buildSources } from "./sources/config.ts";
import type { CallBudget } from "./sources/budget.ts";
import type { Tracker } from "./tracker.ts";
import { type Background, MAP7_CFG, buildMap7 } from "./map7.ts";
import type { LedgerEntry } from "./research.ts";

export const KINDS = ["facts", "rules", "updates", "people"];
export type ResearchState = { ledger: LedgerEntry[]; ready: boolean; running: Promise<unknown> | null; startedAt: number; status: Background };
export type ToolState = { idx: Index | null; workspace: WorkspaceSource | null; sources: Source[]; task: string; tracker: Tracker | null; loaded: Loaded | null; calls: CallBudget; cwd: string; isSeen: (id: string) => boolean; research: ResearchState; maxExternal: number };
export type ToolDeps = { pi: ExtensionAPI; getState: () => ToolState; log: (ev: string, d: Record<string, unknown>) => void; onCall: (id: string) => void; onMap?: (background: Background) => void; guideline: boolean; ledgerWaitMs: number; waitIndex: (ms: number) => Promise<boolean> };

export const MAP_MAX = MAP7_CFG.max;
export const TOOL_DESCRIPTION = "Search every source enabled for the scout at once (the workspace's files and git history, plus connected read-only tools the user listed: chat, CRM, tickets, web) and get a compact dated map of up to 12 items: what the scout's own background search found for this task (decisions, rules, templates, newer updates, key facts, in any language) and the best matches for your words. Each entry says how to open it, its date and source, whether you opened it, and 'older than / newer than' links between items on the same subject. Locators only, no content: open what you need.";
export const TOOL_GUIDELINE = "Before you finish a document, reply or change, call scout with its subject to see related rules, templates and newer updates you may not have opened.";

export function makeScoutTool(d: ToolDeps) {
  return {
    name: "scout", label: "Scout",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Search all enabled sources at once; returns a dated list of item locators (no content)",
    ...(d.guideline ? { promptGuidelines: [TOOL_GUIDELINE] } : {}),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in natural words: the subject, names, terms" },
        kinds: { type: "array", items: { type: "string", enum: KINDS }, description: "Optional focus: facts, rules (conventions, templates, decisions), updates (newer or superseding items), people" },
      },
      required: ["query"], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    async execute(toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      d.onCall(toolCallId);
      const t0 = Date.now();
      try {
        let st = d.getState();
        if (!st.idx) { await d.waitIndex(Math.min(Math.max(d.ledgerWaitMs, 3000), 10000)); st = d.getState(); }
        if (!st.idx) return { content: [{ type: "text", text: "scout: still indexing the workspace; try again in a moment." }], details: { items: [] } };
        // wait for the background researcher (bounded); the agent's own words are searched either way
        let waitedMs = 0;
        if (!st.research.ready && st.research.running && d.ledgerWaitMs > 0) {
          const left = Math.max(0, d.ledgerWaitMs - (Date.now() - t0));
          const w = Date.now();
          await Promise.race([st.research.running.catch(() => null), new Promise((r) => setTimeout(r, left)), new Promise((r) => signal?.addEventListener("abort", r, { once: true }))]);
          waitedMs = Date.now() - w;
          st = d.getState();
        }
        const query = String(params?.query ?? "").slice(0, MAP7_CFG.queryChars);
        // client-route sources (session) + pi-route sources (this call's ctx.executeTool)
        let piSources: Source[] = [];
        if (st.loaded && typeof ctx?.executeTool === "function") {
          try {
            const ex = (name: string, args: any, o?: any) => ctx.executeTool(name, args, o);
            const b = await buildSources(st.loaded.cfg, st.cwd, false, { allTools: () => d.pi.getAllTools(), executeTool: () => ex, agentCanCall: (n: string) => d.pi.getActiveTools().includes(n) }, [], { calls: st.calls, piRoute: true });
            piSources = b.sources;
          } catch (e) { d.log("scout_tool_error", { stage: "pi sources", error: String(e).slice(0, 200) }); }
        }
        const written = (id: string) => id.startsWith("file:") && !!st.tracker?.seen.write.has(id.slice(5));
        const background: Background = st.research.ready ? st.research.status : st.research.running ? "running" : st.research.status;
        d.onMap?.(background); // PUSHMAP: before any await, so a push racing with this call sees it
        const map = await buildMap7({ query, ledger: st.research.ledger, background, idx: st.idx, workspace: st.workspace, sources: [...st.sources, ...piSources], isSeen: st.isSeen, isExcluded: written, signal, taskText: st.task, maxExternal: st.maxExternal });
        d.log("scout_tool", { toolCallId, query, kinds: params?.kinds ?? [], mapVersion: MAP7_CFG.version, background, items: map.entries.map((e) => ({ id: e.item.id, n: e.n, from: e.from, kind: e.kind ?? null, date: e.item.date ?? null, source: e.item.source, external: !!e.item.external, older: e.olderThan, newer: e.newerThan, copies: e.copies ?? 0 })), ledgerSize: map.ledgerSize, ledgerReady: map.ledgerReady, plainDropped: map.plainDropped, openWorldSkipped: map.openWorldSkipped, waitedMs, mapTokens: map.tokens, mapMs: map.ms, sourceCalls: map.sourceCalls, piSources: piSources.map((s) => s.id), toolCalls: st.calls.stats(), ms: Date.now() - t0 });
        return { content: [{ type: "text", text: map.text }], details: { items: map.entries.map((e) => ({ path: e.item.locator.type === "file" ? e.item.locator.path : e.item.id.replace(/^(mcp:[^/]+\/|url:|file:)/, "") })) } };
      } catch (e) {
        d.log("scout_tool_error", { toolCallId, stage: "execute", error: String((e as any)?.stack ?? e).slice(0, 400) });
        return { content: [{ type: "text", text: "scout: the search failed this time; continue without it." }], details: { items: [] } };
      }
    },
  };
}
