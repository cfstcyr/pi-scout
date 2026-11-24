// Source "workspace": local files + git log through the v4 chunk index (BM25, optional dense). Ranked lists are fused
// per file with v4's round-robin. Items: "file:<path>" and "commit:<short>". Dates: file name / head lines / commit date.
import { type Hit, Index, isCodeFile } from "../index.ts";
import { fileDate } from "../meta.ts";
import { compact } from "../tracker.ts";
import type { Item, QueryInputs, Source } from "../types.ts";

export const fileId = (p: string) => (p.startsWith("commit:") ? p : `file:${p}`);
export const pathOf = (id: string) => (id.startsWith("file:") ? id.slice(5) : id);

export function hintOf(h: Hit): string | undefined {
  if (h.file.startsWith("commit:")) return undefined;
  if (h.chunk.sym && isCodeFile(h.file)) return `defines \`${compact(h.chunk.sym, 40)}\``;
  const head = (h.chunk.head || "").split(" > ").pop()?.trim();
  return head ? `section "${compact(head.replace(/["`\n]/g, ""), 50)}"` : undefined;
}
/**
 * Judge excerpt of a hit. v5: query-focused — the first line of the chunk (title / header) plus the window of lines
 * with the most query terms, instead of the chunk's first n characters (an email's decisive sentence is often below
 * its headers and quoted small talk).
 */
export function excerptOf(idx: Index, h: { file: string; chunk: { head: string; text: string } }, n = 600, qterms?: Set<string>) {
  if (h.file.startsWith("commit:")) { const c = idx.commits.get(h.file)!; return `commit ${c.short}: ${c.subject}${c.date ? ` (${c.date})` : ""}\n${c.body.slice(0, n)}\nchanged: ${c.files.slice(0, 5).join(", ")}`; }
  const head = h.chunk.head ? `section: ${h.chunk.head}\n` : "";
  return head + focused(h.chunk.text, n, qterms);
}
export function focused(text: string, n: number, qterms?: Set<string>): string {
  const flat = compact(text, 100000);
  if (!qterms?.size || flat.length <= n) return flat.slice(0, n);
  const lines = text.split("\n").map((l) => l.replace(/^[>\s]+/, "").trim()).filter(Boolean);
  const sc = lines.map((l) => new Set(termsOf(l).filter((w) => qterms.has(w))).size);
  let best = 0;
  for (let i = 0; i < lines.length; i++) { const s = sc[i] + (sc[i + 1] ?? 0) * 0.5; if (s > sc[best] + (sc[best + 1] ?? 0) * 0.5) best = i; }
  if (!sc[best]) return flat.slice(0, n);
  const first = compact(lines[0], 120);
  let out = "", i = Math.max(1, best - 1);
  while (i < lines.length && out.length < n - first.length - 6) { out += (out ? " " : "") + lines[i]; i++; }
  return `${first} … ${compact(out, n - first.length - 5)}`;
}

export class WorkspaceSource implements Source {
  id = "workspace"; kind = "file" as const; budgetMs = 2000;
  private dates = new Map<string, string | null>();
  constructor(public idx: () => Index | null, public opts: { candN: number; vecLimit?: number; embed?: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]> } = { candN: 15 }) {}
  describe() { return "local files and git history (BM25 chunk index)"; }
  available() { return !!this.idx(); }
  dateOf(file: string): string | null {
    const idx = this.idx()!;
    if (file.startsWith("commit:")) return idx.commits.get(file)?.date ?? null;
    if (this.dates.has(file)) return this.dates.get(file)!;
    const first = idx.chunks.find((c) => c.file === file);
    const d = fileDate(file, first ? `${first.head}\n${first.text}` : "");
    this.dates.set(file, d);
    return d;
  }
  toItem(h: Hit, excerptChars = 500, qterms?: Set<string>): Item {
    const idx = this.idx()!;
    const c = h.file.startsWith("commit:") ? idx.commits.get(h.file) : null;
    return {
      id: fileId(h.file), source: this.id, kind: c ? "commit" : "file",
      title: c ? `commit ${c.short} "${compact(c.subject, 70)}"` : h.file,
      locator: c ? { type: "commit", short: c.short, subject: c.subject } : { type: "file", path: h.file },
      snippet: excerptOf(idx, h, excerptChars, qterms), date: this.dateOf(h.file), hint: hintOf(h), ranks: h.ranks, score: h.fused,
      probes: c ? [c.short, c.hash.slice(0, 10)] : [h.file],
    };
  }
  async query(q: QueryInputs, signal?: AbortSignal): Promise<Item[]> {
    const idx = this.idx();
    if (!idx) return [];
    let vecs: Float32Array[] = [];
    const dense = q.text.length && this.opts.embed ? q.text : [];
    if (dense.length) { try { vecs = await this.opts.embed!(dense, signal); } catch {} }
    const hits = idx.search(dense.map((t, i) => ({ name: `d:${i}`, vec: vecs[i], w: 1 })).filter((x) => x.vec), q.lex, (f) => !q.isExcluded(fileId(f)), Math.max(q.limit, this.opts.candN), 60, "rr", this.opts.vecLimit ?? Infinity);
    const qterms = new Set(q.lex.flatMap((l) => l.terms));
    return hits.map((h) => this.toItem(h, 500, qterms));
  }
  /** Newer items on the same subject as `item` (supersession): BM25 with the item's own informative terms, dated later. */
  newerRelated(item: Item, isExcluded: (id: string) => boolean, k = 2): Item[] {
    const idx = this.idx();
    if (!idx || !item.date) return [];
    const maxDf = Math.max(3, 0.05 * idx.bm25.size); // subject words: rare in the corpus, but shared by a few documents
    const words = [...new Set(termsOf(`${item.title.replace(/[/._-]/g, " ")} ${item.snippet}`))].filter((w) => { const df = idx.bm25.df.get(w) ?? 0; return df >= 2 && df <= maxDf; }).slice(0, 24);
    if (words.length < 3) return [];
    const hits = idx.search([], [{ name: "lex:related", terms: words, w: 1 }], (f) => fileId(f) !== item.id && !isExcluded(fileId(f)), 40, 60, "rrf");
    const out: Item[] = [];
    for (const h of hits) {
      const d = this.dateOf(h.file);
      if (!d || d <= item.date!) continue;
      out.push(this.toItem(h));
      if (out.length >= k) break;
    }
    return out;
  }
}
import { terms as termsOf } from "../rank.ts";
