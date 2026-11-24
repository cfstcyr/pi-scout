// Ported from scout-v7/test/v7.test.ts (frozen v7b behaviour kept by pi-scout). No network, no pi.   bun test pi-scout/test/
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Index } from "../src/index.ts";
import { WorkspaceSource } from "../src/sources/workspace.ts";
import { JUDGE_SYS, PLAN_SYS, RESEARCH_CFG, fileDigest, overview, parseJsonLoose, research, type LedgerEntry } from "../src/research.ts";
import { MAP7_CFG, buildMap7, mergeEntries } from "../src/map7.ts";
import { makeScoutTool } from "../src/tool.ts";
import type { Llm } from "../src/llm.ts";
import type { Item } from "../src/types.ts";
import { terms } from "../src/rank.ts";

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v7-"));
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
  w("governance/board/2025-10-14-board-minutes.md", "# Board meeting 14 October 2025\n## Communications\nThe board adopts these rules for the bulletin: members never customers. No exclamation marks.\n");
  w("brand/style-guide-2021.md", "# Style guide\nExclamation marks welcome in the bulletin! Sign Cheers, The Team.\n");
  w("projects/booking/plan.md", "# Room booking plan\nThe room booking system launches 7 April for members.\n");
  for (let i = 1; i <= 28; i++) w(`Daily/2026-02-${String(i).padStart(2, "0")}.md`, `# 2026-02-${i}\n- Groceries, laundry ${i}.\n${i === 24 ? "- Soumission révisée : 17 900 $ taxes incluses. Install pushed to April 20.\n" : ""}`);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "import"], { cwd: dir });
  return dir;
}

describe("parseJsonLoose", () => {
  test("merges several objects and fenced blocks", () => {
    const j = parseJsonLoose('{"picks": [{"n": 1, "kind": "rule", "gist": "a } b"}]}\n```json\n{"follow_queries": ["x y"]}\n```');
    expect(j.picks[0].n).toBe(1);
    expect(j.follow_queries).toEqual(["x y"]);
  });
  test("salvages picks and lists from malformed JSON", () => {
    const j = parseJsonLoose('{"picks": [{"n": 15, "kind": "template", "gist": "g"}, {"n": 5, "kind": "rule", "gist": "h"}]", "follow_queries": ["q1", "q2"], "follow_folders": ["macros"]}');
    expect(j.picks.map((p: any) => p.n)).toEqual([15, 5]);
    expect(j.follow_queries).toEqual(["q1", "q2"]);
    expect(j.follow_folders).toEqual(["macros"]);
  });
  test("null when nothing parses", () => { expect(parseJsonLoose("no json here")).toBeNull(); });
});

describe("overview and digests", () => {
  const dir = fixture();
  const idx = new Index(dir).build();
  test("overview lists folders with counts and date ranges, no file content", () => {
    const o = overview(idx);
    expect(o).toContain("Daily/ — 28 files, dated 2026-02");
    expect(o).toContain("governance/");
    expect(o).not.toContain("Soumission");
  });
  test("digest picks the informative line of a long note", () => {
    const dg = fileDigest(idx, "Daily/2026-02-24.md", new Set(terms("heat pump")));
    expect(dg).toContain("17 900 $");
    expect(dg.length).toBeLessThanOrEqual(RESEARCH_CFG.digestChars);
  });
});

describe("research pipeline (fake judge)", () => {
  const dir = fixture();
  const idx = new Index(dir).build();
  const ws = new WorkspaceSource(() => idx, { candN: 15 });
  test("plan → newest-first folder scan → judge picks by number; content stays out of the ledger ids", async () => {
    const prompts: string[] = [];
    const llm: Llm = async (system, prompt) => {
      prompts.push(prompt);
      if (system === PLAN_SYS) return { text: JSON.stringify({ queries: ["heat pump quote", "thermopompe soumission"], folders: ["Daily"] }), ms: 5, usage: { input: 100, output: 20 } };
      expect(system).toBe(JUDGE_SYS);
      const m = prompt.match(/(\d+)\. Daily\/2026-02-24\.md/);
      return { text: JSON.stringify({ picks: m ? [{ n: Number(m[1]), kind: "update", gist: "revised quote" }] : [], follow_queries: [], follow_folders: [] }), ms: 5, usage: { input: 200, output: 30 } };
    };
    const r = await research({ task: "Write my brother a note about the heat pump decision.", idx, workspace: ws, sources: [], llm });
    expect(r.error).toBeUndefined();
    expect(r.ledger.map((e) => e.item.id)).toEqual(["file:Daily/2026-02-24.md"]);
    expect(r.plan.folders).toEqual(["Daily"]);
    expect(prompts[0]).toContain("Daily/ — 28 files");
    expect(r.calls).toBeGreaterThanOrEqual(2);
  });
  test("a failing model gives an empty ledger, not a throw", async () => {
    const llm: Llm = async () => { throw new Error("boom"); };
    const r = await research({ task: "x", idx, workspace: ws, sources: [], llm });
    expect(r.ledger).toEqual([]);
    expect(r.error).toContain("boom");
  });
});

describe("map7", () => {
  const it = (id: string): Item => ({ id: `file:${id}`, source: "workspace", kind: "file", title: id, locator: { type: "file", path: id }, snippet: "" });
  const L = (id: string, kind = "rule"): LedgerEntry => ({ item: it(id), kind: kind as any, gist: "secret gist", round: 1, rank: 1 });
  test("LLP interleaving, dedupe, fill from the other lane", () => {
    const e = mergeEntries([L("a"), L("b"), L("c")], [it("p1"), it("a"), it("p2")], 12, "LLP");
    expect(e.map((x) => x.item.id.slice(5))).toEqual(["a", "b", "p1", "c", "p2"]);
    expect(e.map((x) => x.n)).toEqual([1, 2, 3, 4, 5]);
  });
  test("map never shows gists or content, marks ledger entries, notes a running search", async () => {
    const dir = fixture();
    const idx = new Index(dir).build();
    const ws = new WorkspaceSource(() => idx, { candN: 15 });
    const m = await buildMap7({ query: "room booking", ledger: [L("governance/board/2025-10-14-board-minutes.md")], background: "running", idx, workspace: ws, sources: [], isSeen: () => false });
    expect(m.text).toContain("found by the scout (rule)");
    expect(m.text).not.toContain("secret gist");
    expect(m.text).not.toContain("exclamation");
    expect(m.text).toContain("still running");
    expect(m.entries.length).toBeLessThanOrEqual(MAP7_CFG.max);
  });
});

describe("tool schema", () => {
  const base: any = { pi: {}, getState: () => ({}), log: () => {}, onCall: () => {}, guideline: true, ledgerWaitMs: 0, waitIndex: async () => false };
  test("pull only: query and kinds, never draft_path (the v6 audit is not shipped)", () => {
    const t = makeScoutTool(base);
    expect(Object.keys(t.parameters.properties)).toEqual(["query", "kinds"]);
    expect(t.description).not.toContain("draft_path");
    expect(t.annotations.readOnlyHint).toBe(true);
    expect(t.promptGuidelines?.length).toBe(1);
  });
});
