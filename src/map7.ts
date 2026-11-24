// Scout v7 tool-time map (RETRIEVAL.md §1). What the `scout` tool returns for one call: the researcher's ledger
// (research.ts) interleaved with a fresh plain search of the agent's own query (its top hits are always shown: MAP.md's
// diagnosis of map-v1), as ≤ max locators with dates, source, opened / not opened, a kind label for ledger entries, and
// "older than / newer than" links. No item content, no title of an externally written item. No pi imports.
// pi-scout changes (CHANGES.md): ≤ maxExternal externally written items per map; an external item is never the "newer"
// head that demotes an internal document; open-world sources get only the words of the user's prompt; every field of
// the map text is sanitised (dates validated, source labels cleaned); abstention: with an empty ledger the plain lane
// keeps only hits that match enough of the query's words, and the map can say "nothing notable found"; the E3 test hook
// (SCOUT_TEST_MAP_FIRST) is removed.
import type { Index } from "./index.ts";
import { terms } from "./rank.ts";
import type { Item, Source } from "./types.ts";
import type { WorkspaceSource } from "./sources/workspace.ts";
import { locatorText } from "./message.ts";
import { cleanText } from "./safety.ts";
import { fileInfos, type LedgerEntry } from "./research.ts";
import { copyGroups, copyOrder, newestFolderCopy } from "./dedup.ts";
import { cleanDate, isOpenWorld } from "./sources/mcp.ts";
import { restrictToTaskWords } from "./policy.ts";

/** Frozen tool-time configuration. Any change = new version, logged in RETRIEVAL.md. */
export const MAP7_CFG = {
  version: "map7-v2-pi2", // pi-scout: external cap and head rule, open-world task words only, abstention, sanitised text; v7b: copies merged (newest copy), outdated items only attached after their newer item
  max: 12,
  pattern: "LLP", // repeating slot pattern: L = next ledger entry, P = next plain-query hit (the rest fills the other way)
  plainK: 30,
  queryChars: 300,
  maxQueryTerms: 32,
  linkMinShared: 3,
  srcPerSource: 3, // plain hits per non-workspace source
  olderPerHead: 1, // v7b: older items attached after one newer entry (older versions are context)
  maxExternal: 3, // pi-scout: externally written items per map (config map.maxExternal, lower only)
};
/** pi-scout: query words an item must match (abstention when the ledger is empty): 1 of ≤ 2, 2 of ≤ 5, else 3. */
/** Map-side external rules (P2 bisect switches, CHANGES.md row 25). Defaults = shipped. Not a user setting. */
export const MAP_FORM = { extCap: true, extHead: true, scope: "openWorld" as "openWorld" | "external" };
/** 0.2: the items the external cap / head rule apply to: open-world (public) items; 0.1 applied them to every external item. */
const untrusted = (it: Item) => (MAP_FORM.scope === "external" ? !!it.external : !!(it.openWorld ?? (it.kind === "web" || String(it.id).startsWith("url:"))));
export const needTerms = (n: number) => (n <= 2 ? 1 : n <= 5 ? 2 : 3);
export type Map7Entry = { item: Item; from: "ledger" | "plain"; kind?: string; n: number; olderThan: number[]; newerThan: number[]; copies?: number };
export type Map7Result = { text: string; entries: Map7Entry[]; tokens: number; ms: number; sourceCalls: number; ledgerSize: number; ledgerReady: boolean; plainDropped: number; openWorldSkipped: number };

/** Plain lane: BM25 file ranking of the raw query + each enabled source's own search, round-robin (v6.0's tool map). */
export async function plainHits(query: string, idx: Index | null, ws: WorkspaceSource | null, sources: Source[], isExcluded: (id: string) => boolean, signal?: AbortSignal, taskText = ""): Promise<{ items: Item[]; sourceCalls: number; strong: Set<string>; openWorldSkipped: number }> {
  const q = terms(query).slice(0, MAP7_CFG.maxQueryTerms);
  const qset = new Set(q);
  const need = needTerms(qset.size);
  const strong = new Set<string>();
  const cover = (id: string, text: string) => { let k = 0; for (const t of new Set(terms(text))) if (qset.has(t)) k++; if (k >= need) strong.add(id); };
  const lists: Item[][] = [];
  if (idx && ws && q.length) lists.push(idx.search([], [{ name: "lex", terms: q, w: 1 }], (f) => !isExcluded(f.startsWith("commit:") ? f : `file:${f}`), MAP7_CFG.plainK, 60, "rrf").map((h) => { const it = ws.toItem(h, 300, new Set(q)); cover(it.id, `${h.file.replace(/[/._-]/g, " ")} ${h.chunk.head} ${h.chunk.text}`); return it; }));
  let sourceCalls = 0, openWorldSkipped = 0;
  await Promise.all(sources.filter((s) => s.available()).map(async (s) => {
    // pi-scout: an open-world source only gets the words of the agent's query that are also words of the user's prompt
    const text = isOpenWorld(s) ? restrictToTaskWords(query, taskText) : query;
    if (!text) { openWorldSkipped++; return; }
    const lex = isOpenWorld(s) ? terms(text) : q;
    sourceCalls++;
    try { const got = (await s.query({ task: text, intent: "", lex: [{ name: "lex", terms: lex, w: 1 }], text: [text], isExcluded, limit: 8 }, signal)).slice(0, 8); for (const it of got) cover(it.id, `${it.title} ${it.snippet}`); lists.push(got); } catch { lists.push([]); }
  }));
  // workspace list first at each rank; at most srcPerSource hits per other source in the first rounds
  const out: Item[] = [], seen = new Set<string>();
  for (let r = 0; r < MAP7_CFG.plainK; r++) for (const [li, l] of lists.entries()) {
    const it = l[r];
    if (!it || seen.has(it.id) || !locatorText(it)) continue;
    if (li > 0 && r >= MAP7_CFG.srcPerSource && out.length < MAP7_CFG.max) continue;
    seen.add(it.id); out.push(it);
  }
  return { items: out, sourceCalls, strong, openWorldSkipped };
}

