// Scout v7b: copies and versions of one document (RULES-v7.md › v7b rules §2). Two items are copies when
//   (a) both are files with the same normalised stem (copy / version markers removed, ≥ 3 characters left) and they sit in
//       the same directory or one of the names carries a marker; or
//   (b) their texts (first 4,000 characters) have 5-word-shingle Jaccard ≥ 0.8 (both ≥ 40 words).
// A group is shown once, as its newest copy: latest date, highest version, name without markers, shortest path.
// Constants are fixed a priori (not tuned on outcomes). No pi imports.
import type { Index } from "./index.ts";
import { fold } from "./rank.ts";
import type { Item } from "./types.ts";

export const DEDUP_CFG = { version: "dedup-v1", minStem: 3, textChars: 4000, shingle: 5, minWords: 40, jaccard: 0.8 };

export type StemInfo = { stem: string; ver: number; marked: boolean; dir: string };
const SEP = "(?:^|[\\s_.\\-])";
const END = "(?=$|[\\s_.\\-])";
export function stemInfo(file: string): StemInfo {
  const parts = file.split("/");
  const base = parts.pop() ?? "";
  let s = fold(base.replace(/\.[A-Za-z0-9]{1,5}$/, "")).toLowerCase();
  let marked = false, ver = 0;
  const mark = () => { marked = true; return " "; };
  s = s.replace(/\.?sync-conflict-[\w-]*/g, mark);
  s = s.replace(/\(\s*conflicted copy[^)]*\)/g, mark).replace(/conflicted copy.*$/g, mark);
  s = s.replace(/\(\s*\d+\s*\)/g, mark);
  s = s.replace(/\b(copy of|copie de)\b/g, mark);
  s = s.replace(new RegExp(`${SEP}(?:v|version|rev)\\s*[-_.]?\\s*(\\d+)(?:[._]\\d+)*${END}`, "g"), (_m, n) => { marked = true; ver = Math.max(ver, Number(n)); return " "; });
  s = s.replace(new RegExp(`${SEP}(?:copy|copie|final|finale|def|definitif|definitive|old|backup|bak|orig|original)${END}`, "g"), mark);
  s = s.replace(new RegExp(`${SEP}(?:copy|copie|final|finale|def|definitif|definitive|old|backup|bak|orig|original)${END}`, "g"), mark); // adjacent markers
  s = s.replace(/[\s_.\-]+/g, " ").trim();
  return { stem: s, ver, marked, dir: parts.join("/") };
}
const stemsAreCopies = (a: StemInfo, b: StemInfo) => a.stem.length >= DEDUP_CFG.minStem && a.stem === b.stem && (a.dir === b.dir || a.marked || b.marked);

/** Newest-copy order: latest date, then highest version, then the name without markers, then shortest / first path. */
export function copyOrder(a: { id: string; date?: string | null }, b: { id: string; date?: string | null }): number {
  const da = a.date ?? "", db = b.date ?? "";
  if (da !== db) return db.localeCompare(da);
  const sa = a.id.startsWith("file:") ? stemInfo(a.id.slice(5)) : null, sb = b.id.startsWith("file:") ? stemInfo(b.id.slice(5)) : null;
  if (sa && sb) { if (sa.ver !== sb.ver) return sb.ver - sa.ver; if (sa.marked !== sb.marked) return sa.marked ? 1 : -1; }
  return a.id.length - b.id.length || (a.id < b.id ? -1 : 1);
}

