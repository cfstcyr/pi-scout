// Hashes of pi-scout's source files (logged at session_start, so a log says exactly which code produced it).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const VERSION = "pi-scout-0.2.0";
const HERE = path.dirname(new URL(import.meta.url).pathname);
export const SOURCE_FILES = ["extension.ts", "tool.ts", "research.ts", "map7.ts", "dedup.ts", "policy.ts", "llm.ts", "observed.ts", "hash.ts", "index.ts", "rank.ts", "seen.ts", "tracker.ts", "meta.ts", "message.ts", "safety.ts", "secrets.ts", "types.ts", "sources/workspace.ts", "sources/mcp.ts", "sources/mcp-client.ts", "sources/budget.ts", "sources/bench.ts", "sources/config.ts", "sources/greptool.ts", "push.ts"];
/** Retrieval path (researcher, map, tool and the files they use): what decides the map's content. */
export const RETRIEVAL_FILES = ["research.ts", "map7.ts", "tool.ts", "policy.ts", "index.ts", "rank.ts", "meta.ts", "message.ts", "safety.ts", "secrets.ts", "types.ts", "sources/workspace.ts", "sources/mcp.ts", "sources/budget.ts", "dedup.ts"];
const hashOf = (files: string[]) => {
  const h = crypto.createHash("sha1");
  for (const f of [...files].sort()) { try { h.update(f + "\n" + fs.readFileSync(path.join(HERE, f), "utf8")); } catch {} }
  return h.digest("hex").slice(0, 12);
};
export const codeHash = () => hashOf(SOURCE_FILES);
export const retrievalHash = () => hashOf(RETRIEVAL_FILES);
