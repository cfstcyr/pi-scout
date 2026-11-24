// What the agent saw in this session, for "opened / not opened" of MCP items (an item counts as seen when its id appears
// in a tool result or tool arguments). Replaces v6's support.ts Observations, minus the audit-only parts.
export class Observed {
  task = "";
  results: { tool: string; text: string }[] = [];
  private len = 0;
  static MAX = 800_000;
  setTask(t: string) { this.task = t; }
  addResult(tool: string, text: string) {
    if (!text) return;
    const t = text.slice(0, 40_000);
    this.results.push({ tool, text: t });
    this.len += t.length;
    while (this.len > Observed.MAX && this.results.length > 1) this.len -= this.results.shift()!.text.length;
  }
  saw(raw: string) { return raw.length >= 3 && this.results.some((r) => r.text.includes(raw)); }
}
