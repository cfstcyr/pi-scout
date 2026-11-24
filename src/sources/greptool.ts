// Source "grep:<tool>": any grep-like tool as a local retrieval source — pi's built-in grep called directly
// (createGrepTool(cwd).execute(), works from event handlers and at prompt time) or another extension's search tool such
// as @ff-labs/pi-fff's `ffgrep`, called through a captured tool context (ctx.executeTool). One call per keyword query;
// output lines "path:12: text" (pi grep, rg) or "path\n 12: text" (ffgrep) become file items with the matched lines as
// the judge-only snippet. Ranked by number of distinct queries that hit the file, then by hit count.
import type { Item, QueryInputs, Source } from "../types.ts";
import { isSecretPath } from "../secrets.ts";

export type GrepRun = (pattern: string, signal?: AbortSignal) => Promise<string>;
export function parseGrep(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    let m = line.match(/^([^\s:][^:]*?):(\d+)[:-]\s?(.*)$/);
    if (m) { const f = m[1]; if (!out.has(f)) out.set(f, []); out.get(f)!.push(m[3]); cur = null; continue; }
    m = line.match(/^\s+(\d+)[:-]\s?(.*)$/);
    if (m && cur) { out.get(cur)!.push(m[2]); continue; }
    if (/^[^\s].*\.[A-Za-z0-9]{1,6}$/.test(line.trim()) && !line.includes(" ")) { cur = line.trim(); if (!out.has(cur)) out.set(cur, []); }
  }
  return out;
}
export class GrepToolSource implements Source {
  kind = "file" as const;
  constructor(public id: string, public run: GrepRun, public isAvailable: () => boolean, public budgetMs = 1500) {}
  describe() { return `grep-like tool ${this.id}`; }
  available() { return this.isAvailable(); }
  async query(q: QueryInputs, signal?: AbortSignal): Promise<Item[]> {
    const score = new Map<string, { qs: number; hits: string[] }>();
    // one regex alternation per keyword query: rare terms of the task first
    const pats = q.text.slice(0, 3).map((t) => t.split(/\s+/).filter((w) => w.length >= 4).slice(0, 6).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")).filter(Boolean);
    for (const p of pats) {
      if (signal?.aborted) break;
      let text = "";
      try { text = await this.run(p, signal); } catch { continue; }
      for (const [f, lines] of parseGrep(text)) {
        if (isSecretPath(f) || q.isExcluded(`file:${f}`)) continue;
        const s = score.get(f) ?? { qs: 0, hits: [] };
        s.qs++; s.hits.push(...lines.slice(0, 4)); score.set(f, s);
      }
    }
    return [...score].sort((a, b) => b[1].qs - a[1].qs || b[1].hits.length - a[1].hits.length).slice(0, q.limit)
      .map(([f, s]) => ({ id: `file:${f}`, source: this.id, kind: "file" as const, title: f, locator: { type: "file" as const, path: f }, snippet: s.hits.slice(0, 6).join("\n").slice(0, 600), probes: [f] }));
  }
}
