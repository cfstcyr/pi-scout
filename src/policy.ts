// pi-scout product policies (no pi imports, unit-tested): when the researcher runs, which model it may use, what may be
// sent to open-world sources, and the session's model-token budget.
import { fold, terms } from "./rank.ts";
import { redactSecrets } from "./secrets.ts";

// ---------------- trivial prompts ----------------
/**
 * Does the prompt look like a real task (worth a ~7 s, 10–25 k-token background search)? Slash commands, short
 * acknowledgements and one-line follow-ups ("ok", "thanks", "continue", "fix the typo") do not: the researcher is skipped
 * and the settle reminder is not sent. The `scout` tool stays available either way.
 */
export function looksLikeTask(prompt: string, minTerms = 5): boolean {
  const p = String(prompt ?? "").trim();
  if (!p || p.startsWith("/") || p.startsWith("!")) return false;
  return new Set(terms(p)).size >= minTerms;
}

// ---------------- open-world sources ----------------
const STOP_SURFACE = /^(the|and|for|with|from|this|that|these|those|into|about|your|their|what|which|when|where|how|les|des|une|pour|avec|dans|sur|est|sont|qui|que|par|aux|ces|cette|mais|donc|car|plus|please|svp|merci|thanks|write|draft|make|need|want|can|could|would|should|faire|écrire|rédiger|peux|veux)$/i;
/**
 * Words of the user's own prompt that may go to an open-world source (web search…): plain words of ≥ 3 letters, no
 * paths, URLs, e-mail addresses, numbers-with-letters ids or secrets, stopwords dropped, ≤ max words, original order.
 * Nothing derived from the folder (file names, entities found by the researcher, item content) is ever added.
 */
export function taskWords(prompt: string, max = 8): string {
  const raw = redactSecrets(String(prompt ?? "")).replace(/\S+@\S+/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").replace(/\S*[\/\\]\S*/g, " ");
  const out: string[] = [], seen = new Set<string>();
  for (const w of raw.match(/[\p{L}][\p{L}'’-]*[\p{L}]/gu) ?? []) {
    const k = fold(w).toLowerCase();
    if (w.length < 3 || STOP_SURFACE.test(w) || seen.has(k) || !terms(w).length) continue;
    seen.add(k); out.push(w);
    if (out.length >= max) break;
  }
  return out.join(" ");
}
/**
 * An agent query restricted to the words that also occur in the user's prompt (the agent may have read folder names and
 * client names into its query; those never go to an open-world source). "" when fewer than `min` words survive.
 */
export function restrictToTaskWords(query: string, prompt: string, min = 2, max = 8): string {
  const allowed = new Set(terms(taskWords(prompt, 64)));
  const out: string[] = [], seen = new Set<string>();
  for (const w of String(query ?? "").match(/[\p{L}][\p{L}'’-]*[\p{L}]/gu) ?? []) {
    const t = terms(w);
    if (!t.length || !t.every((x) => allowed.has(x))) continue;
    const k = t.join(" ");
    if (seen.has(k)) continue;
    seen.add(k); out.push(w);
    if (out.length >= max) break;
  }
  return out.length >= min ? out.join(" ") : "";
}

// ---------------- model choice ----------------
export type ModelInfo = { provider: string; id: string };
export type ModelChoice = { model: string | null; why: string };
/** Small models first: Haiku, then Flash-Lite / Flash, then mini / nano / small / lite. */
const SMALL: RegExp[] = [/haiku/i, /flash-lite/i, /flash/i, /(^|[-_.])(mini|nano|small|lite)([-_.]|$)/i];
export const PREFERRED_ID = "claude-haiku-5-5";
/**
 * The researcher's model. Never another provider than the session's unless the user named one explicitly; never a silent
 * fallback: no usable model → null (lexical-only) with the reason.
 *   llm off                         → null
 *   explicit (env SCOUT_QUERY_MODEL or config research.model):
 *     "session"                     → the session model itself
 *     "provider/id"                 → that model if it is available (has auth), else null
 *   otherwise                       → the session provider's smallest available model (SMALL order; within a class the
 *                                     preferred id, then the highest id), else null
 */
export function chooseModel(o: { llm: boolean; explicit?: string | null; session?: ModelInfo | null; available: ModelInfo[] }): ModelChoice {
  if (!o.llm) return { model: null, why: "LLM researcher disabled by config" };
  const has = (p: string, id: string) => o.available.some((m) => m.provider === p && m.id === id);
  if (o.explicit) {
    if (o.explicit === "session") return o.session ? { model: `${o.session.provider}/${o.session.id}`, why: "configured: session model" } : { model: null, why: "configured 'session' but no session model" };
    const i = o.explicit.indexOf("/");
    const p = o.explicit.slice(0, i), id = o.explicit.slice(i + 1);
    if (i > 0 && has(p, id)) return { model: o.explicit, why: "configured" };
    return { model: null, why: `configured model ${o.explicit} is not available` };
  }
  if (!o.session?.provider) return { model: null, why: "no session model" };
  const mine = o.available.filter((m) => m.provider === o.session!.provider);
  for (const re of SMALL) {
    const c = mine.filter((m) => re.test(m.id));
    if (!c.length) continue;
    const m = c.find((x) => x.id === PREFERRED_ID) ?? [...c].sort((a, b) => b.id.localeCompare(a.id))[0];
    return { model: `${m.provider}/${m.id}`, why: "session provider, small model" };
  }
  return { model: null, why: `no small model available from provider ${o.session.provider}` };
}

// ---------------- token budget ----------------
export class BudgetError extends Error { constructor(m: string) { super(m); this.name = "BudgetError"; } }
/** Model tokens of the researcher: per run and per session, checked before each call with a conservative estimate. */
export class TokenBudget {
  session = 0; run = 0; runs = 0;
  constructor(public maxSession: number, public maxRun: number, public maxRuns: number) {}
  canStartRun() { return this.runs < this.maxRuns && this.session < this.maxSession; }
  startRun() { this.runs++; this.run = 0; }
  /** Throws BudgetError when a call of `estimate` tokens could exceed a cap. */
  check(estimate: number) {
    if (this.run + estimate > this.maxRun) throw new BudgetError(`per-task token cap (${this.maxRun})`);
    if (this.session + estimate > this.maxSession) throw new BudgetError(`session token cap (${this.maxSession})`);
  }
  add(tokens: number) { this.run += tokens; this.session += tokens; }
}
