// BENCHMARK ONLY. The experiment harness (harness/run.py) sets $HARNESS_TOOLS_CONFIG = <run>/tools.json in every
// condition when a workspace has mock MCP servers; harness/tools-extension.ts registers the same servers' tools for the
// agent. This turns that file into an explicit user-level allowlist for the scout's own client, by a fixed mechanical rule:
//   searchTools = tools with readOnlyHint === true, destructiveHint !== true and a query-like string parameter
//   fetchTools  = tools with readOnlyHint === true, destructiveHint !== true and exactly one required id-like parameter
//   openWorld   = true when a listed tool carries openWorldHint (the mock web server is a local fixture)
//   external    = server kind "web" or "chat" (externally writable content); others false   [SCOUT_BENCH_EXTERNAL=kind, default]
//                 SCOUT_BENCH_EXTERNAL=all: field omitted = a daily user config that lists servers without `external`
//                 (every server external, pi-scout 0.1.0 default); =openworld: same + "externalDefault": "openWorld"
//                 (only openWorld servers and URLs external). Tester PS1, 2026-11-23, CHANGES.md row 24.
//   agentPrefix = the prefix of the names the harness registered for the agent (mcp__<server>__ or e.g. web_)
//   config      = the same server command, with MOCK_CALLER=scout (the harness counts the scout's calls separately)
// Write tools (readOnlyHint false: add_comment, log_interaction, post_message) are never listed. Never set in daily use.
import { idParam, queryParam } from "./mcp.ts";

export function benchConfigFromTools(tj: any, externalMode: string = "kind"): any {
  const mcp: Record<string, any> = {};
  for (const s of tj?.servers ?? []) {
    const tools: any[] = s.tools ?? [];
    const ro = tools.filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true);
    const searchTools = ro.filter((t) => queryParam(t, false)).map((t) => t.name);
    const fetchTools = ro.filter((t) => idParam(t)).map((t) => t.name);
    if (!searchTools.length) continue;
    const cmd: string[] = Array.isArray(s.command) ? s.command.map(String) : [String(s.command)];
    const reg = s.registered ?? {};
    const anyName = Object.keys(reg)[0];
    const agentPrefix = anyName && String(reg[anyName]).endsWith(anyName) ? String(reg[anyName]).slice(0, -anyName.length) : s.register_as === "plain" ? String(s.prefix ?? "") : undefined;
    mcp[s.name] = {
      route: "client", config: { command: cmd[0], args: cmd.slice(1), env: { MOCK_CALLER: "scout" } },
      searchTools, fetchTools,
      openWorld: ro.some((t) => [...searchTools, ...fetchTools].includes(t.name) && t.annotations?.openWorldHint === true),
      ...(externalMode === "all" || externalMode === "openworld" ? {} : { external: s.kind === "web" || s.kind === "chat" }), agentPrefix, budgetMs: 3000,
    };
  }
  return { workspace: { enabled: true, budgetMs: 2000 }, grep: { enabled: false }, discover: "off", capture: false, mcp, ...(externalMode === "openworld" ? { externalDefault: "openWorld" } : {}) };
}
