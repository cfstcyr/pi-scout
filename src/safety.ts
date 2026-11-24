// Scout v5 safety helpers (no imports): what may appear in a pointer, server-name normalisation, external sources.
// A pointer names a path, URL or tool call that comes from files or tools the scout does not control; anything outside
// a narrow character set is refused (the item is never proposed), never "cleaned" into a different locator.

// control chars, line/paragraph separators, bidi overrides and isolates
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/;

/** Relative workspace path: ≤ 160 chars, no control chars, no markdown/backtick/quote/shell metacharacters, no `..`. */
export function safePath(p: string): boolean {
  return typeof p === "string" && p.length > 0 && p.length <= 160 && !CTRL.test(p) && !/[`<>\[\]*|\\"$!{}~]/.test(p)
    && !p.startsWith("/") && !p.split("/").includes("..");
}
/** http(s) URL: ≤ 200 chars, conservative character set (no quotes, parentheses, brackets, backticks, spaces). */
export function safeUrl(u: string): boolean {
  return typeof u === "string" && u.length <= 200 && /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~:\/?#@&=%+,;-]*)?$/.test(u);
}
/** A tool name the agent can call. */
export const safeToolName = (n: string) => typeof n === "string" && /^[A-Za-z0-9_]{1,64}$/.test(n);
/** An item id used as a tool argument: short token, or a safe URL. */
export const safeArgValue = (v: unknown) => typeof v === "string" && ((v.length <= 80 && /^[A-Za-z0-9._:\/@#+-]+$/.test(v)) || safeUrl(v));
export const safeArgs = (a: Record<string, unknown>) => Object.keys(a).length <= 2 && Object.entries(a).every(([k, v]) => /^[A-Za-z_]{1,24}$/.test(k) && safeArgValue(v));
/** Free text shown inside quotes (titles, commit subjects, section names): no control chars, no markdown, ≤ k chars. */
export function cleanText(s: unknown, k: number): string {
  return String(s ?? "").replace(new RegExp(CTRL.source, "g"), " ").replace(/\(?\s*https?:\/\/[^\s)]*\)?/g, " ").replace(/[`"*_<>\[\]|\\#{}$~]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, k).replace(/[.\s]+$/, "");
}
/** Server / tool-prefix names compared case-insensitively, punctuation-insensitively, with or without `mcp__`. */
export const normName = (s: string) => String(s ?? "").toLowerCase().replace(/^mcp__/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
