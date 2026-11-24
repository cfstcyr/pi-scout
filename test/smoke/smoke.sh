#!/usr/bin/env bash
# pi-scout smoke test: real pi 1.6.0, scripted fake model on 127.0.0.1, fake folder, isolated agent dir, no user config,
# no network. Loads pi-scout as a package directory (`-e <dir>`, package.json manifest).
#   pi-scout/test/smoke/smoke.sh      → out/report.txt
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PKG="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/out"; rm -rf "$OUT"; mkdir -p "$OUT"
PI_FLAGS=(--no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-themes)
mkws() {
  local ws="$1"; mkdir -p "$ws/governance" "$ws/projects/booking"
  printf '# Board meeting 14 October 2025\nThe board adopts these rules for the bulletin: members never customers.\n' > "$ws/governance/2025-10-14-board-minutes.md"
  printf '# Room booking plan\nThe room booking system launches 7 April for members.\n' > "$ws/projects/booking/plan.md"
  printf '# Room booking update 2026-01-12\nThe room booking launch moves to 21 April. api_key = sk-ant-api03-FAKEFAKEFAKEFAKE0000\n' > "$ws/projects/booking/2026-01-12-update.md"
  (cd "$ws" && git init -q -b main && GIT_CONFIG_GLOBAL=/dev/null git -c user.name=t -c user.email=t@example.invalid add -A && GIT_CONFIG_GLOBAL=/dev/null git -c user.name=t -c user.email=t@example.invalid commit -qm init)
}
run() { # $1 name, $2 script, rest env
  local name="$1" script="$2"; shift 2
  local O="$OUT/$name"; mkdir -p "$O/agent"; mkws "$O/ws"
  env FAKE_SCRIPT="$script" FAKE_LOG="$O/fake.jsonl" bun "$HERE/fake-llm.ts" "$O/port" & local FPID=$!
  for i in $(seq 50); do [ -s "$O/port" ] && break; sleep 0.1; done
  (cd "$O/ws" && env "$@" PI_CODING_AGENT_DIR="$O/agent" FAKE_PORT_FILE="$O/port" SCOUT_LOG="$O/scout.jsonl" \
    timeout 120 pi "${PI_FLAGS[@]}" --session-dir "$O/session" -e "$HERE/fake-provider.ts" -e "$PKG" --model fake/scripted --mode json \
    -p "Write the member bulletin about the room booking launch for the cooperative." > "$O/stdout.jsonl" 2> "$O/stderr.txt"; echo "pi exit $?" > "$O/exit.txt")
  kill $FPID 2>/dev/null; wait $FPID 2>/dev/null
}
run same-provider tool
run no-small-model remind FAKE_NO_MINI=1
python3 "$HERE/check.py" "$OUT" | tee "$OUT/report.txt"
