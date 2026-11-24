// Pure helpers for "what has the agent already seen" tracking. No pi imports, so `bun test` can load it.
import path from "node:path";

/** Commands whose file arguments the agent reads (their content reaches the model). */
export const READ_CMDS = new Set(["cat", "head", "tail", "less", "more", "bat", "batcat", "nl", "sed", "awk", "rg", "grep", "egrep", "ag", "ack", "view", "jq", "yq", "wc", "diff", "strings", "od", "xxd"]);
const PREFIX_CMDS = new Set(["sudo", "env", "command", "time", "nice", "xargs", "exec", "timeout"]);

/** Split shell text into candidate path tokens: splits on whitespace and shell operators, strips quotes and punctuation. */
export function shellTokens(text: string): string[] {
  const out: string[] = [];
  for (let t of text.split(/[\s;|&<>()]+/)) {
    t = t.replace(/^(?:[A-Za-z_][\w]*)=/, ""); // VAR=path
    t = t.replace(/^[`'"@=]+/, "");
    t = t.replace(/:\d+(?::\d+)?(?::.*)?$/, ""); // path:line[:col][:text] (grep output)
    for (let prev = ""; prev !== t;) { prev = t; t = t.replace(/[`'",:;!?)\]}]+$/, "").replace(/(?<!^|\.)\.+$/, ""); } // trailing quotes/punctuation/sentence dot; keeps "." and ".."
    if (t && t !== "." && t !== ".." && !t.startsWith("-") && !/^\d+(,\d+)?p?$/.test(t)) out.push(t);
  }
  return out;
}

/** Split a command line into simple-command segments (on ; | & && || newlines, and $( ). */
export function segments(command: string): string[] {
  return command.split(/(?:\|\||&&|[;|&\n()]|\$\(|`)/).map((s) => s.trim()).filter(Boolean);
}

/** Program name of a segment, skipping VAR=x assignments and wrappers like sudo/env/time. */
export function programOf(segment: string): string {
  const words = segment.split(/\s+/);
  for (const w of words) {
    if (/^[A-Za-z_]\w*=/.test(w) || PREFIX_CMDS.has(w) || /^-/.test(w)) continue;
    return w.replace(/^.*\//, "").replace(/^['"]|['"]$/g, "");
  }
  return "";
}

/**
 * Files referenced by a bash command. `isFile(token)` returns the cwd-relative path when the token names a
 * file, else null. `expand(token)` (optional) expands a glob token (`docs/*`) into such tokens. `cd <dir>`
 * changes the base of later relative tokens. Files that are arguments of a read-like command go in `read`;
 * others in `mentioned`.
 */
export function bashFiles(command: string, isFile: (token: string) => string | null, expand?: (glob: string) => string[]): { read: string[]; mentioned: string[]; write: string[] } {
  const read = new Set<string>();
  const mentioned = new Set<string>();
  const write = new Set<string>();
  const cmd = command.slice(0, 20000);
  let base = "";
  const at = (t: string) => (base && !path.isAbsolute(t) ? path.join(base, t) : t);
  // Redirection / tee targets are writes (the file may not exist yet, so the caller's isFile decides later).
  for (const m of cmd.matchAll(/(?:\d?>>?|\btee\s+(?:-a\s+)?)\s*(['"]?)([^\s'";|&<>()]+)\1/g)) if (!/^&?\d$|^\/dev\//.test(m[2])) write.add(m[2]);
  const segs = segments(cmd);
  // Loops and fan-out (`for f in docs/*; do cat "$f"; done`, `ls x | xargs cat`, `find … -exec cat {} \;`,
  // `cat $(find …)`): when a read-like program appears anywhere, every file/glob in the command is read.
  const execRead = [...cmd.matchAll(/-exec(?:dir)?\s+(\S+)/g)].some((m) => READ_CMDS.has(m[1].replace(/^.*\//, "")));
  const anyRead = execRead || segs.some((sg) => READ_CMDS.has(programOf(sg)));
  const fanOut = anyRead && (execRead || /\b(for|while)\b[\s\S]*\bdo\b|\bxargs\b|\$\(|`/.test(cmd));
  // `… | head -400` after a fan-out: only the first files reached the model; leave those to headerFiles().
  const truncated = fanOut && /\|\s*(head|tail)\b/.test(cmd.replace(/\$\([^)]*\)/g, ""));
  for (const seg of segs) {
    const prog = programOf(seg);
    const toks = shellTokens(seg);
    if (prog === "cd") { const d = toks[toks.indexOf("cd") + 1]; if (d) base = path.isAbsolute(d) ? d : path.join(base, d); continue; }
    const reads = READ_CMDS.has(prog) || (fanOut && !truncated);
    const segWrites = new Set([...seg.matchAll(/(?:\d?>>?|\btee\s+(?:-a\s+)?)\s*(['"]?)([^\s'";|&<>()]+)\1/g)].map((m) => m[2]));
    // find ROOTS -name PAT feeding a reader: expand ROOT/**/PAT.
    // v4 fix (from scout-alt): only when find's output actually feeds a reader (-exec, | xargs, $(find …), `find …`), not
    // e.g. `find . -type f | wc -l` elsewhere in a command that has a for-loop (marked every file as read).
    const findFeeds = execRead || /\bfind\b[^;&|]*\|\s*xargs\b/.test(cmd) || /\$\(\s*find\b|`\s*find\b/.test(cmd);
    if (prog === "find" && fanOut && findFeeds && !truncated && expand) {
      const words = seg.split(/\s+/).slice(1).map((w) => w.replace(/^['"]|['"]$/g, ""));
      const roots: string[] = [];
      for (const w of words) { if (w.startsWith("-") || w === "!" ) break; roots.push(w); }
      const pats = [...seg.matchAll(/-i?(?:name|path)\s+(['"]?)([^\s'"]+)\1/g)].map((m) => m[2].replace(/^\*\//, ""));
      for (const r of roots.length ? roots : ["."]) for (const p of pats.length ? pats : ["*"]) {
        for (const t of expand(path.join(at(r), "**", p))) { const f = isFile(t); if (f) read.add(f); }
      }
    }
    if (prog === "find") continue; // its -name patterns are not cwd globs
    for (const t0 of toks) {
      if (segWrites.has(t0) || t0.startsWith("$")) continue;
      const tok = at(t0);
      const list = /[*?[]/.test(tok) && expand ? expand(tok) : [tok];
      for (const t of list) {
        const r = isFile(t);
        if (r) (reads ? read : mentioned).add(r);
      }
    }
  }
  for (const r of read) mentioned.delete(r);
  return { read: [...read], mentioned: [...mentioned], write: [...write].map((w) => isFile(w) ?? w) };
}

/** Files announced by header lines in tool output: `==> path <==` (head/tail), `== path ==`, `--- path`, `### path`, `File: path`. */
export function headerFiles(text: string, isFile: (token: string) => string | null): string[] {
  const out = new Set<string>();
  for (const m of text.slice(0, 200000).matchAll(/^[ \t]*(?:==>|=+|-{3,}|#{1,4}|\*{3}|>>>|File:|FILE:)[ \t]*['"`]?([^\s'"`<>=]+?)['"`]?[ \t]*(?:<==|=+|-{3,})?[ \t]*$/gm)) {
    const r = isFile(m[1]);
    if (r) out.add(r);
  }
  return [...out];
}

/** Commit-ish words in text (7-40 hex chars, at least one digit and one letter). */
export function commitRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.slice(0, 200000).matchAll(/\b[0-9a-f]{7,40}\b/g)) if (/\d/.test(m[0]) && /[a-f]/.test(m[0])) out.add(m[0]);
  return [...out];
}

/** Revisions the agent explicitly showed: `git show <rev>…`, `git log -p <rev>`. */
export function gitShowRefs(command: string): string[] {
  const out = new Set<string>();
  for (const seg of segments(command.slice(0, 20000))) {
    const w = seg.split(/\s+/);
    const i = w.indexOf("git");
    if (i < 0 || !["show", "log"].includes(w[i + 1])) continue;
    if (w[i + 1] === "log" && !w.some((x) => x === "-p" || x === "--patch" || x === "--stat")) continue;
    for (const x of w.slice(i + 2)) if (/^[0-9a-f]{7,40}(\^|~\d*)?$/.test(x)) out.add(x.replace(/[\^~].*$/, ""));
  }
  return [...out];
}

/** Minimal glob expansion (`*`, `?`, `[...]`, `**`) over a directory listing function; capped. */
export function expandGlob(pattern: string, readdir: (dir: string) => { name: string; dir: boolean }[], cap = 200): string[] {
  const abs = path.isAbsolute(pattern);
  const parts = pattern.split("/").filter((p, i) => p !== "" || (i === 0 && abs));
  const toRe = (p: string) => {
    const src = (q: string, lit: RegExp) => "^" + q.replace(lit, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$";
    const balanced = /^[^[\]]*(\[[^\]]+\][^[\]]*)*$/.test(p); // else brackets are literal
    try { return new RegExp(src(p, balanced ? /[.+^${}()|\\]/g : /[.+^${}()|\\[\]]/g)); } catch { return /$^/; }
  };
  let cur = [abs ? "/" : ""];
  for (let i = 0; i < parts.length && cur.length; i++) {
    const p = parts[i];
    if (p === "" ) continue;
    const next: string[] = [];
    if (!/[*?[]/.test(p)) { for (const c of cur) next.push(c ? path.join(c, p) : p); }
    else if (p === "**") {
      const stack = [...cur];
      while (stack.length && next.length < cap) { const c = stack.pop()!; next.push(c); for (const e of readdir(c || ".")) if (e.dir && !e.name.startsWith(".") && e.name !== "node_modules") stack.push(c ? path.join(c, e.name) : e.name); }
    } else {
      const re = toRe(p);
      for (const c of cur) for (const e of readdir(c || ".")) if (re.test(e.name) && (!e.name.startsWith(".") || p.startsWith("."))) next.push(c ? path.join(c, e.name) : e.name);
    }
    cur = next.slice(0, cap);
  }
  return cur.filter(Boolean);
}

/** File paths mentioned anywhere in free text (prompt, tool output). */
export function textFiles(text: string, isFile: (token: string) => string | null): string[] {
  const out = new Set<string>();
  for (const tok of shellTokens(text.slice(0, 20000))) {
    if (!/[./]/.test(tok)) continue; // bare words are rarely paths; keeps statSync calls down
    const r = isFile(tok);
    if (r) out.add(r);
  }
  return [...out];
}

/** Paths of `path:line:` prefixes in grep/rg output. */
export function grepOutputFiles(text: string, isFile: (token: string) => string | null): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^([^\s:][^:\n]*?)(?::\d+[:-]|-\d+-)/gm)) { const r = isFile(m[1]); if (r) out.add(r); }
  return [...out];
}

/** Relative module specifiers imported by a source file (JS/TS/Python). */
export function importSpecifiers(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:from\s+|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g)) out.add(m[1]);
  for (const m of src.matchAll(/^\s*from\s+(\.+[\w.]*)\s+import/gm)) out.add(m[1]); // python relative
  return [...out].filter((s) => s.startsWith("."));
}
