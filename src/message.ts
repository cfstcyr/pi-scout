// Locator text of an item (from scout v6 message.ts; the v6 contrastive message renderer is not shipped). Every locator
// goes through v5's sanitisers; an item whose locator fails is never shown, never rewritten.
import { cleanText, safeArgs, safePath, safeToolName } from "./safety.ts";

/** Agent-reachable locator of an item, or null (unsafe / not reachable). */
export function locatorText(item: { locator: any; external?: boolean }, section?: string | null): string | null {
  const L = item.locator;
  if (!L) return null;
  if (L.type === "file") { if (!safePath(L.path)) return null; const sec = section ? cleanText(section, 40) : ""; return `\`${L.path}\`${sec ? ` (section "${sec}")` : ""}`; }
  if (L.type === "commit") return /^[0-9a-f]{6,40}$/.test(L.short) ? `commit ${L.short} (\`git show ${L.short}\`)` : null;
  if (L.type === "tool") {
    if (!safeToolName(L.tool) || !safeArgs(L.args ?? {})) return null;
    const call = `tool \`${L.tool}\` with args ${JSON.stringify(L.args)}`;
    return item.external ? `an externally written item (${call})` : call;
  }
  return null; // saved copies (v5 web pages) are never used by v6: no writes
}
