#!/usr/bin/env bash
set -euo pipefail

# Deterministic, read-only comparison gate. Missing or failing side is NO-GO.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$root/migration-prep/differential-replay-evidence.json}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
reference_status=NO_GO
contour_status=NO_GO
if command -v bun >/dev/null 2>&1 && bun test "$root/migration-prep/reference-daemon/templates/daemon/server.test.ts" "$root/migration-prep/reference-daemon/templates/daemon/relay.test.ts" >"$tmp/reference.log" 2>&1; then reference_status=PASS; fi
if command -v python >/dev/null 2>&1 && python -m pytest -q "$root/contour" >"$tmp/contour.log" 2>&1; then contour_status=PASS; fi
python - "$out" "$reference_status" "$contour_status" "$tmp/reference.log" "$tmp/contour.log" <<'PY'
import json, pathlib, sys
out, ref, contour, ref_log, contour_log = sys.argv[1:]
payload = {"fixture":"baseline-start-reply-restart", "reference_sha":"4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa", "reference_tests":ref, "contour_tests":contour, "comparison":"PASS" if ref == contour == "PASS" else "NO-GO", "logs":{"reference":pathlib.Path(ref_log).read_text(), "contour":pathlib.Path(contour_log).read_text()}}
pathlib.Path(out).write_text(json.dumps(payload, indent=2) + "\n")
if payload["comparison"] != "PASS": raise SystemExit("differential replay NO-GO")
PY
printf 'differential replay PASS: %s\n' "$out"
