// Registers provider "fake" (scripted server on 127.0.0.1, port in $FAKE_PORT_FILE): "scripted" (the agent) and, unless
// FAKE_NO_MINI=1, "scripted-mini" (a small model of the same provider, which the researcher should pick).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
export default function fake(pi: ExtensionAPI) {
  const port = fs.readFileSync(process.env.FAKE_PORT_FILE!, "utf8").trim();
  const m = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 2000 });
  pi.registerProvider("fake", { name: "fake", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "x", api: "openai-completions",
    models: process.env.FAKE_NO_MINI === "1" ? [m("scripted")] : [m("scripted"), m("scripted-mini")] } as any);
}
