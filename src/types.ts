// Scout v5 core types: sources are adapters over existing retrieval (files, git, MCP tools, web search, any pi tool).

/** What a source returns. `id` is global and stable (seen-tracking key); `locator` tells the agent how to reach it. */
export type Item = {
  id: string; // "file:<path>" | "commit:<short>" | "mcp:<server>/<id>" | "url:<url>" | "tool:<name>:<id>"
  source: string; // source id that produced it
  kind: "file" | "commit" | "mcp" | "web" | "tool";
  title: string; // short identifier for the pointer (path, commit subject, item title) — never content
  locator: Locator;
  snippet: string; // judge-only excerpt (never sent to the agent)
  date?: string | null; // YYYY-MM-DD / YYYY-MM when known (staleness)
  probes?: string[]; // strings whose appearance in an agent tool result means the agent saw this item
  hint?: string; // section heading / symbol for file pointers
  ranks?: Record<string, number>; // per-list ranks (diagnostics)
  score?: number;
  /** Source-specific fetch, used only when the pointer needs a saved copy (web pages, MCP items the agent can't reach). */
  fetch?: (signal?: AbortSignal) => Promise<string>;
  /** Externally writable source (web, e-mail, chat, or any MCP server not marked `external: false`): at most one pointer
   *  per task, and never an authority by date alone (judge prompt). */
  external?: boolean;
  /** 0.2: from an open-world source (web page, or a server the user marked openWorld): public, anyone can write it. The
   *  map's external cap and "never demotes an internal document" rule apply to these items. */
  openWorld?: boolean;
};
export type Locator =
  | { type: "file"; path: string }
  | { type: "commit"; short: string; subject: string }
  | { type: "tool"; tool: string; args: Record<string, unknown> } // "tool X with args {...} returns <title>"
  | { type: "saved"; path: string; url?: string }; // page saved under .scout/ (web, unreachable MCP item)

/** Inputs a check gives every source; each source uses what it understands. */
export type QueryInputs = {
  task: string; intent: string;
  lex: { name: string; terms: string[]; w: number }[]; // term lists (BM25-like sources)
  text: string[]; // short natural-language / keyword queries (MCP search tools, web search, grep-like tools)
  isExcluded: (id: string) => boolean; // seen / nudged / filtered
  limit: number;
  /** v7: call budget for this query (the researcher's own); default: the source's session budget. */
  budget?: import("./sources/budget.ts").CallBudget;
};

export interface Source {
  id: string;
  kind: Item["kind"];
  /** One line for logs and for the judge's source label. */
  describe(): string;
  /** Cheap availability probe (index built, server connected, tool registered…). */
  available(): boolean;
  query(inputs: QueryInputs, signal?: AbortSignal): Promise<Item[]>;
  /** Per-source time budget (ms); a source that overruns is cut off for this check. */
  budgetMs: number;
}
