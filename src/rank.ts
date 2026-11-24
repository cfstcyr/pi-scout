// Pure ranking helpers for the scout (no pi imports, `bun test scout/rank.test.ts`).
// - terms(): tokenizer shared by the BM25 index, the first-stage ranking and the judge excerpts
//   (lowercase, accents folded, camelCase/snake_case split, light plural stemming, EN+FR stopwords).
// - Bm25: tiny in-memory index over file heads (cheap first stage before the cross-encoder).
// - pickDiverse(): top-k with a per-directory cap and reserved slots.
// - sectionOf(): Markdown heading that contains a given line (for specific nudge reasons).
// - relativeGate(): decision rule on a judged batch (top-1 vs batch median and null level).

const STOP = new Set((
  "the a an and or to of in on for with is are be it its this that these those i you we they can will should would could file files code use used using from by as at not no do does did if then else into out up any all just make sure let me now here there what which when where how have has had was were run add also fix dont don't write tests test new existing both may must only one two more most other such than so very via per our your their about after before over under same each every some get set like need needs want".split(" ")
).concat("le la les un une des du de et ou au aux en dans pour par sur avec est sont être ce cet cette ces il elle nous vous ils qui que quoi dont où ne pas plus moins se sa son ses leur leurs notre votre mais donc car si comme faire fait tout tous toute toutes très aussi".split(" ")));

export const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const stem = (w: string) => (w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);

/** Search terms of a text: folded, split on camelCase / snake / kebab / dots, stopwords removed, light stem. */
export function terms(text: string, minLen = 3): string[] {
  const out: string[] = [];
  const t = fold(text.slice(0, 200000)).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase();
  for (const w of t.match(/[a-z0-9]+/g) ?? []) {
    if (w.length < minLen || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}
export const termSet = (text: string) => new Set(terms(text));

/** BM25 over short documents (file heads). Documents are added once; scoring is a dot product over query terms. */
export class Bm25 {
  docs = new Map<string, { tf: Map<string, number>; len: number }>();
  df = new Map<string, number>();
  totalLen = 0;
  constructor(public k1 = 1.2, public b = 0.75) {}
  add(id: string, text: string) {
    if (this.docs.has(id)) this.remove(id);
    const tf = new Map<string, number>();
    const ts = terms(text);
    for (const w of ts) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of tf.keys()) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    this.docs.set(id, { tf, len: ts.length });
    this.totalLen += ts.length;
  }
  remove(id: string) {
    const d = this.docs.get(id);
    if (!d) return;
    for (const w of d.tf.keys()) this.df.set(w, (this.df.get(w) ?? 1) - 1);
    this.totalLen -= d.len;
    this.docs.delete(id);
  }
  get size() { return this.docs.size; }
  idf(w: string) { const n = this.df.get(w) ?? 0; return Math.log(1 + (this.docs.size - n + 0.5) / (n + 0.5)); }
  /** Fraction of documents that contain the term. */
  dfFrac(w: string) { return this.docs.size ? (this.df.get(w) ?? 0) / this.docs.size : 0; }
  score(id: string, q: Iterable<string>, weights?: Map<string, number>): number {
    const d = this.docs.get(id);
    if (!d) return 0;
    const avg = this.totalLen / Math.max(1, this.docs.size);
    let s = 0;
    for (const w of new Set(q)) {
      const f = d.tf.get(w);
      if (!f) continue;
      s += (weights?.get(w) ?? 1) * this.idf(w) * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.len / Math.max(1, avg)));
    }
    return s;
  }
  /** Top documents for a query, optionally restricted by a filter. */
  top(q: Iterable<string>, k: number, filter?: (id: string) => boolean, weights?: Map<string, number>): { id: string; score: number }[] {
    const qs = [...new Set(q)];
    const res: { id: string; score: number }[] = [];
    for (const id of this.docs.keys()) {
      if (filter && !filter(id)) continue;
      const s = this.score(id, qs, weights);
      if (s > 0) res.push({ id, score: s });
    }
    return res.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1)).slice(0, k);
  }
  /** Query terms that matter: present in the index and not in more than maxFrac of documents. */
  informative(q: Iterable<string>, maxFrac = 0.25): string[] {
    return [...new Set(q)].filter((w) => (this.df.get(w) ?? 0) > 0 && this.dfFrac(w) <= maxFrac);
  }
}

