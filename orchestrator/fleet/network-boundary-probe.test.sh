#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="$(mktemp -d)"
cleanup() {
  [[ -s "$SCRATCH/listener.pid" ]] && kill "$(<"$SCRATCH/listener.pid")" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT
mkdir "$SCRATCH/bin"

cat >"$SCRATCH/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$SCRATCH/bin/systemd-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
filtered=false
listener=false
while (($#)); do
  case "$1" in
    --user|--wait|--quiet|--collect) shift ;;
    --unit) [[ "$2" == *-listener ]] && listener=true; shift 2 ;;
    --property=IPAddressDeny=localhost) filtered=true; shift ;;
    --property=*) shift ;;
    *) break ;;
  esac
done
if "$listener"; then
  setsid -f bash -c 'printf "%s\n" "$$" >"$1"; shift; exec "$@"' \
    _ "$PROBE_FIXTURE_DIR/listener.pid" "$@"
  exit 0
fi
if "$filtered"; then
  case "${PROBE_FIXTURE_OUTCOME:?}" in
    denied)
      # Execute the real client against a closed loopback endpoint. This proves
      # exit 28 means a real failed connection, while the live-manager check
      # covers the IPAddressDeny mechanism itself.
      args=("$@")
      args[$((${#args[@]} - 1))]=http://127.0.0.1:1/
      exec "${args[@]}"
      ;;
    reachable) exec "$@" ;;
    infrastructure) exit 73 ;;
    timeout) sleep 30 ;;
  esac
fi
exec "$@"
EOF
chmod +x "$SCRATCH/bin/systemctl" "$SCRATCH/bin/systemd-run"

run_probe() {
  PATH="$SCRATCH/bin:$PATH" PROBE_FIXTURE_DIR="$SCRATCH" \
    PROBE_FIXTURE_OUTCOME="$1" LANE_NETWORK_PROBE_TIMEOUT_SECONDS="${2:-3}" \
    BUN_BIN="$(command -v bun)" "$SCRIPT_DIR/network-boundary-probe.sh"
}

if ! run_probe denied 2>"$SCRATCH/socket.err"; then
  if grep -Fq 'plain user unit could not reach the disposable loopback listener' "$SCRATCH/socket.err"; then
    printf 'plain loopback socket leg is unavailable; kernel enforcement remains unproven here\n'
    printf 'EXCLUDED case=kernel-filter-enforcement capability=user-manager-cgroup-bpf\n'
    exit 0
  fi
  cat "$SCRATCH/socket.err" >&2
  exit 1
fi
printf 'denied: PASS (real client connection denied)\n'

if run_probe reachable 2>"$SCRATCH/reachable.err"; then
  printf 'probe accepted a reachable filtered leg\n' >&2; exit 1
fi
grep -Fq 'serialized but not enforced' "$SCRATCH/reachable.err"
printf 'reachable: REFUSED\n'

if run_probe infrastructure 2>"$SCRATCH/infrastructure.err"; then
  printf 'probe accepted an infrastructure failure as denial\n' >&2; exit 1
fi
grep -Fq 'exit=73); probe is inconclusive' "$SCRATCH/infrastructure.err"
printf 'inconclusive/infrastructure: REFUSED\n'

if run_probe timeout 1 2>"$SCRATCH/timeout.err"; then
  printf 'probe accepted a timed-out filtered leg as denial\n' >&2; exit 1
fi
grep -Fq 'timed out; probe is inconclusive' "$SCRATCH/timeout.err"
printf 'inconclusive/timeout: REFUSED\n'

printf 'lane network boundary outcome proof: PASS\n'