export function mergeEntries(ledger: LedgerEntry[], plain: Item[], max = MAP7_CFG.max, pattern = MAP7_CFG.pattern, isExcluded: (id: string) => boolean = () => false): Map7Entry[] {
  const out: Map7Entry[] = [], seen = new Set<string>();
  const L = ledger.filter((e) => !isExcluded(e.item.id) && locatorText(e.item));
  const P = plain.filter((it) => !isExcluded(it.id));
  let li = 0, pi = 0, k = 0;
  const takeL = () => { while (li < L.length) { const e = L[li++]; if (!seen.has(e.item.id)) { seen.add(e.item.id); out.push({ item: e.item, from: "ledger", kind: e.kind, n: 0, olderThan: [], newerThan: [] }); return true; } } return false; };
  const takeP = () => { while (pi < P.length) { const it = P[pi++]; if (!seen.has(it.id)) { seen.add(it.id); out.push({ item: it, from: "plain", n: 0, olderThan: [], newerThan: [] }); return true; } } return false; };
  while (out.length < max && (li < L.length || pi < P.length)) {
    const slot = pattern[k++ % pattern.length];
    if (slot === "L") { if (!takeL()) takeP(); } else { if (!takeP()) takeL(); }
  }
  out.forEach((e, i) => { e.n = i + 1; });
  return out;
}

/**
 * v7b arrangement (RULES-v7.md › v7b rules §2–4). Candidates = ledger ∪ plain hits. Copies of one document become one
 * candidate, its newest copy (stem copies looked up across the folder). A candidate older than another candidate on the
 * same subject (map7-v1 link rule) is never listed on its own: the slot shows the newest candidate on that subject (its
 * head), then the older one attached right after it with an "older than" link (≤ olderPerHead per head; others dropped).
 * Slots alternate as in `pattern`.
 */
