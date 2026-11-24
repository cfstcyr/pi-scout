// Workspace index (scout v4, from scout-alt): chunks (prose sections, code windows, git commits), chunk-level BM25 and a
// background dense index (llama.cpp /v1/embeddings). No pi imports: used by the extension and the offline evaluator.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Bm25, terms } from "./rank.ts";
import { isSecretPath } from "./secrets.ts";

export type Kind = "prose" | "code" | "data" | "commit";
export type Chunk = { id: number; file: string; kind: Kind; head: string; text: string; line: number; sym?: string };
export type Commit = { hash: string; short: string; subject: string; body: string; files: string[]; date?: string };

const PROSE_RE = /\.(md|mdx|markdown|rst|txt|adoc|org)$/i;
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|sh|sql|vue|svelte)$/i;
const SKIP_RE = /(^|\/)(node_modules|\.git|\.scout|dist|build|\.venv|__pycache__)\/|(^|\/)(package-lock\.json|[^/]*\.lock|LICENSE[^/]*)$|\.(png|jpe?g|gif|webp|pdf|zip|gz|ico|woff2?|ttf|gguf|bin)$/i;
export const isProse = (p: string) => PROSE_RE.test(p);
export const isCodeFile = (p: string) => CODE_RE.test(p);
export const kindOf = (p: string): Kind => (p.startsWith("commit:") ? "commit" : PROSE_RE.test(p) ? "prose" : CODE_RE.test(p) ? "code" : "data");

/** Embedding model profiles: query/document prefixes. */
export const EMBED_PROFILES: Record<string, { q: string; d: (title: string) => string }> = {
  "embeddinggemma-300M-Q8_0": { q: "task: search result | query: ", d: (t) => `title: ${t || "none"} | text: ` },
  "multilingual-e5-small-q8_0": { q: "query: ", d: () => "passage: " },
  "granite-embedding-97M-multilingual-r2-Q8_0": { q: "", d: () => "" },
  "bge-small-en-v1.5-q8_0": { q: "Represent this sentence for searching relevant passages: ", d: () => "" },
  "nomic-embed-text-v1.5.Q8_0": { q: "search_query: ", d: () => "search_document: " },
};

const MAX_CHARS = 1400;

