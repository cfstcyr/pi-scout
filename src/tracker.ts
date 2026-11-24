// Scout v4 session tracker: what the agent has seen (files, commits), what it is doing (task, intent, recent events),
// and which candidates are not worth a nudge (seen, nudged, trivial, habit, novelty). No pi imports: the extension and
// the offline replay both drive it.
import fs from "node:fs";
import path from "node:path";
import { bashFiles, commitRefs, expandGlob, gitShowRefs, grepOutputFiles, headerFiles, importSpecifiers, textFiles } from "./seen.ts";
import { isSecretPath } from "./secrets.ts";
import type { Commit, Index } from "./index.ts";

export const compact = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (c?.type === "text" ? c.text : "")).filter(Boolean).join("\n") : "";
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.[a-z]+$/i;
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|sh|sql|vue|svelte)$/i;
export const isTest = (p: string) => TEST_RE.test(p);
export const isCodeSrc = (p: string) => CODE_RE.test(p) && !TEST_RE.test(p);
const STOPW = new Set("the a an and or to of in on for with is are be it this that i you we can will should file files code use using from by as at not do does if then else into out up any all just make sure let me now here there what which when where how have has had was were run add also fix write tests test new existing".split(" "));
/** Word set of a text, for the min-change gate (Jaccard distance between successive snapshots). */
export const wordSet = (t: string) => new Set((t.toLowerCase().match(/[a-z_][a-z0-9_.-]{2,}/g) || []).filter((w) => !STOPW.has(w)));
export function jaccardDist(a: Set<string>, b: Set<string>) {
  if (!a.size && !b.size) return 0;
  let i = 0; for (const t of a) if (b.has(t)) i++;
  return 1 - i / (a.size + b.size - i);
}

