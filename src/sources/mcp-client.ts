// Minimal MCP client (JSON-RPC 2.0) for the scout's fallback route: stdio (newline-delimited) and streamable HTTP (JSON or
// SSE response). Only what the scout needs: initialize, tools/list, tools/call, resources/list, resources/read.
// The tool gate (read-only + listed) lives in sources/mcp.ts. Stdio servers are children of pi's process (not detached):
// close() ends stdin, sends SIGTERM and SIGKILL after 1 s; every live client is also killed when the process exits.
// An aborted request sends notifications/cancelled to the server.
import { spawn, type ChildProcess } from "node:child_process";

const LIVE = new Set<McpClient>();
let exitHook = false;
function ensureExitHook() {
  if (exitHook) return;
  exitHook = true;
  process.on("exit", () => { for (const c of LIVE) c.kill("SIGKILL"); });
}

export type McpServerConfig = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeout?: number };
export type McpTool = { name: string; description?: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; idempotentHint?: boolean } };

const expandEnv = (s: string) => s.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => process.env[a || b] ?? "");

export class McpClient {
  private proc: ChildProcess | null = null;
  private child: ChildProcess | null = null; // kept after close() for the exit hook
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
  private sessionId: string | null = null;
  tools: McpTool[] = [];
  connected = false;
  instructions = "";
  constructor(public name: string, public cfg: McpServerConfig) {}

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.cfg.command) {
      this.proc = spawn(this.cfg.command.replace(/^~\//, `${process.env.HOME}/`), (this.cfg.args ?? []).map((a) => a.replace(/^~\//, `${process.env.HOME}/`)), {
        cwd: this.cfg.cwd, env: { ...process.env, ...Object.fromEntries(Object.entries(this.cfg.env ?? {}).map(([k, v]) => [k, expandEnv(v)])) }, stdio: ["pipe", "pipe", "ignore"],
      });
      this.child = this.proc; LIVE.add(this); ensureExitHook();
      this.proc.on("error", () => { this.connected = false; });
      this.proc.stdout!.setEncoding("utf8");
      this.proc.stdout!.on("data", (d: string) => { this.buf += d; let i; while ((i = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); this.onMessage(line); } });
      this.proc.on("exit", () => { this.connected = false; LIVE.delete(this); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("mcp server exited")); } this.pending.clear(); });
      this.proc.unref(); // never keeps pi alive; killed in close() / on exit
      (this.proc.stdout as any).unref?.(); (this.proc.stdin as any).unref?.();
      this.proc.stdin!.on("error", () => {});
    } else if (!this.cfg.url) throw new Error(`mcp ${this.name}: no command or url`);
    const init = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-scout", version: "5" } }, signal);
    this.instructions = String(init?.instructions ?? "");
    await this.notify("notifications/initialized", {});
    const tl = await this.request("tools/list", {}, signal);
    this.tools = tl?.tools ?? [];
    this.connected = true;
  }
  private onMessage(line: string) {
    let m: any; try { m = JSON.parse(line); } catch { return; }
    if (m.id === undefined || !this.pending.has(m.id)) return;
    const p = this.pending.get(m.id)!; this.pending.delete(m.id); clearTimeout(p.timer);
    if (m.error) p.reject(new Error(`mcp ${this.name}: ${m.error.message ?? JSON.stringify(m.error)}`)); else p.resolve(m.result);
  }
  private async notify(method: string, params: unknown) {
    const msg = { jsonrpc: "2.0", method, params };
    if (this.proc) { try { this.proc.stdin!.write(JSON.stringify(msg) + "\n"); } catch {} }
    else await this.http(msg).catch(() => {});
  }
  async request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    const timeoutMs = (this.cfg.timeout ?? 20) * 1000;
    if (!this.proc) {
      const r = await this.http(msg, signal, timeoutMs);
      if (r?.error) throw new Error(`mcp ${this.name}: ${r.error.message}`);
      return r?.result;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`mcp ${this.name}: ${method} timeout`)); }, timeoutMs);
      const onAbort = () => { if (this.pending.delete(id)) { clearTimeout(timer); reject(new Error("aborted")); void this.notify("notifications/cancelled", { requestId: id, reason: "scout budget" }).catch(() => {}); } };
      if (signal?.aborted) { clearTimeout(timer); reject(new Error("aborted")); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: (v) => { signal?.removeEventListener("abort", onAbort); resolve(v); }, reject: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); }, timer });
      try { this.proc!.stdin!.write(JSON.stringify(msg) + "\n"); } catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  private async http(msg: any, signal?: AbortSignal, timeoutMs = 20000): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...Object.fromEntries(Object.entries(this.cfg.headers ?? {}).map(([k, v]) => [k, expandEnv(v)])) };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const r = await fetch(this.cfg.url!, { method: "POST", headers, body: JSON.stringify(msg), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean) as AbortSignal[]) });
    const sid = r.headers.get("mcp-session-id"); if (sid) this.sessionId = sid;
    if (msg.id === undefined) return null;
    const ct = r.headers.get("content-type") ?? "";
    const text = await r.text();
    if (ct.includes("text/event-stream")) {
      for (const ev of text.split(/\n\n/)) { const data = ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""); if (!data) continue; try { const j = JSON.parse(data); if (j.id === msg.id) return j; } catch {} }
      return null;
    }
    return text ? JSON.parse(text) : null;
  }
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) { return this.request("tools/call", { name, arguments: args }, signal); }
  kill(sig: NodeJS.Signals) { try { const c = this.child; if (c && c.exitCode === null && c.signalCode === null) c.kill(sig); } catch {} }
  close() {
    const p = this.proc;
    this.proc = null; this.connected = false;
    if (!p) return;
    try { p.stdin?.end(); } catch {}
    try { p.kill("SIGTERM"); } catch {}
    const t = setTimeout(() => { try { if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); } catch {} LIVE.delete(this); }, 1000);
    t.unref?.();
  }
}