// ---------------- folder-wide stem groups (cached per index) ----------------
const stemCache = new WeakMap<Index, Map<string, string[]>>();
function stemBuckets(idx: Index): Map<string, string[]> {
  let m = stemCache.get(idx);
  if (m) return m;
  m = new Map();
  for (const f of idx.files) { const s = stemInfo(f); if (s.stem.length < DEDUP_CFG.minStem) continue; if (!m.has(s.stem)) m.set(s.stem, []); m.get(s.stem)!.push(f); }
  stemCache.set(idx, m);
  return m;
}
/** Every file of the folder that is a stem copy of `file` (itself included). */
export function folderCopies(idx: Index, file: string): string[] {
  const s = stemInfo(file);
  if (s.stem.length < DEDUP_CFG.minStem) return [file];
  const bucket = stemBuckets(idx).get(s.stem) ?? [file];
  const out = bucket.filter((f) => f === file || stemsAreCopies(s, stemInfo(f)));
  return out.includes(file) ? out : [file, ...out];
}

// ---------------- text overlap ----------------
const textCache = new WeakMap<Index, Map<string, Set<string> | null>>();
const chunkCache = new WeakMap<Index, Map<string, number[]>>();
function shinglesOf(text: string): Set<string> | null {
  const w = fold(text.slice(0, DEDUP_CFG.textChars)).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (w.length < DEDUP_CFG.minWords) return null;
  const s = new Set<string>();
  for (let i = 0; i + DEDUP_CFG.shingle <= w.length; i++) s.add(w.slice(i, i + DEDUP_CFG.shingle).join(" "));
  return s;
}
export function itemShingles(idx: Index | null, it: Item): Set<string> | null {
  if (it.locator.type === "file" && idx) {
    let m = textCache.get(idx);
    if (!m) textCache.set(idx, m = new Map());
    if (m.has(it.id)) return m.get(it.id)!;
    const file = it.locator.path;
    let byFile = chunkCache.get(idx);
    if (!byFile) { byFile = new Map(); for (const c of idx.chunks) { if (!byFile.has(c.file)) byFile.set(c.file, []); byFile.get(c.file)!.push(c.id); } chunkCache.set(idx, byFile); }
    let text = "";
    for (const id of byFile.get(file) ?? []) { text += `${idx.chunks[id].text}\n`; if (text.length >= DEDUP_CFG.textChars) break; }
    const s = shinglesOf(text);
    m.set(it.id, s);
    return s;
  }
  if (it.kind === "commit") return null;
  return shinglesOf(it.snippet ?? "");
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  const [x, y] = a.size < b.size ? [a, b] : [b, a];
  for (const s of x) if (y.has(s)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/**
 * Groups items that are copies of each other (stem rule or text overlap). Returns, for each input index, the index of
 * its group's representative among the inputs, plus group sizes. `extraFor(i)` may add folder copies (already items).
 */
export function copyGroups(idx: Index | null, items: Item[]): { rep: number[]; size: number[] } {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const uni = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const st = items.map((it) => (it.locator.type === "file" ? stemInfo(it.locator.path) : null));
  const sh = items.map((it) => itemShingles(idx, it));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (find(i) === find(j)) continue;
    if (st[i] && st[j] && stemsAreCopies(st[i]!, st[j]!)) { uni(i, j); continue; }
    if (sh[i] && sh[j] && jaccard(sh[i]!, sh[j]!) >= DEDUP_CFG.jaccard) uni(i, j);
  }
  const groups = new Map<number, number[]>();
  items.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(i); });
  const rep = items.map(() => 0), size = items.map(() => 1);
  for (const g of groups.values()) {
    const best = [...g].sort((a, b) => copyOrder(items[a], items[b]))[0];
    for (const i of g) { rep[i] = best; size[i] = g.length; }
  }
  return { rep, size };
}

/** The newest folder copy of a file (by stem), or null when the file is its own newest copy. */
export function newestFolderCopy(idx: Index, file: string, dateOf: (f: string) => string | null, excluded: (id: string) => boolean): { file: string; n: number } | null {
  const cs = folderCopies(idx, file).filter((f) => f === file || !excluded(`file:${f}`));
  if (cs.length < 2) return null;
  const best = cs.map((f) => ({ id: `file:${f}`, date: dateOf(f) })).sort(copyOrder)[0].id.slice(5);
  return { file: best, n: cs.length };
}
