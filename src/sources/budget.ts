// Call budget for tool / MCP sources, shared by all sources of one session and reset at every user prompt (new task):
//   ≤ perServer calls per server, ≤ total calls overall, each call aborted after perCallMs (the AbortSignal is passed
//   down to the transport, and the scout stops waiting even if the route ignores it), circuit breaker: a server is
//   skipped for the rest of the task after `breakAfter` failures (thrown error, timeout or isError result).
//   Identical calls (same server, tool, args) within a task are answered from memory and cost nothing.
// pi-scout: an optional `parent` budget caps the calls of several budgets together (the researcher's and the tool's
// budgets share one per-prompt cap, `calls.perPrompt`); a call is made only when both budgets are open.
export type BudgetOpts = { perServer?: number; total?: number; perCallMs?: number; breakAfter?: number };
export class CallBudget {
  perServer: number; total: number; perCallMs: number; breakAfter: number;
  private used = new Map<string, number>();
  private fails = new Map<string, number>();
  private totalUsed = 0;
  private cache = new Map<string, Promise<any>>();
  log: (ev: string, d: Record<string, unknown>) => void = () => {};
  constructor(o: BudgetOpts = {}, public parent: CallBudget | null = null) {
    this.perServer = o.perServer ?? 12; this.total = o.total ?? 30; this.perCallMs = o.perCallMs ?? 3000; this.breakAfter = o.breakAfter ?? 2;
  }
  reset() { this.used.clear(); this.fails.clear(); this.totalUsed = 0; this.cache.clear(); }
  open(server: string): boolean {
    return (this.fails.get(server) ?? 0) < this.breakAfter && (this.used.get(server) ?? 0) < this.perServer && this.totalUsed < this.total && (!this.parent || this.parent.open(server));
  }
  stats() { return { total: this.totalUsed, perServer: Object.fromEntries(this.used), failures: Object.fromEntries(this.fails) }; }
  async call<T>(server: string, key: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const k = `${server}\n${key}`;
    const hit = this.cache.get(k);
    if (hit) return hit;
    if (!this.open(server)) throw new Error("call budget");
    this.used.set(server, (this.used.get(server) ?? 0) + 1); this.totalUsed++;
    if (this.parent) { this.parent.used.set(server, (this.parent.used.get(server) ?? 0) + 1); this.parent.totalUsed++; }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("call timeout")), this.perCallMs);
    const onAbort = () => ac.abort(new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) ac.abort(new Error("aborted"));
    const p = (async () => {
      try {
        const r: any = await Promise.race([fn(ac.signal), new Promise<never>((_r, rej) => { if (ac.signal.aborted) rej(ac.signal.reason); ac.signal.addEventListener("abort", () => rej(ac.signal.reason ?? new Error("aborted")), { once: true }); })]);
        if (r?.isError) throw Object.assign(new Error("tool error result"), { result: r });
        return r as T;
      } catch (e) {
        this.cache.delete(k);
        if (!(signal?.aborted)) { const f = (this.fails.get(server) ?? 0) + 1; this.fails.set(server, f); if (f === this.breakAfter) this.log("circuit_open", { server, failures: f, error: String((e as any)?.message ?? e).slice(0, 120) }); }
        throw e;
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
    })();
    this.cache.set(k, p);
    return p;
  }
}
