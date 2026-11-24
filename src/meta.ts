// Scout v5: item dates (for staleness / supersession). Generic rules only, no workspace knowledge.
//   file name     2025-12-04-…, 20251204, 2025_12_04, 2025-12 (month precision)
//   head lines    frontmatter `date:` / `updated:`, mail headers (`Date:`, `Sent:`, `Envoyé :`), "effective"/"en vigueur",
//                 "updated"/"mis à jour" followed by an ISO date or a day-month-year in English or French
//   git           commit date (%cI) for commits; MCP / web items carry their own date field when the source gives one
// A date is a string "YYYY-MM-DD" (or "YYYY-MM"), compared lexicographically.
const MONTHS: Record<string, string> = {
  jan: "01", january: "01", janvier: "01", feb: "02", february: "02", fevrier: "02", février: "02", mar: "03", march: "03", mars: "03",
  apr: "04", april: "04", avril: "04", may: "05", mai: "05", jun: "06", june: "06", juin: "06", jul: "07", july: "07", juillet: "07",
  aug: "08", august: "08", aout: "08", août: "08", sep: "09", sept: "09", september: "09", septembre: "09", oct: "10", october: "10", octobre: "10",
  nov: "11", november: "11", novembre: "11", dec: "12", december: "12", decembre: "12", décembre: "12",
};
const pad = (n: string | number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d?: number) => y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && (d === undefined || (d >= 1 && d <= 31));

/** First date in a string: ISO / compact / "4 décembre 2025" / "December 4, 2025". */
export function parseDate(s: string): string | null {
  let m = s.match(/(?<!\d)((?:19|20)\d\d)[-_./]?(0[1-9]|1[0-2])[-_./]?(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (m && valid(+m[1], +m[2], +m[3])) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(?<!\d)([0-3]?\d)(?:er)?\s+([A-Za-zéèûôÉ]{3,10})\.?\s+((?:19|20)\d\d)(?!\d)/);
  if (m && MONTHS[m[2].toLowerCase()] && valid(+m[3], +MONTHS[m[2].toLowerCase()], +m[1])) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${pad(m[1])}`;
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+([0-3]?\d)(?:st|nd|rd|th)?,?\s+((?:19|20)\d\d)(?!\d)/);
  if (m && MONTHS[m[1].toLowerCase()] && valid(+m[3], +MONTHS[m[1].toLowerCase()], +m[2])) return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${pad(m[2])}`;
  return null;
}
/** Month-precision date in a file name (2025-12, 2025_12), only when no full date is present. */
function parseMonth(s: string): string | null {
  const m = s.match(/(?<!\d)((?:19|20)\d\d)[-_](0[1-9]|1[0-2])(?![-_]?\d)/);
  return m ? `${m[1]}-${m[2]}` : null;
}
const HEAD_KEY = /^\s*(?:[-*>]\s*)?\**\s*(date|dated|updated|last[ -]updated|modified|sent|envoy[ée]|re[çc]u|received|effective|en vigueur|mis(?:e)? à jour|publi[ée]|published|adopt[ée]|approved|approuv[ée]|version|r[ée]vis[ée]|revised)\b[^:\n]{0,20}[:：]?/i;
/** Date of a file: from its name, else from the first 40 lines (date-like keys first, then an H1/H2 heading with a date). */
export function fileDate(file: string, head: string): string | null {
  const base = file.split("/").pop() ?? file;
  const fromName = parseDate(base) ?? parseDate(file);
  if (fromName) return fromName;
  const lines = head.split("\n").slice(0, 40);
  for (const l of lines) if (HEAD_KEY.test(l)) { const d = parseDate(l); if (d) return d; }
  for (const l of lines) if (/^\s{0,3}#{1,2}\s/.test(l)) { const d = parseDate(l); if (d) return d; }
  return parseMonth(base) ?? parseMonth(file) ?? parseYear(base) ?? parseYear(file);
}
/** v6 plumbing (2026-11-22, RULES change log): year-precision date in a file name or path segment ("policy-2024.md",
 *  "2025-spring/"), only when nothing more precise exists. A 4-digit year delimited by non-digits and not part of an
 *  identifier with letters glued to it (INF4170). */
export function parseYear(s: string): string | null {
  const m = s.match(/(?<![\dA-Za-z])((?:19|20)\d\d)(?![\dA-Za-z])/) ?? s.match(/(?<![\dA-Za-z])((?:19|20)\d\d)(?=[-_](?:spring|summer|fall|autumn|winter|printemps|ete|été|automne|hiver|T[1-4]|Q[1-4]|H[12])\b)/i);
  return m ? m[1] : null;
}