export class Tracker {
  firstUser = ""; lastUser = "";
  recent: string[] = [];
  seen: Record<string, Set<string>> = { read: new Set(), write: new Set(), grep: new Set(), list: new Set(), task: new Set(), commits: new Set() };
  gitOut: string[] = [];
  nudged = new Set<string>(); // paths / "commit:<short>" / item ids
  /** v5: non-file items (MCP, web, tool results) the agent has seen, by item id; probes = strings that reveal them. */
  seenItems = new Set<string>();
  private probes = new Map<string, Set<string>>();
  /** Everything observed so far (bounded): a probe registered later is checked against it (retroactive seen-tracking). */
  private observed: string[] = [];
  private observedLen = 0;
  static OBSERVED_MAX = 600_000;
  private static bounded(text: string, p: string) { let i = text.indexOf(p); while (i >= 0) { const a = text[i - 1] ?? " ", b = text[i + p.length] ?? " "; if (!/[A-Za-z0-9]/.test(a) && !/[A-Za-z0-9]/.test(b)) return true; i = text.indexOf(p, i + 1); } return false; }
  register(id: string, probes: string[] = []) {
    if (id.startsWith("file:") || id.startsWith("commit:")) return;
    for (const p of probes) {
      if (!p || p.length < 3 || (p.length < 4 && !/\d/.test(p))) continue;
      const fresh = !this.probes.has(p);
      if (fresh) this.probes.set(p, new Set());
      const ids = this.probes.get(p)!;
      const newId = !ids.has(id);
      ids.add(id);
      if ((fresh || newId) && !this.seenItems.has(id) && this.observed.some((t) => Tracker.bounded(t, p))) this.seenItems.add(id); // seen before the scout found it
    }
  }
  /** Any text the agent produced or received (tool args, tool results): items whose probe appears in it are seen. */
  observe(text: string) {
    if (!text) return;
    this.observed.push(text); this.observedLen += text.length;
    while (this.observedLen > Tracker.OBSERVED_MAX && this.observed.length > 1) this.observedLen -= this.observed.shift()!.length;
    if (!this.probes.size) return;
    for (const [p, ids] of this.probes) if (Tracker.bounded(text, p)) for (const id of ids) this.seenItems.add(id);
  }
  /** v5 item-id view of excluded(): files by path, commits by hash, other items by the probe registry. */
  excludedId(id: string) {
    if (id.startsWith("file:")) return this.excluded(id.slice(5));
    if (id.startsWith("commit:")) return this.excluded(id);
    return this.nudged.has(id) || this.seenItems.has(id);
  }
  seenNowId(id: string) {
    if (id.startsWith("file:")) return this.seenNow(id.slice(5));
    if (id.startsWith("commit:")) return this.seenNow(id);
    return this.seenItems.has(id);
  }
  listed() { const k = new Set(this.known()); return [...this.seen.list].filter((f) => !k.has(f)); }
  constructor(public cwd: string, public idx?: Index, public opts: { habit?: boolean; novelty?: boolean } = {}) {}
  rel(p: unknown): string | null {
    if (!p || typeof p !== "string") return null;
    const s = p.trim().replace(/^['"@]|['"]$/g, "");
    if (!s) return null;
    const r = path.relative(this.cwd, path.isAbsolute(s) ? s : path.resolve(this.cwd, s));
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : null;
  }
  isFile = (r: string) => { try { return fs.statSync(path.join(this.cwd, r)).isFile(); } catch { return false; } };
  fileTok = (t: string) => { const r = this.rel(t); return r && this.isFile(r) ? r : null; };
  readdir = (d: string) => { try { return fs.readdirSync(path.resolve(this.cwd, d), { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch { return []; } };
  push(s: string) { this.recent.push(s); if (this.recent.length > 8) this.recent.shift(); }
  user(prompt: string) {
    const t = compact(prompt, 1500);
    if (!this.firstUser) this.firstUser = t;
    this.lastUser = t;
    for (const p of textFiles(prompt, this.fileTok)) this.seen.task.add(p); // files the user named are already known
  }
  assistantText(t: string) { if (t.trim()) this.push(`Agent said: ${compact(t, 300)}`); }
  call(tool: string, a: any) {
    a = a || {};
    if (tool === "bash") for (const h of gitShowRefs(String(a.command || ""))) this.seen.commits.add(h);
    if (tool === "read") { const r = this.rel(a.path); if (r) this.seen.read.add(r); }
    else if (tool === "edit" || tool === "write") { const r = this.rel(a.path); if (r) this.seen.write.add(r); }
    else if (tool === "grep" && a.path) { const r = this.fileTok(String(a.path)); if (r) this.seen.read.add(r); }
    else if (tool === "bash") {
      const { read, mentioned, write } = bashFiles(String(a.command || ""), this.fileTok, (g) => expandGlob(g, this.readdir));
      for (const r of read) this.seen.read.add(r);
      for (const w of write) { const r = this.rel(w); if (r) this.seen.write.add(r); }
      for (const r of mentioned) this.seen.list.add(r);
    }
    this.observe(JSON.stringify(a));
    this.push(`Agent ran ${tool}: ${compact(a.command ?? a.path ?? a.pattern ?? JSON.stringify(a), 200)}`);
  }
  result(tool: string, a: any, text: string, isError = false) {
    text = text.slice(0, 20000);
    this.observe(text);
    const cmd = String(a?.command || "");
    if (tool === "grep" || (tool === "bash" && /\b(rg|grep|ag|ack)\b/.test(cmd))) for (const p of grepOutputFiles(text, this.fileTok)) this.seen.grep.add(p);
    if (tool === "find" || tool === "ls" || tool === "bash") for (const p of textFiles(text, this.fileTok)) this.seen.list.add(p);
    if (tool === "bash" || tool === "read") for (const p of headerFiles(text, this.fileTok)) this.seen.read.add(p);
    if (tool === "bash" && /\bgit\b/.test(cmd) && commitRefs(text).length) { this.gitOut.push(text); if (this.gitOut.length > 12) this.gitOut.shift(); }
    this.push(`Result ${tool}${isError ? " (error)" : ""}: ${compact(text, 200)}`);
  }
  commitSeen(id: string) {
    const c: Commit | undefined = this.idx?.commits.get(id);
    if (!c) return false;
    for (const h of this.seen.commits) if (c.hash.startsWith(h)) return true;
    const probe = (c.body.split("\n").find((l) => l.trim().length > 15) ?? c.subject).trim().slice(0, 40);
    return this.gitOut.some((t) => (t.includes(c.short) || t.includes(c.hash.slice(0, 10))) && t.includes(probe));
  }
  /** Seen (read / written / grep-hit / named in the task) or already nudged. */
  excluded(f: string) {
    if (this.nudged.has(f)) return true;
    if (f.startsWith("commit:")) return this.commitSeen(f);
    for (const k of ["read", "write", "grep", "task"]) if (this.seen[k].has(f)) return true;
    return false;
  }
  /** Seen only (not "nudged"): used to drop a pending nudge the agent reached on its own. */
  seenNow(f: string) { return f.startsWith("commit:") ? this.commitSeen(f) : ["read", "write", "grep"].some((k) => this.seen[k].has(f)); }
  known() { return [...new Set([...this.seen.task, ...this.seen.read, ...this.seen.write])]; }
  intent() { return [...this.recent].reverse().find((r) => r.startsWith("Agent said: "))?.slice(12, 312) ?? ""; }
  snapshot() { return [`Task: ${this.firstUser}`, this.lastUser !== this.firstUser ? `Latest user message: ${this.lastUser}` : "", ...this.recent].filter(Boolean).join("\n"); }
  editing() { return this.seen.write.size > 0; }

  private resolveImport(from: string, spec: string): string | null {
    let base: string;
    if (/^\.+\w/.test(spec) && !spec.includes("/")) { // python ".mod" / "..pkg.mod"
      const dots = spec.match(/^\.+/)![0].length;
      base = path.join(path.dirname(from), ...Array(dots - 1).fill(".."), spec.slice(dots).replace(/\./g, "/"));
    } else base = path.join(path.dirname(from), spec);
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", "/index.ts", "/index.js", "/__init__.py"]) if (this.isFile(base + ext)) return path.normalize(base + ext);
    return null;
  }
  /**
   * Why a candidate is not worth a nudge even though the agent has not seen it (null = keep):
   * habit (root README, test of a seen module), novelty (code in the same dir as / imported by a known file),
   * basename or symbol named in the prompt.
   */
  skipReason(f: string, sym?: string): string | null {
    if (f.startsWith("commit:")) return null;
    if (isSecretPath(f)) return "secret-like file";
    const known = this.known();
    if (this.opts.habit !== false) {
      if (/^readme[^/]*$/i.test(f)) return "root README (read by habit)";
      if (isTest(f)) {
        const base = (x: string) => path.basename(x).replace(/\.(test|spec)(?=\.)/, "").replace(/^test_/, "").replace(/_test(?=\.)/, "").replace(/\.[^.]+$/, "").toLowerCase();
        if (known.some((k) => k !== f && base(k) === base(f))) return "test of a seen module";
      }
    }
    if (this.opts.novelty !== false && (isCodeSrc(f) || (this.opts.habit !== false && isTest(f) && CODE_RE.test(f)))) {
      if (known.some((k) => path.dirname(k) === path.dirname(f))) return "same dir as a seen file";
      for (const k of known) {
        if (isSecretPath(k)) continue;
        let src = ""; try { src = fs.readFileSync(path.join(this.cwd, k), "utf8").slice(0, 20000); } catch { continue; }
        if (importSpecifiers(src).some((s) => this.resolveImport(k, s) === f)) return `imported by ${k}`;
      }
    }
    const prompt = this.lastUser.toLowerCase();
    const wordIn = (w: string) => w.length >= 4 && new RegExp(`(^|[^a-z0-9_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_])`).test(prompt);
    const stem = path.basename(f).replace(/\.[^.]+$/, "").toLowerCase();
    if (wordIn(stem) && !/^(readme|index|main|docs?)$/.test(stem)) return "basename named in prompt";
    if (sym && wordIn(sym.toLowerCase())) return "symbol named in prompt";
    return null;
  }
}
