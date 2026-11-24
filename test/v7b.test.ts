// Ported from scout-v7/test/v7b.test.ts. Unit tests for scout v7b (dedup.ts, map7-v2 arrangement, research-v4 judge prompt / digests). No network, no pi.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Index } from "../src/index.ts";
import { WorkspaceSource } from "../src/sources/workspace.ts";
import { copyGroups, folderCopies, stemInfo } from "../src/dedup.ts";
import { arrangeEntries } from "../src/map7.ts";
import { RESEARCH_CFG, fileDigest, judgePrompt, type LedgerEntry } from "../src/research.ts";
import { terms } from "../src/rank.ts";
import type { Item } from "../src/types.ts";

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v7b-"));
  const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); };
  const body = (y: string, fee: string) => `# Refund policy ${y}\nDate: ${y}-03-01\nRefunds for cancelled workshop bookings are paid within ${fee} days by the treasurer. Members keep priority booking. The cooperative applies this refund policy to every workshop, rental and membership fee without exception.\n`;
  w("policies/refund-policy.md", body("2021", "30"));
  w("policies/refund-policy (1).md", body("2021", "30"));
  w("archive/refund-policy-v2.md", body("2022", "20"));
  w("governance/2025-06-10-board-refund-decision.md", "# Board 2025-06-10 refund policy\nThe board adopts a new refund policy for workshop bookings: refunds within 7 days, decided by the treasurer.\n");
  w("a/README.md", "# A\nalpha\n"); w("b/README.md", "# B\nbeta\n");
  const long = Array.from({ length: 400 }, (_, i) => `## Day ${i}\n${i === 333 ? "Le comité a résolu : le jardin communautaire ferme le 15 octobre, pas le 31." : `Chat line ${i} about seedlings, watering and tools.`}\n`).join("\n");
  w("exports/chat-export.md", `# Chat export\n${long}`);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "import"], { cwd: dir });
  return dir;
}

describe("dedup", () => {
  test("copy and version markers fold into one stem; dates and plain same names elsewhere do not", () => {
    for (const f of ["Policy (1).md", "Policy - Copy.md", "policy_FINAL.docx", "policy-v2.md", "Copy of Policy.md", "x/policy.sync-conflict-20240101-1234-ABCD.md"]) expect(stemInfo(f).stem).toBe("policy");
    expect(stemInfo("policy-v3.md").ver).toBe(3);
    expect(stemInfo("minutes-2024-01.md").stem).not.toBe(stemInfo("minutes-2024-02.md").stem);
  });
  const dir = fixture();
  const idx = new Index(dir).build();
  test("folder copies: same stem with a marker anywhere, plain same name only in the same directory", () => {
    expect(folderCopies(idx, "policies/refund-policy.md").sort()).toEqual(["archive/refund-policy-v2.md", "policies/refund-policy (1).md", "policies/refund-policy.md"]);
    expect(folderCopies(idx, "a/README.md")).toEqual(["a/README.md"]);
  });
  test("text overlap groups copies under the newest", () => {
    const mk = (p: string, date: string): Item => ({ id: `file:${p}`, source: "workspace", kind: "file", title: p, locator: { type: "file", path: p }, snippet: "", date });
    const g = copyGroups(idx, [mk("policies/refund-policy.md", "2021-03-01"), mk("policies/refund-policy (1).md", "2021-03-01"), mk("a/README.md", "")]);
    expect(g.rep).toEqual([0, 0, 2]);
  });
});

describe("map7-v2 arrangement", () => {
  const dir = fixture();
  const idx = new Index(dir).build();
  const ws = new WorkspaceSource(() => idx, { candN: 15 });
  const item = (p: string) => { const h = idx.search([], [{ name: "f", terms: terms(p.replace(/[/._()-]/g, " ")), w: 1 }], (f) => f === p, 1, 60, "rrf")[0]; return ws.toItem(h, 300, new Set(terms("refund policy workshop booking treasurer"))); };
  test("copies collapse to the newest copy; the outdated item only follows its newer item", () => {
    const old = item("policies/refund-policy (1).md");
    const L: LedgerEntry[] = [{ item: old, kind: "rule", gist: "", round: 1, rank: 1 }];
    const e = arrangeEntries(L, [item("policies/refund-policy.md"), item("governance/2025-06-10-board-refund-decision.md")], idx, ws, 12, "LLP");
    const ids = e.map((x) => x.item.id);
    expect(ids.filter((i) => i.includes("refund-policy")).length).toBe(1); // three copies → one entry (newest: v2, 2022)
    expect(ids[0]).toBe("file:governance/2025-06-10-board-refund-decision.md"); // the newer item takes the slot
    expect(ids[1]).toBe("file:archive/refund-policy-v2.md");
    expect(e[1].olderThan).toEqual([1]);
    expect(e[0].newerThan).toEqual([2]);
    expect(e[1].copies).toBe(2);
  });
});

describe("research-v4", () => {
  test("judge prompt prefers the newest authoritative item and no longer asks for the older official one", () => {
    const p = judgePrompt("task", [{ n: 1, line: "x", earlier: false }], true);
    expect(p).not.toContain("the older one too");
    expect(p).toContain("older versions are context, not findings");
    expect(RESEARCH_CFG.version).toBe("research-v4-pi2");
  });
  test("whole-file digest of a long file reaches a matching window deep inside", () => {
    const idx = new Index(fixture()).build();
    const dg = fileDigest(idx, "exports/chat-export.md", new Set(terms("jardin communautaire ferme")));
    expect(dg).toContain("15 octobre");
  });
});
