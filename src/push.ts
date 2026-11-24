// pi-scout 0.2 default delivery (ported from pi-scout-push, PUSHMAP, 2026-11-23): programmatic delivery of the researcher's dated map.
// SCOUT_DELIVERY=push-map: when the background researcher finishes, the same compact dated map the `scout` tool would
// return for the user's prompt (locators, dates, source, older/newer links; no content) is injected once per prompt as a
// steer message. Entries the agent already opened are skipped, unless they carry an older/newer link to an entry that is
// still shown (the link is the useful part). The text is capped at PUSH_CFG.maxTokens by listing fewer entries.
// No pi imports (unit-testable).
import type { Index } from "./index.ts";
import type { Source } from "./types.ts";
import type { WorkspaceSource } from "./sources/workspace.ts";
import type { LedgerEntry } from "./research.ts";
import { type Background, type Map7Entry, MAP7_CFG, arrangeEntries, plainHits, renderMap7 } from "./map7.ts";
import { locatorText } from "./message.ts";
import { cleanText } from "./safety.ts";

export const PUSH_CFG = { version: "pushmap-v1", maxTokens: 450, minEntries: 3 };
export type Delivery = "pull" | "push-map";
export const deliveryMode = (v: string | undefined): Delivery => (v === "pull" ? "pull" : "push-map"); // 0.2: push is the default
const tok = (s: string) => Math.ceil(s.length / 3.5);

export const PUSH_HEAD = (n: number) => `[Scout] The scout's background search for this task finished. Dated map of ${n} items it found or that match the task (locators only, unverified; open what you need, newest versions first). No need to mention this note.`;

/** Keep entries the agent has not opened; an opened entry stays only when linked to a kept unopened entry. Renumbers. */
export function dropOpened(entries: Map7Entry[], isSeen: (id: string) => boolean): Map7Entry[] {
  const unopened = new Set(entries.filter((e) => !isSeen(e.item.id)).map((e) => e.n));
  const keep = entries.filter((e) => unopened.has(e.n) || [...e.olderThan, ...e.newerThan].some((k) => unopened.has(k)));
  const renum = new Map(keep.map((e, i) => [e.n, i + 1]));
  return keep.map((e) => ({ ...e, n: renum.get(e.n)!, olderThan: e.olderThan.filter((k) => renum.has(k)).map((k) => renum.get(k)!), newerThan: e.newerThan.filter((k) => renum.has(k)).map((k) => renum.get(k)!) }));
}

/** Truncate to the first k entries, dropping links to removed ones. */
export function firstK(entries: Map7Entry[], k: number): Map7Entry[] {
  return entries.slice(0, k).map((e) => ({ ...e, olderThan: e.olderThan.filter((x) => x <= k), newerThan: e.newerThan.filter((x) => x <= k) }));
}

/** The map lines of renderMap7 (its own header and background note removed), under the push header. */
export function renderPush(query: string, entries: Map7Entry[], isSeen: (id: string) => boolean): string {
  const body = renderMap7(query, entries, isSeen, "ready", false).split("\n").filter((l) => /^\d+\. /.test(l));
  return [PUSH_HEAD(body.length), ...body].join("\n");
}

export type PushMap = { text: string; entries: Map7Entry[]; tokens: number; full: number; droppedOpened: number; truncated: number; ms: number; sourceCalls: number };
/**
 * Build the pushed map for the user's prompt: same plain lane + ledger + arrangement as the tool (map7), with the prompt
 * as the query, then drop opened entries and cap the tokens. Returns null when nothing is left to show.
 */
export async function buildPushMap(d: { prompt: string; ledger: LedgerEntry[]; background: Background; idx: Index | null; workspace: WorkspaceSource | null; sources: Source[]; isSeen: (id: string) => boolean; isExcluded?: (id: string) => boolean; signal?: AbortSignal; maxExternal?: number; maxTokens?: number }): Promise<PushMap | null> {
  const t0 = Date.now();
  const query = cleanText(d.prompt, MAP7_CFG.queryChars);
  const excluded = d.isExcluded ?? (() => false);
  const { items, sourceCalls, strong } = await plainHits(query, d.idx, d.workspace, d.sources, excluded, d.signal, d.prompt);
  const ledger = d.ledger.filter((e) => !excluded(e.item.id) && locatorText(e.item));
  const plain = ledger.length === 0 ? items.filter((it) => strong.has(it.id)) : items; // tool's abstention rule
  const all = arrangeEntries(ledger, plain, d.idx, d.workspace, MAP7_CFG.max, MAP7_CFG.pattern, excluded, Math.min(MAP7_CFG.maxExternal, d.maxExternal ?? MAP7_CFG.maxExternal));
  const kept = dropOpened(all, d.isSeen);
  if (!kept.length) return null;
  const cap = d.maxTokens ?? PUSH_CFG.maxTokens;
  let k = kept.length, text = renderPush(query, kept, d.isSeen);
  while (tok(text) > cap && k > PUSH_CFG.minEntries) { k--; text = renderPush(query, firstK(kept, k), d.isSeen); }
  const entries = firstK(kept, k);
  return { text, entries, tokens: tok(text), full: all.length, droppedOpened: all.length - kept.length, truncated: kept.length - k, ms: Date.now() - t0, sourceCalls };
}
