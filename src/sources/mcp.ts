// (v6 copy of scout-v5/sources/mcp.ts: web items use a tool locator, every item with a fetch tool gets fetch() for verification.)
// Source "mcp:<server>": read-only MCP search tools as a retrieval source. Two routes, same adapter:
//   client  (default) the scout's own MCP client (sources/mcp-client.ts) for servers on the user's allowlist: works from
//           the prompt, needs no tool-context capture.
//   pi      opt-in (`route: "pi"` + `capture: true`): the server is connected by pi; calls go through a captured tool
//           context (ctx.executeTool), so pi's tool_call permission handlers apply.
// Tool gate (allowedTool): a tool is called only if ALL hold — annotations.readOnlyHint === true (from the server's own
// tools/list), destructiveHint !== true, the tool is explicitly listed in the server's `searchTools` / `fetchTools`,
// and (openWorldHint !== true or the server has `openWorld: true`). A listed tool without readOnlyHint is refused.
// Every call goes through the shared CallBudget (per-server / per-task caps, 3 s per call, circuit breaker).
import type { Item, QueryInputs, Source } from "../types.ts";
import type { McpClient, McpTool } from "./mcp-client.ts";
import { CallBudget } from "./budget.ts";
import { safeArgs, safeToolName, safeUrl } from "../safety.ts";

// query-like parameters; free-text names (text, question, message, prompt) only for declared search tools
const QUERY_KEYS_STRICT = ["query", "q", "search", "keywords", "term", "terms"];
const QUERY_KEYS_DECLARED = [...QUERY_KEYS_STRICT, "text", "question", "message"];
const ID_KEYS = ["id", "uri", "key", "slug", "path", "url", "name"];
const pick = (o: any, keys: string[]) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== "") return o[k]; return undefined; };
export const mcpToolName = (server: string, tool: string) => `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`;