function chunkProse(file: string, lines: string[]): Omit<Chunk, "id">[] {
  const out: Omit<Chunk, "id">[] = [];
  let title = "";
  let fm = 0;
  if (lines[0]?.trim() === "---") { for (fm = 1; fm < Math.min(lines.length, 60) && lines[fm].trim() !== "---"; fm++) { const m = lines[fm].match(/^title\s*:\s*["']?(.+?)["']?\s*$/i); if (m) title = m[1]; } fm++; }
  let head = "", buf: string[] = [], start = fm;
  const flush = (i: number) => {
    const body = buf.join("\n").trim();
    if (body) {
      // long sections: split on blank lines into ≤ MAX_CHARS pieces
      let piece: string[] = [], len = 0, pStart = start;
      const emit = () => { const t = piece.join("\n").trim(); if (t) out.push({ file, kind: "prose", head: [title, head].filter(Boolean).join(" > "), text: t, line: pStart + 1 }); piece = []; len = 0; };
      buf.forEach((l, k) => { if (len + l.length > MAX_CHARS && piece.length) { emit(); pStart = start + k; } piece.push(l); len += l.length + 1; });
      emit();
    }
    buf = []; start = i;
  };
  for (let i = fm; i < lines.length; i++) {
    const m = lines[i].match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (m) { flush(i); if (m[1].length === 1 && !title) title = m[2]; head = m[2]; }
    buf.push(lines[i]);
  }
  flush(lines.length);
  // frontmatter goes with the first chunk (tags, people, dates matter for notes)
  if (fm > 0 && out.length) out[0].text = lines.slice(1, fm - 1).join("\n") + "\n" + out[0].text;
  return out;
}
function chunkCode(file: string, lines: string[], kind: Kind): Omit<Chunk, "id">[] {
  const out: Omit<Chunk, "id">[] = [];
  // v5: data files are windowed over their whole length (v4 indexed only the first 30 lines, so a fact on line 40 of a
  // CSV was never searchable); each later window repeats the header line so the judge sees the column names.
  const win = kind === "data" ? 30 : 50, step = kind === "data" ? 30 : 40, maxWin = kind === "data" ? 24 : 8;
  const header = kind === "data" ? (lines[0] ?? "").slice(0, 300) : "";
  for (let s = 0; s < lines.length && out.length < maxWin; s += step) {
    const body = lines.slice(s, s + win).join("\n");
    const t = (s > 0 && header ? `${header}\n${body}` : body).trim().slice(0, MAX_CHARS);
    const sym = kind === "code" ? t.match(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class|def|interface|type|enum|const|struct|func|fn)\s+\*?([A-Za-z_$][\w$]{2,60})/)?.[1] : undefined;
    if (t) out.push({ file, kind, head: "", text: t, line: s + 1, sym });
    if (s + win >= lines.length) break;
  }
  return out;
}

export function listFiles(cwd: string): string[] {
  const git = spawnSync("git", ["-c", "core.quotepath=off", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8", maxBuffer: 20e6 });
  let files: string[] = git.status === 0 ? git.stdout.split("\n").filter(Boolean) : [];
  if (!files.length) {
    const walk = (d: string, acc: string[]) => { for (const e of fs.readdirSync(path.join(cwd, d), { withFileTypes: true })) { const r = d ? `${d}/${e.name}` : e.name; if (SKIP_RE.test(r + (e.isDirectory() ? "/" : ""))) continue; if (e.isDirectory()) { if (acc.length < 20000) walk(r, acc); } else acc.push(r); } return acc; };
    files = walk("", []);
  }
  return files.filter((f) => !SKIP_RE.test(f) && !isSecretPath(f)).sort();
}
export function loadCommits(cwd: string, max = 400): Commit[] {
  if (!fs.existsSync(path.join(cwd, ".git"))) return [];
  const r = spawnSync("git", ["-c", "core.quotepath=off", "log", "-n", String(max), "--name-only", "--format=%x1e%H%x1f%h%x1f%s%x1f%b%x1f%cI%x1f"], { cwd, encoding: "utf8", maxBuffer: 50e6 });
  const res: Commit[] = [];
  for (const rec of (r.stdout || "").split("\x1e")) {
    const f = rec.split("\x1f");
    if (f.length < 6) continue;
    res.push({ hash: f[0].trim(), short: f[1].trim(), subject: f[2].trim(), body: f[3].trim(), date: f[4].trim().slice(0, 10), files: f[5].split("\n").map((x) => x.trim()).filter(Boolean) });
  }
  return res;
}

export type Hit = { file: string; chunk: Chunk; dense: number; bm25: number; fused: number; ranks: Record<string, number> };

export class Index {
  chunks: Chunk[] = [];
  files: string[] = [];
  sizes = new Map<string, number>();
  commits = new Map<string, Commit>(); // "commit:<short>" -> commit
  bm25 = new Bm25();
  vecs: (Float32Array | null)[] = [];
  embedded = 0;
  embedMs = 0;
  buildMs = 0;
  constructor(public cwd: string, public opts: { maxFileBytes?: number; maxChunks?: number; commits?: number } = {}) {}

  truncated = { chunks: 0, files: new Set<string>() };
  /** Synchronous build (tests, replay). */
  build() { const it = this.steps(); while (!it.next().done); return this; }
  /**
   * Same build, time-sliced: yields to the event loop every `sliceMs` so a large folder (thousands of notes) never
   * blocks pi for more than a slice. Only `git ls-files` / `git log` run synchronously (tens of ms).
   */
  async buildAsync(sliceMs = 12) {
    const it = this.steps();
    for (;;) {
      const t = Date.now();
      let done = false;
      while (Date.now() - t < sliceMs) { if (it.next().done) { done = true; break; } }
      this.maxSliceMs = Math.max(this.maxSliceMs, Date.now() - t);
      if (done) return this;
      await new Promise((r) => setImmediate(r));
    }
  }
  maxSliceMs = 0;
  private *steps(): Generator<void, void, void> {
    const t0 = Date.now();
    let paused = 0;
    this.files = listFiles(this.cwd);
    yield;
    const max = this.opts.maxChunks ?? 60000;
    const add = (c: Omit<Chunk, "id">) => {
      if (this.chunks.length >= max) { this.truncated.chunks++; this.truncated.files.add(c.file); return; }
      const ch = { ...c, id: this.chunks.length }; this.chunks.push(ch); this.bm25.add(String(ch.id), `${ch.file.replace(/[/._-]/g, " ")} ${ch.head} ${ch.text}`);
    };
    // prose first (notes are the main target), then commits, data, code; within a kind newest first (by mtime), so a
    // truncated index (> maxChunks, logged) and a partly built dense index keep the most recent notes
    const order = (f: string) => ({ prose: 0, commit: 1, data: 2, code: 3 })[kindOf(f)];
    const mtime = new Map<string, number>();
    let n = 0;
    for (const f of this.files) {
      try { const st = fs.statSync(path.join(this.cwd, f)); if (st.isFile()) { this.sizes.set(f, st.size); mtime.set(f, st.mtimeMs); } } catch {}
      if (++n % 200 === 0) yield;
    }
    const files = this.files.filter((f) => mtime.has(f)).sort((a, b) => order(a) - order(b) || mtime.get(b)! - mtime.get(a)! || (a < b ? -1 : 1));
    const pending: Omit<Chunk, "id">[][] = [[], [], [], []];
    for (const f of files) {
      const size = this.sizes.get(f)!;
      if (size > (this.opts.maxFileBytes ?? 200_000) || size < 20) continue;
      let s = ""; try { s = fs.readFileSync(path.join(this.cwd, f), "utf8"); } catch { continue; }
      if (s.includes("\u0000")) continue;
      const lines = s.split("\n");
      const k = kindOf(f);
      pending[order(f)].push(...(k === "prose" ? chunkProse(f, lines) : chunkCode(f, lines, k)));
      if (++n % 25 === 0) yield;
    }
    for (const c of loadCommits(this.cwd, this.opts.commits ?? 400)) {
      if (c.files.length > 40) continue;
      const id = `commit:${c.short}`;
      this.commits.set(id, c);
      pending[1].push({ file: id, kind: "commit", head: c.subject, text: `${c.subject}\n${c.body}\nchanged: ${c.files.slice(0, 8).join(", ")}`.slice(0, MAX_CHARS), line: 0 });
    }
    yield;
    for (const g of pending) for (const c of g) { add(c); if (++n % 100 === 0) yield; }
    this.vecs = new Array(this.chunks.length).fill(null);
    this.buildMs = Date.now() - t0 - paused;
  }

  /** Embed all chunks in build order (prose, commits, data, code), in batches. Resumable; stops on abort. */
  async embedAll(embedUrl: string, model: string, signal?: AbortSignal, batch = 16, onProgress?: (n: number) => void) {
    const prof = EMBED_PROFILES[model] ?? { q: "", d: () => "" };
    const t0 = Date.now();
    for (let i = 0; i < this.chunks.length; i += batch) {
      if (signal?.aborted) break;
      const idx = this.chunks.slice(i, i + batch).map((c) => c.id).filter((id) => !this.vecs[id]);
      if (!idx.length) continue;
      const input = idx.map((id) => { const c = this.chunks[id]; return `${prof.d(c.head || c.file)}${c.file}${c.head ? ` — ${c.head}` : ""}\n${c.text}`.slice(0, 1800); });
      let vs: Float32Array[];
      try { vs = await embed(embedUrl, input, signal); }
      catch (e) { // over the model's context: embed one by one, shrinking until it fits
        if (!/exceed_context|larger than the max context/.test(String(e))) throw e;
        vs = [];
        for (let t of input) { for (;;) { try { vs.push((await embed(embedUrl, [t], signal))[0]); break; } catch (e2) { if (!/exceed_context|larger than/.test(String(e2)) || t.length < 200) throw e2; t = t.slice(0, Math.floor(t.length * 0.7)); } } }
      }
      idx.forEach((id, k) => { this.vecs[id] = vs[k]; });
      this.embedded += idx.length;
      onProgress?.(this.embedded);
    }
    this.embedMs += Date.now() - t0;
  }

  /**
   * Hybrid search. dense: query vectors (already embedded with the query prefix), each its own ranked list;
   * lex: BM25 term lists, each its own ranked list. Lists are fused per FILE with reciprocal rank fusion.
   */
  /** vecLimit: only chunks with id < vecLimit have a usable vector (replay: models a cold index filling up in build order). */
  search(dense: { name: string; vec: Float32Array; w?: number }[], lex: { name: string; terms: string[]; w?: number }[], filter: (file: string) => boolean, k = 20, K = 60, fusion: "rrf" | "rr" = "rrf", vecLimit = Infinity): Hit[] {
    const per = new Map<string, Hit>();
    const lists: { name: string; w: number; ranked: { file: string; chunk: Chunk; s: number }[] }[] = [];
    const fileBest = (scored: { c: Chunk; s: number }[]) => {
      const best = new Map<string, { file: string; chunk: Chunk; s: number }>();
      for (const x of scored) { if (!filter(x.c.file)) continue; const b = best.get(x.c.file); if (!b || x.s > b.s) best.set(x.c.file, { file: x.c.file, chunk: x.c, s: x.s }); }
      return [...best.values()].sort((a, b) => b.s - a.s).slice(0, 200);
    };
    for (const d of dense) {
      const scored: { c: Chunk; s: number }[] = [];
      for (const c of this.chunks) { if (c.id >= vecLimit) break; const v = this.vecs[c.id]; if (v) scored.push({ c, s: dot(v, d.vec) }); }
      lists.push({ name: d.name, w: d.w ?? 1, ranked: fileBest(scored) });
    }
    for (const l of lex) {
      if (!l.terms.length) continue;
      const scored = this.bm25.top(l.terms, 400).map((x) => ({ c: this.chunks[Number(x.id)], s: x.score }));
      lists.push({ name: l.name, w: l.w ?? 1, ranked: fileBest(scored) });
    }
    for (const l of lists) l.ranked.forEach((x, r) => {
      let h = per.get(x.file);
      if (!h) per.set(x.file, h = { file: x.file, chunk: x.chunk, dense: -1, bm25: 0, fused: 0, ranks: {} });
      h.fused += l.w / (K + r + 1);
      h.ranks[l.name] = r + 1;
      if (l.name.startsWith("lex")) h.bm25 = Math.max(h.bm25, x.s);
      else if (x.s > h.dense) { h.dense = x.s; h.chunk = x.chunk; }
    });
    const byFused = [...per.values()].sort((a, b) => b.fused - a.fused || (a.file < b.file ? -1 : 1));
    if (fusion === "rrf") return byFused.slice(0, k);
    // round-robin: rank r of every list before rank r+1 of any list (each list's top picks reach the judge);
    // ties within a round by fused score
    const out: Hit[] = [];
    const taken = new Set<string>();
    for (let r = 0; out.length < k && r < 200; r++) {
      const round = lists.map((l) => l.ranked[r]?.file).filter((f): f is string => !!f && !taken.has(f));
      for (const f of [...new Set(round)].sort((a, b) => per.get(b)!.fused - per.get(a)!.fused)) { if (out.length >= k) break; out.push(per.get(f)!); taken.add(f); }
    }
    return out;
  }
  informative(ts: string[], maxFrac = 0.2) { return this.bm25.informative(ts, maxFrac); }
}

export const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (v: number[]) => { let s = 0; for (const x of v) s += x * x; const n = Math.sqrt(s) || 1; return Float32Array.from(v, (x) => x / n); };

export async function embed(url: string, input: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const r = await fetch(`${url}/v1/embeddings`, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ input, encoding_format: "float" }) });
  if (!r.ok) throw new Error(`embeddings HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const out: Float32Array[] = new Array(input.length);
  for (const d of j.data) out[d.index] = norm(d.embedding);
  return out;
}
export async function embedQueries(url: string, model: string, qs: string[], signal?: AbortSignal) {
  const p = EMBED_PROFILES[model]?.q ?? "";
  return qs.length ? embed(url, qs.map((q) => p + q.slice(0, 1000)), signal) : [];
}
export { terms };