export const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Top-k by score with at most `perDir` items per directory and `reserve` slots for items where `special` is true. */
export function pickDiverse<T>(items: T[], k: number, opts: { dir: (t: T) => string; perDir: number; special?: (t: T) => boolean; reserve?: number }): T[] {
  const out: T[] = [];
  const perDir = new Map<string, number>();
  const take = (t: T) => { out.push(t); const d = opts.dir(t); perDir.set(d, (perDir.get(d) ?? 0) + 1); };
  const ok = (t: T) => !out.includes(t) && (perDir.get(opts.dir(t)) ?? 0) < opts.perDir;
  if (opts.special && opts.reserve) for (const t of items) { if (out.length >= Math.min(k, opts.reserve)) break; if (opts.special(t) && ok(t)) take(t); }
  for (const t of items) { if (out.length >= k) break; if (ok(t)) take(t); }
  for (const t of items) { if (out.length >= k) break; if (!out.includes(t)) take(t); } // relax the cap if slots remain
  const pos = new Map(items.map((t, i) => [t, i]));
  return out.sort((a, b) => pos.get(a)! - pos.get(b)!);
}

/** Markdown/RST heading text of the section that contains line index `i` (0-based), or the document title. */
export function sectionOf(lines: string[], i: number): string | null {
  for (let j = Math.min(i, lines.length - 1); j >= 0; j--) {
    const m = lines[j].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) return m[1].trim();
    if (j > 0 && /^\s*(=+|-+)\s*$/.test(lines[j]) && lines[j - 1].trim() && j - 1 !== i) return lines[j - 1].trim();
  }
  return null;
}

/** Frontmatter title or first heading. */
export function titleOf(lines: string[]): string | null {
  if (lines[0]?.trim() === "---") {
    for (let j = 1; j < Math.min(lines.length, 40) && lines[j].trim() !== "---"; j++) {
      const m = lines[j].match(/^title\s*:\s*["']?(.+?)["']?\s*$/i);
      if (m) return m[1];
    }
  }
  for (const l of lines.slice(0, 80)) { const m = l.match(/^\s{0,3}#\s+(.+?)\s*$/); if (m) return m[1]; }
  return null;
}

/** Index of the line with the highest weighted overlap with the query terms (ties: earliest), or -1. */
export function bestLine(lines: string[], q: Set<string>, weight: (w: string) => number = () => 1, from = 0): number {
  let best = -1, bs = 0;
  for (let i = from; i < Math.min(lines.length, 2000); i++) {
    let s = 0;
    for (const w of new Set(terms(lines[i]))) if (q.has(w)) s += weight(w);
    if (s > bs) { bs = s; best = i; }
  }
  return best;
}

export type Gate = { ok: boolean; reason: string; margin: number; gap: number; rel: number | null };
/**
 * Relative decision for one candidate of a judged batch (logit units):
 *   margin = score − null (null = mean score of content-free documents),
 *   gap    = score − median(scores of the other candidates) when ≥ minBatch candidates were judged, else = margin
 *            (a small batch has no meaningful median: the candidate must then be ahead of the null level by minGap),
 *   rel    = margin / (ref − null) (ref = a file the agent already read), checked for small batches only.
 */
export function relativeGate(score: number, others: number[], nul: number, ref: number | null,
  cfg: { minMargin: number; minGap: number; minRel: number; minBatch: number }): Gate {
  const margin = score - nul;
  const big = others.length + 1 >= cfg.minBatch;
  const gap = big ? score - median(others) : margin;
  const rel = ref !== null ? margin / Math.max(0.25, ref - nul) : null;
  if (margin < cfg.minMargin) return { ok: false, reason: "below null margin", margin, gap, rel };
  if (gap < cfg.minGap) return { ok: false, reason: big ? "not ahead of the batch" : "small batch: not ahead of null", margin, gap, rel };
  if (!big && rel !== null && rel < cfg.minRel) return { ok: false, reason: "below reference", margin, gap, rel };
  return { ok: true, reason: "ok", margin, gap, rel };
}
