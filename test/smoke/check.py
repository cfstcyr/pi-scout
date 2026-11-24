#!/usr/bin/env python3
"""Checks of the pi-scout smoke runs (smoke.sh)."""
import json, sys
from pathlib import Path
out = Path(sys.argv[1]); ok = True
def load(p):
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []
def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(f"{'PASS' if cond else 'FAIL'} {name}{(' — ' + detail) if detail else ''}")
for run in ["same-provider", "no-small-model"]:
    d = out / run; ev = load(d / "scout.jsonl"); fk = load(d / "fake.jsonl")
    names = [e["event"] for e in ev]
    print(f"[{run}] {(d / 'exit.txt').read_text().strip() if (d / 'exit.txt').exists() else 'no exit'}; events: {sorted(set(names))}")
    ss = next((e for e in ev if e["event"] == "session_start"), {})
    check(f"{run}: session_start pi-scout-0.1.0", ss.get("version") == "pi-scout-0.1.0")
    check(f"{run}: no handler/index/tool errors", not any(n in ("handler_error", "index_error", "scout_tool_error") for n in names), str([e for e in ev if e["event"].endswith("_error")])[:300])
    tools = [e for e in ev if e["event"] == "scout_tool"]
    check(f"{run}: scout tool called and answered", len(tools) >= 1)
    check(f"{run}: every model request went to the fake provider", all(str(f.get("model", "")).startswith("scripted") for f in fk), str({f.get("model") for f in fk}))
    rs = [f for f in fk if f["kind"] in ("plan", "judge")]
    if run == "same-provider":
        check(f"{run}: researcher used the same provider's small model", rs and all(f["model"] == "scripted-mini" for f in rs), str([f["model"] for f in rs]))
        done = next((e for e in ev if e["event"] == "research_done"), None)
        check(f"{run}: research_done with the update in the ledger", done and any(x["id"] == "file:projects/booking/2026-01-12-update.md" for x in done["ledger"]))
        check(f"{run}: map lists the researcher's finding", tools and any(i["from"] == "ledger" and i["id"].endswith("2026-01-12-update.md") for i in tools[0]["items"]))
        gens = [e for e in ev if e["event"] == "generate"]
        check(f"{run}: researcher model calls logged with the session's provider", gens and all(g["model"] == "fake/scripted-mini" for g in gens))
        check(f"{run}: no reminder (scout was called)", "nudge_queued" not in names)
    else:
        check(f"{run}: no researcher model call", not rs and not any(e["event"] == "generate" for e in ev))
        check(f"{run}: lexical-only notice logged once", sum(1 for e in ev if e["event"] == "notice" and "lexical-only" in e.get("text", "")) == 1)
        check(f"{run}: reminder delivered once, then the agent called scout", names.count("nudge_queued") == 1 and "nudge_delivered" in names and any(f.get("sawReminder") for f in fk))
        check(f"{run}: map says the background search is off", tools and tools[0].get("background") == "off")
    stdout = (d / "stdout.jsonl").read_text() if (d / "stdout.jsonl").exists() else ""
    check(f"{run}: planted fake secret never sent to a model nor shown to the agent", fk and not any(f.get("leak") for f in fk) and "FAKEFAKE" not in stdout)
    if run == "same-provider":
        check(f"{run}: the researcher saw the redacted digest", any(f.get("redacted") for f in rs))
print("ALL PASS" if ok else "SOME FAILED")
