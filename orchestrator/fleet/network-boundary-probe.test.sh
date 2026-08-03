#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE_UNDER_TEST="${PROBE_UNDER_TEST:-$SCRIPT_DIR/network-boundary-probe.sh}"
SCRATCH="$(mktemp -d)"
live_dir=""
outcome_assertions=0
cleanup() {
  status=$?
  [[ -z "$live_dir" ]] || rm -rf "$live_dir"
  rm -rf "$SCRATCH"
  if [[ "$status" -eq 0 && "$outcome_assertions" -ne 4 ]]; then
    printf 'successful exit bypassed outcome assertions (%s/4)\n' "$outcome_assertions" >&2
    return 1
  fi
  return "$status"
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
  printf '1\n' >"${@: -1}"
  exit 0
fi
if "$filtered"; then
  case "${PROBE_FIXTURE_OUTCOME:?}" in
    denied) exit 28 ;;
    reachable) exit 0 ;;
    infrastructure) exit "${PROBE_FIXTURE_ARBITRARY_STATUS:-73}" ;;
    timeout) sleep 30 ;;
  esac
fi
exit 0
EOF
cat >"$SCRATCH/bin/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bin/systemctl" "$SCRATCH/bin/systemd-run" "$SCRATCH/bin/bun"

run_probe() {
  PATH="$SCRATCH/bin:$PATH" PROBE_FIXTURE_DIR="$SCRATCH" \
    PROBE_FIXTURE_OUTCOME="$1" LANE_NETWORK_PROBE_TIMEOUT_SECONDS="${2:-3}" \
    BUN_BIN="$SCRATCH/bin/bun" "$PROBE_UNDER_TEST"
}

run_probe denied 2>"$SCRATCH/denied.err"
outcome_assertions=$((outcome_assertions + 1))
printf 'outcome 28: PROCEED\n'

if run_probe reachable 2>"$SCRATCH/reachable.err"; then
  printf 'probe accepted a reachable filtered leg\n' >&2; exit 1
fi
grep -Fq 'serialized but not enforced' "$SCRATCH/reachable.err"
outcome_assertions=$((outcome_assertions + 1))
printf 'outcome 0: REFUSE\n'

if run_probe infrastructure 2>"$SCRATCH/infrastructure.err"; then
  printf 'probe accepted an infrastructure failure as denial\n' >&2; exit 1
fi
grep -Fq 'exit=73); probe is inconclusive' "$SCRATCH/infrastructure.err"
outcome_assertions=$((outcome_assertions + 1))
printf 'outcome 73: REFUSE\n'

if run_probe timeout 1 2>"$SCRATCH/timeout.err"; then
  printf 'probe accepted a timed-out filtered leg as denial\n' >&2; exit 1
fi
grep -Fq 'timed out; probe is inconclusive' "$SCRATCH/timeout.err"
outcome_assertions=$((outcome_assertions + 1))
printf 'outcome 124: REFUSE\n'

# The installed service identity is the affected boundary. Run the production
# probe with the real user manager after the deterministic outcome matrix, so a
# live-environment failure can never bypass those assertions.
service_config="$SCRIPT_DIR/../../instance/lane-service-user.conf"
# shellcheck disable=SC1090
source "$service_config"
live_dir="$(mktemp -d /tmp/lane-network-live.XXXXXX)"
cp "$PROBE_UNDER_TEST" "$live_dir/probe.sh"
chmod 755 "$live_dir" "$live_dir/probe.sh"
live_bun="$(command -v bun)"
if [[ "$EUID" -eq 0 ]]; then
  live_bun="$LANE_SERVICE_HOME/.bun/bin/bun"
  [[ -x "$live_bun" ]] || live_bun=/usr/local/bin/bun
  if /usr/sbin/runuser -u "$LANE_SERVICE_USER" -- env \
    HOME="$LANE_SERVICE_HOME" XDG_RUNTIME_DIR="/run/user/$(id -u "$LANE_SERVICE_USER")" \
    TMPDIR=/tmp PATH=/usr/local/bin:/usr/bin:/bin BUN_BIN="$live_bun" \
    LANE_NETWORK_PROBE_TIMEOUT_SECONDS=10 bash "$live_dir/probe.sh" \
    2>"$SCRATCH/live.err"; then
    printf 'live service-user probe unexpectedly accepted kernel enforcement\n' >&2; exit 1
  fi
else
  if env TMPDIR=/tmp BUN_BIN="$live_bun" LANE_NETWORK_PROBE_TIMEOUT_SECONDS=10 \
    bash "$live_dir/probe.sh" 2>"$SCRATCH/live.err"; then
    printf 'live service-user probe unexpectedly accepted kernel enforcement\n' >&2; exit 1
  fi
fi
grep -Fq 'IPAddressDeny=localhost is serialized but not enforced by the user manager' "$SCRATCH/live.err"
rm -rf "$live_dir"
live_dir=""
printf 'live service-user plain leg: EXECUTED; filtered leg: REFUSED\n'

printf 'lane network boundary outcome proof: PASS\n'