export function arrangeEntries(ledger: LedgerEntry[], plain: Item[], idx: Index | null, ws: WorkspaceSource | null, max = MAP7_CFG.max, pattern = MAP7_CFG.pattern, isExcluded: (id: string) => boolean = () => false, maxExternal = MAP7_CFG.maxExternal): Map7Entry[] {
  const infos = idx ? fileInfos(idx) : null;
  const dateOf = (f: string) => infos?.get(f)?.date ?? null;
  const cands: Item[] = [], kindOf = new Map<string, string>(), copiesOf = new Map<string, number>();
  const pos = new Map<string, number>();
  const canon = (it: Item): Item => {
    if (!idx || !ws || it.locator.type !== "file") return it;
    const nf = newestFolderCopy(idx, it.locator.path, dateOf, isExcluded);
    if (!nf) return it;
    copiesOf.set(`file:${nf.file}`, Math.max(copiesOf.get(`file:${nf.file}`) ?? 0, nf.n - 1));
    if (nf.file === it.locator.path) return it;
    const ch = idx.chunks[infos!.get(nf.file)?.first ?? -1];
    return ch ? ws.toItem({ file: nf.file, chunk: ch, dense: -1, bm25: 0, fused: 0, ranks: {} } as any, 300) : it;
  };
  const add = (it0: Item): number => {
    const it = canon(it0);
    if (!pos.has(it.id)) { pos.set(it.id, cands.length); cands.push(it); }
    return pos.get(it.id)!;
  };
  const Lraw = ledger.filter((e) => !isExcluded(e.item.id) && locatorText(e.item)).map((e) => { const i = add(e.item); if (!kindOf.has(cands[i].id)) kindOf.set(cands[i].id, e.kind); return i; });
  const Praw = plain.filter((it) => !isExcluded(it.id) && locatorText(it)).map((it) => add(it));
  const { rep, size } = copyGroups(idx, cands);
  // text-overlap copies: the representative is the group's newest copy; a ledger kind follows its copy
  cands.forEach((c, i) => { if (rep[i] !== i) { const k = kindOf.get(c.id); if (k && !kindOf.has(cands[rep[i]].id)) kindOf.set(cands[rep[i]].id, k); } });
  const uniq = (xs: number[]) => { const s = new Set<number>(); return xs.map((i) => rep[i]).filter((i) => (s.has(i) ? false : (s.add(i), true))); };
  const L = uniq(Lraw), P = uniq(Praw);
  // supersession among representatives: i is older than j (map7-v1 link rule); head = newest such j, followed to the top
  const reps = [...new Set(rep)];
  const head = new Map<number, number>();
  if (idx) {
    const maxDf = Math.max(3, 0.05 * idx.bm25.size);
    const words = new Map(reps.map((i) => [i, new Set(terms(`${cands[i].title.replace(/[/._-]/g, " ")} ${cands[i].snippet}`).filter((w) => { const df = idx.bm25.df.get(w) ?? 0; return df >= 2 && df <= maxDf; }))]));
    for (const i of reps) {
      const a = cands[i];
      if (!a.date) continue;
      let best = -1;
      for (const j of reps) {
        const b = cands[j];
        if (i === j || !b.date || !(b.date > a.date)) continue;
        if (MAP_FORM.extHead && untrusted(b) && !untrusted(a)) continue; // pi-scout: an external item never demotes an internal one
        let shared = 0; for (const w of words.get(i)!) if (words.get(j)!.has(w)) shared++;
        if (shared < MAP7_CFG.linkMinShared) continue;
        if (best < 0 || copyOrder(b, cands[best]) < 0) best = j;
      }
      if (best >= 0) head.set(i, best);
    }
  }
  const top = (i: number) => { let x = i; for (let g = 0; g < 50 && head.has(x); g++) x = head.get(x)!; return x; };
  const out: { i: number; older: number | null; attached: number }[] = [];
  const shown = new Set<number>();
  const lset = new Set(L);
  let ext = 0;
  // pi-scout: at most maxExternal externally written items; one over the cap is skipped (never listed)
  const extOk = (i: number) => { if (!MAP_FORM.extCap || !untrusted(cands[i])) return true; if (ext >= maxExternal) { shown.add(i); return false; } ext++; return true; };
  const place = (i: number): boolean => {
    const h = top(i);
    if (h === i) { if (shown.has(i)) return false; if (!extOk(i)) return false; shown.add(i); out.push({ i, older: null, attached: 0 }); return true; }
    let added = false;
    if (!shown.has(h) && extOk(h)) { shown.add(h); out.push({ i: h, older: null, attached: 0 }); added = true; }
    const at = out.findIndex((e) => e.i === h);
    if (at < 0) { shown.add(i); return added; } // head skipped (external cap): its older item is not listed alone either
    if (!shown.has(i)) {
      if (out[at].attached < MAP7_CFG.olderPerHead && extOk(i)) { out[at].attached++; shown.add(i); out.splice(at + 1 + (out[at].attached - 1), 0, { i, older: h, attached: 0 }); added = true; }
      else shown.add(i); // dropped: its subject already has an older version attached (or external cap)
    }
    return added;
  };
  let li = 0, pi = 0, k = 0;
  const takeL = () => { while (li < L.length) if (place(L[li++])) return true; return false; };
  const takeP = () => { while (pi < P.length) if (place(P[pi++])) return true; return false; };
  while (out.length < max && (li < L.length || pi < P.length)) {
    const slot = pattern[k++ % pattern.length];
    if (slot === "L") { if (!takeL()) takeP(); } else { if (!takeP()) takeL(); }
  }
  const res: Map7Entry[] = out.slice(0, max).map((e, n) => {
    const it = cands[e.i];
    const copies = Math.max(size[e.i] - 1, copiesOf.get(it.id) ?? 0);
    return { item: it, from: lset.has(e.i) ? "ledger" : "plain", kind: lset.has(e.i) ? kindOf.get(it.id) : undefined, n: n + 1, olderThan: [], newerThan: [], ...(copies > 0 ? { copies } : {}) };
  });
  const nOf = new Map(out.slice(0, max).map((e, n) => [e.i, n + 1]));
  out.slice(0, max).forEach((e, n) => { if (e.older !== null && nOf.has(e.older)) { res[n].olderThan.push(nOf.get(e.older)!); res[nOf.get(e.older)! - 1].newerThan.push(n + 1); } });
  return res;
}

