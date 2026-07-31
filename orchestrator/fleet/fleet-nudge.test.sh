#!/usr/bin/env bash
set -euo pipefail

SCRIPT=$(cd "$(dirname "$0")" && pwd)/fleet-nudge.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/valid.md" <<'EOF'
# Workboard
- <!-- status: open --> **W-1 — first**
- <!-- status: done --> **ML-2 — second** — landed at `deadbee`.
- <!-- status: blocked --> **NI-3 — third**
- <!-- status: superseded --> **PR-4 — fourth**
- <!-- status: open --> **ML-GOV — fifth**
EOF

test "$("$SCRIPT" --count-open "$TMP/valid.md")" = 2

cat >"$TMP/missing.md" <<'EOF'
- **W-1 — missing status**
EOF
if "$SCRIPT" --count-open "$TMP/missing.md" >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL: missing status was accepted" >&2
  exit 1
fi
grep -q 'malformed workboard row' "$TMP/err"

cat >"$TMP/invalid.md" <<'EOF'
- <!-- status: finished --> **W-1 — invalid status**
EOF
if "$SCRIPT" --count-open "$TMP/invalid.md" >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL: invalid status was accepted" >&2
  exit 1
fi
grep -q 'malformed workboard row' "$TMP/err"

cat >"$TMP/duplicate.md" <<'EOF'
- <!-- status: open --> **W-1 — first**
- <!-- status: done --> **W-1 — duplicate**
EOF
if "$SCRIPT" --count-open "$TMP/duplicate.md" >"$TMP/out" 2>"$TMP/err"; then
  echo "FAIL: duplicate id was accepted" >&2
  exit 1
fi
grep -q 'duplicate workboard id' "$TMP/err"

printf 'fleet-nudge workboard parser: PASS\n'