/** Why a tool may not be called (null = allowed). `listed` = the server's searchTools + fetchTools. */
export function refusal(t: McpTool, listed: string[] = [], openWorld = false): string | null {
  if (!listed.includes(t.name)) return "not listed";
  if (t.annotations?.destructiveHint === true) return "destructiveHint";
  if (t.annotations?.readOnlyHint !== true) return "no readOnlyHint";
  if (t.annotations?.openWorldHint === true && !openWorld) return "openWorldHint without openWorld opt-in";
  return null;
}
export const allowedTool = (t: McpTool, listed: string[] = [], openWorld = false) => refusal(t, listed, openWorld) === null;
/** The string property named like a query (declared search tools also accept text/question/message). */
export function queryParam(t: McpTool, declared = false): string | null {
  const props = t.inputSchema?.properties ?? {};
  for (const k of declared ? QUERY_KEYS_DECLARED : QUERY_KEYS_STRICT) if (props[k] && (props[k].type === "string" || !props[k].type)) return k;
  return null;
}
/** A fetch tool: exactly one required string property named like an id. */
export function idParam(t: McpTool): string | null {
  const req: string[] = t.inputSchema?.required ?? [];
  const props = t.inputSchema?.properties ?? {};
  if (req.length !== 1 || !ID_KEYS.includes(req[0]) || (props[req[0]]?.type && props[req[0]].type !== "string")) return null;
  return req[0];
}
/** Items from a CallToolResult: structuredContent or JSON text with an array of objects. */
export function parseItems(r: any): any[] {
  let data: any = r?.structuredContent;
  if (!data) { const t = (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"); try { data = JSON.parse(t); } catch { return parseTextItems(t); } }
  if (Array.isArray(data)) return data.filter((x) => x && typeof x === "object");
  for (const k of ["results", "items", "data", "hits", "notes", "documents", "records", "entries", "messages", "matches"]) if (Array.isArray(data?.[k])) return data[k].filter((x: any) => x && typeof x === "object");
  return [];
}

/**
 * Items from a plain-text result (one item per line or per numbered block), generic heuristics:
 *   "DEM-12 [open] Title — …, updated 2026-01-05"  ·  "N-3 2026-01-02 [note] Title — …"  ·  "M-9 #chan 2026-… ana: text"
 *   "1. Page title\n   https://… (2026-02-01)\n   snippet"
 * id = URL in the block, else a leading identifier token (letters/digits with a digit); title = the rest of the first line
 * up to " — ", without [tags], dates and #channels; date = first date in the block.
 */
export function parseTextItems(text: string): any[] {
  const blocks: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const starts = /^\s{0,1}(\d{1,3}[.)]\s+\S|[A-Za-z]{0,12}[-_#]?\d[\w.-]*\s|https?:\/\/)/.test(line) && !/^\s{2,}/.test(line);
    if (starts || !blocks.length) blocks.push([line]); else blocks[blocks.length - 1].push(line);
  }
  const out: any[] = [];
  for (const b of blocks) {
    const first = b[0].trim();
    if (/^\d+ match(es)?\b|^no \w+ match|^showing\b/i.test(first)) continue;
    const all = b.join("\n");
    const url = all.match(/https?:\/\/[^\s)\]>"']+/)?.[0];
    const lead = first.match(/^([A-Za-z]{0,12}[-_#]?\d[\w.-]*)\s/)?.[1];
    const numbered = /^\d{1,3}[.)]\s/.test(first);
    const id = url ?? (numbered ? undefined : lead);
    if (!id) continue;
    let title = first.replace(/^\d{1,3}[.)]\s+/, "");
    if (!numbered && lead) title = title.slice(lead.length);
    title = title.split(" — ")[0].replace(/\[[^\]]*\]/g, " ").replace(/#[\w-]+/g, " ").replace(/(?:19|20)\d\d-\d\d-\d\d(?:[T ][\d:]+Z?)?/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
    const dm = all.match(/(?:19|20)\d\d-\d\d-\d\d/);
    out.push({ id, title: title || id, date: dm?.[0], snippet: all.replace(/\s+/g, " ").slice(0, 600) });
  }
  return out;
}

export type McpRoute = {
  kind: "pi" | "client";
  tools: () => McpTool[];
  call: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
  connected: () => boolean;
};
export type McpSourceOpts = {
  searchTools?: string[]; fetchTools?: string[]; openWorld?: boolean; external?: boolean; budgetMs?: number;
  agentCanCall?: (piToolName: string) => boolean; agentName?: (tool: string) => string; limit?: number; calls?: CallBudget;
};
export class McpSource implements Source {
  kind = "mcp" as const;
  id: string;
  calls: CallBudget;
  constructor(public server: string, public route: McpRoute, public opts: McpSourceOpts = {}) { this.id = `mcp:${server}`; this.calls = opts.calls ?? new CallBudget(); }
  get budgetMs() { return this.opts.budgetMs ?? 3000; }
  get external() { return this.opts.external !== false; }
  describe() { return `MCP server ${this.server} (${this.route.kind} route), listed read-only tools`; }
  available(budget?: CallBudget) { return this.route.connected() && this.searchTools().length > 0 && (budget ?? this.calls).open(this.server); }
  private listed() { return [...(this.opts.searchTools ?? []), ...(this.opts.fetchTools ?? [])]; }
  /** Tools listed by the user but refused by the gate (logged once by the caller). */
  refused() { return this.route.tools().map((t) => ({ name: t.name, why: refusal(t, this.listed(), this.opts.openWorld) })).filter((x) => x.why && x.why !== "not listed"); }
  searchTools() { return this.route.tools().filter((t) => (this.opts.searchTools ?? []).includes(t.name) && allowedTool(t, this.listed(), this.opts.openWorld) && queryParam(t, true)); }
  fetchTools() { return this.route.tools().filter((t) => (this.opts.fetchTools ?? []).includes(t.name) && allowedTool(t, this.listed(), this.opts.openWorld) && idParam(t)); }
  /** Fetch tool for a search tool's items: same noun (search_notes → get_note / read_note / fetch_note), else the only one. */
  fetchTool(search?: McpTool) {
    const fts = this.fetchTools();
    if (!search) return fts[0];
    const sing = (w: string) => w.toLowerCase().replace(/s$/, ""); // notes → note, tickets → ticket, messages → message
    const noun = sing(search.name.replace(/^(.*?__)?(search|find|query|list|lookup)_?/i, ""));
    return (noun ? fts.find((t) => sing(t.name.replace(/^(.*?__)?(get|read|fetch|open|show|view)_?/i, "")) === noun) : undefined)
      ?? (fts.length === 1 ? fts[0] : undefined);
  }
  /** The only entry point to the route: gate + budget + abort. */
  private async call(tool: McpTool, args: Record<string, unknown>, signal?: AbortSignal, budget?: CallBudget) {
    if (!allowedTool(tool, this.listed(), this.opts.openWorld)) throw new Error(`tool ${tool.name} refused`);
    return (budget ?? this.calls).call(this.server, `${tool.name}\n${JSON.stringify(args)}`, (sig) => this.route.call(tool.name, args, sig), signal);
  }
  async query(q: QueryInputs, signal?: AbortSignal): Promise<Item[]> {
    const nameOf = this.opts.agentName ?? ((tool: string) => mcpToolName(this.server, tool));
    const jobs: { t: McpTool; fetchT: McpTool | undefined; args: Record<string, unknown> }[] = [];
    for (const t of this.searchTools()) for (const text of q.text.slice(0, 2)) {
      const args: Record<string, unknown> = { [queryParam(t, true)!]: text };
      if (t.inputSchema?.properties?.limit) args.limit = this.opts.limit ?? 8;
      jobs.push({ t, fetchT: this.fetchTool(t), args });
    }
    const budget = q.budget; // v7: the researcher passes its own budget (the tool's per-prompt budget stays untouched)
    const results = await Promise.all(jobs.map(async (j) => { try { return await this.call(j.t, j.args, signal, budget); } catch { return null; } }));
    const out: Item[] = [];
    const seen = new Set<string>();
    jobs.forEach((j, ji) => {
      const r = results[ji];
      if (!r || r.isError) return;
      const { t, fetchT, args } = j;
      for (const it of parseItems(r)) {
        const rid = String(pick(it, ID_KEYS) ?? "");
        if (!rid) continue; // no id: the agent could not reach it
        const title = String(pick(it, ["title", "name", "subject", "summary", "label"]) ?? rid).replace(/\s+/g, " ").slice(0, 80);
        const isUrl = /^https?:\/\//.test(rid);
        if (isUrl && !safeUrl(rid)) continue;
        const id = isUrl ? `url:${rid}` : `mcp:${this.server}/${rid}`;
        if (seen.has(id) || q.isExcluded(id)) continue;
        const date = cleanDate(String(pick(it, ["date", "updated", "updated_at", "updatedAt", "modified", "created", "created_at", "createdAt", "sent", "timestamp", "ts"]) ?? "").slice(0, 10)); // pi-scout: only a real date
        const snippet = String(pick(it, ["snippet", "summary", "excerpt", "description", "body", "text", "content"]) ?? "").slice(0, 600);
        const fetchName = fetchT ? nameOf(fetchT.name) : null;
        const searchName = nameOf(t.name);
        let locator: Item["locator"] | null = null;
        // v6: web pages are pointed at through the agent's own fetch tool (no saved copy: the scout never writes)
        if (isUrl) locator = fetchT && fetchName && safeToolName(fetchName) && this.opts.agentCanCall?.(fetchName) && safeArgs({ [idParam(fetchT)!]: rid }) ? { type: "tool", tool: fetchName, args: { [idParam(fetchT)!]: rid } } : null;
        else if (fetchT && fetchName && safeToolName(fetchName) && this.opts.agentCanCall?.(fetchName) && safeArgs({ [idParam(fetchT)!]: rid })) locator = { type: "tool", tool: fetchName, args: { [idParam(fetchT)!]: rid } };
        else if (safeToolName(searchName) && this.opts.agentCanCall?.(searchName) && safeArgs(args)) locator = { type: "tool", tool: searchName, args };
        if (!locator) continue; // MCP items are never saved: unreachable by the agent = not proposed
        seen.add(id);
        out.push({ id, source: this.id, kind: isUrl ? "web" : "mcp", title, locator, external: isUrl || this.external, openWorld: isUrl || this.opts.openWorld === true, snippet: `${title}${date ? ` (${date})` : ""}\n${snippet}`, date,
          probes: [rid].filter((x) => x.length >= 4 || (x.length >= 3 && /\d/.test(x))), // the id only: a title in a listing is not "seen"
          fetch: fetchT ? async (sig) => { const fr = await this.call(fetchT, { [idParam(fetchT)!]: rid }, sig, budget); return (fr?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n"); } : undefined });
      }
    });
    return out;
  }
}
/** pi-scout: a date from an external item is kept only if it is a plain YYYY[-MM[-DD]] (it reaches the map text). */
export const cleanDate = (s: string | null | undefined): string | null => (s && /^(19|20)\d\d(-[01]\d(-[0-3]\d)?)?$/.test(s) ? s : null);
/**
 * pi-scout: an open-world source may receive queries that leave the user's machines and tools (web search…). It is one
 * whose server the user marked `openWorld: true` (the opt-in), or a web-kind source. Only the user's own prompt words
 * are ever sent to it (policy.ts taskWords / restrictToTaskWords).
 */
export const isOpenWorld = (s: { kind?: string; opts?: { openWorld?: boolean } } | any): boolean => s?.kind === "web" || s?.opts?.openWorld === true;
export function clientRoute(c: McpClient): McpRoute {
  return { kind: "client", tools: () => c.tools, call: (tool, args, signal) => c.callTool(tool, args, signal), connected: () => c.connected };
}
