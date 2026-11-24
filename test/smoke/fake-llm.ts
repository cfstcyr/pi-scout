#!/usr/bin/env bun
// Scripted OpenAI-compatible server for the pi-scout smoke test (127.0.0.1 only, no real model, fake data).
// Researcher requests are recognised by their system prompts (plan / judge); every other request is the agent:
//   FAKE_SCRIPT=tool    call scout {query} → "Done."
//   FAKE_SCRIPT=remind  "Done." → (after the scout reminder) call scout → "Done, checked."
import fs from "node:fs";
const SCRIPT = process.env.FAKE_SCRIPT || "tool";
const log = process.env.FAKE_LOG || "";
const scripts: Record<string, any[]> = {
  tool: [{ tool: "scout", args: { query: "room booking launch" } }, { text: "Done." }],
  remind: [{ text: "Done." }, { tool: "scout", args: { query: "room booking launch" } }, { text: "Done, checked." }],
};
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    const body: any = await req.json();
    const sys = (body.messages ?? []).filter((m: any) => m.role === "system" || m.role === "developer").map((m: any) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
    const user = (body.messages ?? []).filter((m: any) => m.role === "user").map((m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("")).join("\n");
    const id = `chatcmpl-${Date.now()}`;
    const chunk = (delta: any, finish: string | null = null) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const text = (t: string) => chunk({ role: "assistant", content: t }) + chunk({}, "stop") + `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`;
    let out: string, kind: string;
    if (/You plan the research/.test(sys)) { kind = "plan"; out = text(JSON.stringify({ queries: ["room booking launch", "bulletin rules"], folders: ["governance"] })); }
    else if (/You are a research assistant/.test(sys)) {
      kind = "judge";
      const n = user.match(/(\d+)\. projects\/booking\/2026-01-12-update\.md/)?.[1];
      out = text(JSON.stringify({ picks: n ? [{ n: Number(n), kind: "update", gist: "launch moved" }] : [], follow_queries: [], follow_folders: [] }));
    } else {
      kind = "agent";
      const turn = (body.messages ?? []).filter((m: any) => m.role === "assistant").length;
      const script = scripts[SCRIPT];
      const step = script[Math.min(turn, script.length - 1)];
      if ("tool" in step) out = chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${turn}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n";
      else out = text(step.text);
      if (log) fs.appendFileSync(log, JSON.stringify({ kind, model: body.model, turn, sawReminder: /\[Scout\] Before you finish/.test(user), leak: /FAKEFAKE/.test(user), tools: (body.tools ?? []).map((t: any) => t.function?.name) }) + "\n");
    }
    if (log && kind !== "agent") fs.appendFileSync(log, JSON.stringify({ kind, model: body.model, leak: /FAKEFAKE/.test(user), redacted: /\[redacted\]/.test(user) }) + "\n");
    await new Promise((r) => setTimeout(r, 100));
    return new Response(out, { headers: { "content-type": "text/event-stream" } });
  },
});
fs.writeFileSync(process.argv[2] || "/tmp/pi-scout-fake.port", String(server.port));