const KIND_TXT: Record<string, string> = { rule: "rule", decision: "decision", update: "update", fact: "fact", template: "template", person: "person" };
const short = (ns: number[]) => ns.slice(0, 3).map((n) => `#${n}`).join(", ");
/** State of the background researcher for this prompt, as the map reports it. */
export type Background = "ready" | "running" | "off" | "skipped" | "failed";
const BG_NOTE: Record<Background, string> = {
  ready: "",
  running: "The scout's background search for this task is still running: call scout again before you finish to see what it found.",
  off: "The scout's background search is off (lexical search of your words only).",
  skipped: "",
  failed: "The scout's background search failed for this task (lexical search of your words only).",
};
export function renderMap7(query: string, entries: Map7Entry[], isSeen: (id: string) => boolean, background: Background, ledgerEmpty: boolean): string {
  const q = cleanText(query, 60);
  const note = BG_NOTE[background];
  if (!entries.length) {
    const why = background === "ready" ? " (the background search for this task found nothing notable either)" : "";
    return [`scout: nothing notable found for "${q}"${why}. Try other words (names, terms, the other language) if you expected something.`, note].filter(Boolean).join("\n");
  }
  const head = background === "ready" && ledgerEmpty
    ? `scout map for "${q}": ${entries.length} items, locators only (open what you need). The scout's background search found nothing notable for this task; these items match your words. Dates come from names, headers or commits.`
    : `scout map for "${q}": ${entries.length} items, locators only (open what you need). Items marked "found by the scout" come from its own background search of the folder and sources for this task; the others match your words. Dates come from names, headers or commits.`;
  const lines = [head];
  for (const e of entries) {
    const L = e.item.locator;
    const sec = L.type === "file" && e.item.hint?.startsWith("section ") ? e.item.hint.slice(8) : "";
    const loc = locatorText(e.item, null);
    if (!loc) continue; // never happens (filtered before), but no unsafe locator can reach the text
    const open = L.type === "file" ? `read ${loc}${sec && e.from === "plain" ? ` section "${cleanText(sec, 50)}"` : ""}` : L.type === "commit" ? loc : `call ${loc}`;
    const src = e.item.source === "workspace" ? (e.item.kind === "commit" ? "git" : "files") : cleanText(e.item.source.replace(/^mcp:/, ""), 30) || "source";
    const meta = [cleanDate(e.item.date) ?? "undated", src, isSeen(e.item.id) ? "opened" : "not opened"];
    if (e.from === "ledger") meta.push(`found by the scout${e.kind && KIND_TXT[e.kind] ? ` (${KIND_TXT[e.kind]})` : ""}`);
    if (e.olderThan.length) meta.push(`older than ${short(e.olderThan)}`);
    if (e.newerThan.length) meta.push(`newer than ${short(e.newerThan)}`);
    if (e.copies) meta.push(`newest of ${Math.min(99, Math.floor(e.copies)) + 1} copies`);
    lines.push(`${e.n}. ${open} — ${meta.join(", ")}`);
  }
  if (note) lines.push(note);
  return lines.join("\n");
}

export async function buildMap7(d: { query: string; ledger: LedgerEntry[]; background: Background; idx: Index | null; workspace: WorkspaceSource | null; sources: Source[]; isSeen: (id: string) => boolean; isExcluded?: (id: string) => boolean; signal?: AbortSignal; taskText?: string; maxExternal?: number }): Promise<Map7Result> {
  const t0 = Date.now();
  const query = cleanText(d.query, MAP7_CFG.queryChars);
  const excluded = d.isExcluded ?? (() => false);
  const { items, sourceCalls, strong, openWorldSkipped } = await plainHits(query, d.idx, d.workspace, d.sources, excluded, d.signal, d.taskText ?? "");
  const ledger = d.ledger.filter((e) => !excluded(e.item.id) && locatorText(e.item));
  // abstention: with nothing from the researcher (done with no finding, off, skipped or failed), only plain hits that
  // match enough of the query's words are listed; none → "nothing notable found"
  const ledgerEmpty = ledger.length === 0;
  const plain = ledgerEmpty && d.background !== "running" ? items.filter((it) => strong.has(it.id)) : items;
  const entries = arrangeEntries(ledger, plain, d.idx, d.workspace, MAP7_CFG.max, MAP7_CFG.pattern, excluded, Math.min(MAP7_CFG.maxExternal, d.maxExternal ?? MAP7_CFG.maxExternal));
  const text = renderMap7(query, entries, d.isSeen, d.background, ledgerEmpty);
  return { text, entries, tokens: Math.ceil(text.length / 3.5), ms: Date.now() - t0, sourceCalls, ledgerSize: d.ledger.length, ledgerReady: d.background !== "running", plainDropped: items.length - plain.length, openWorldSkipped };
}
