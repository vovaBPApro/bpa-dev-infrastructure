#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir "$SCRATCH/bin"
cat >"$SCRATCH/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *Bun.serve* ]]; then
  marker="${!#}"
  printf '43123' >"$marker"
  exec sleep 300
fi
exit 0
EOF
cat >"$SCRATCH/bin/systemctl" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$SCRATCH/bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
filtered=false
unit=
while (($#)); do
  case "$1" in
    --user|--wait|--quiet|--collect) shift ;;
    --unit) unit="$2"; shift 2 ;;
    --property=IPAddressDeny=localhost) filtered=true; shift ;;
    --property=*) shift ;;
    *) break ;;
  esac
done
if [[ "$unit" == *-listener ]]; then
  "$@" >/dev/null 2>&1 &
  exit 0
fi
if "$filtered" && [[ "${MOCK_ENFORCE:-}" == 1 ]]; then
  exit 1
fi
exec "$@"
EOF
chmod +x "$SCRATCH/bin/bun" "$SCRATCH/bin/systemd-run" "$SCRATCH/bin/systemctl"

# Enforced boundary: plain reaches the real listener and filtered is denied.
PATH="$SCRATCH/bin:$PATH" MOCK_ENFORCE=1 BUN_BIN="$SCRATCH/bin/bun" \
  "$SCRIPT_DIR/network-boundary-probe.sh"

# Silent systemd failure: both units reach the listener, so the probe must
# refuse. This is the production false-green that the regression locks.
if PATH="$SCRATCH/bin:$PATH" MOCK_ENFORCE=0 BUN_BIN="$SCRATCH/bin/bun" \
  "$SCRIPT_DIR/network-boundary-probe.sh" 2>"$SCRATCH/silent.err"; then
  printf 'probe accepted an unenforced IPAddressDeny boundary\n' >&2
  exit 1
fi
grep -Fq 'serialized but not enforced' "$SCRATCH/silent.err"

printf 'lane network boundary two-sided proof: PASS\n'
