#!/usr/bin/env bash
# Prove that the user manager enforces the loopback IPAddressDeny boundary.
set -euo pipefail

die() { printf 'lane-network-capability-blocker: %s\n' "$*" >&2; exit 1; }

bun_bin="${BUN_BIN:-$(command -v bun || true)}"
[[ -x "$bun_bin" ]] || die 'Bun is unavailable for the network capability probe'
command -v systemd-run >/dev/null || die 'systemd-run is unavailable'
command -v timeout >/dev/null || die 'timeout is unavailable'
probe_timeout="${LANE_NETWORK_PROBE_TIMEOUT_SECONDS:-10}"
[[ "$probe_timeout" =~ ^[1-9][0-9]*$ ]] || die 'probe timeout must be a positive integer'

probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/lane-network-probe.XXXXXX")"
unit_base="lane-network-probe-$UID-$$"
listener_unit="$unit_base-listener"
cleanup() {
  timeout "${probe_timeout}s" systemctl --user stop "$listener_unit" >/dev/null 2>&1 || true
  rm -rf -- "$probe_dir"
}
trap cleanup EXIT

timeout "${probe_timeout}s" systemd-run --user --quiet --collect --unit "$listener_unit" "$bun_bin" -e '
  const marker = process.argv[1];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return new Response("lane-boundary-proof"); } });
  await Bun.write(marker, String(server.port));
  await new Promise(() => {});
' "$probe_dir/port" || die 'disposable listener unit could not start'
for _ in {1..100}; do
  [[ -s "$probe_dir/port" ]] && break
  sleep 0.02
done
[[ -s "$probe_dir/port" ]] || die 'disposable listener did not publish a port'
port="$(<"$probe_dir/port")"
url="http://127.0.0.1:$port/"
client='try { const r=await fetch(process.argv[1]); process.exit((await r.text()) === "lane-boundary-proof" ? 0 : 29); } catch { process.exit(28); }'

# Both sides are mandatory: first prove the target is live and reachable from an
# otherwise identical transient unit, then apply the boundary.
set +e
timeout "${probe_timeout}s" systemd-run --user --wait --quiet --collect --unit "$unit_base-plain" \
  "$bun_bin" -e "$client" "$url" >/dev/null 2>&1
plain_status=$?
set -e
[[ "$plain_status" -eq 0 ]] || die "plain user unit could not reach the disposable loopback listener (exit=$plain_status)"
set +e
timeout "${probe_timeout}s" systemd-run --user --wait --quiet --collect --unit "$unit_base-filtered" \
  --property=IPAddressDeny=localhost --property=IPAddressAllow=127.0.0.53 \
  "$bun_bin" -e "$client" "$url" >/dev/null 2>&1
filtered_status=$?
set -e
case "$filtered_status" in
  28) ;; # The client ran and its loopback connection was denied.
  0) die 'IPAddressDeny=localhost is serialized but not enforced by the user manager' ;;
  124) die 'filtered user unit timed out; probe is inconclusive' ;;
  *) die "filtered user unit failed without proving network denial (exit=$filtered_status); probe is inconclusive" ;;
esac
systemctl --user is-active --quiet "$listener_unit" || die 'listener vanished during the filtered check'
"$bun_bin" -e "$client" "$url" >/dev/null 2>&1 ||
  die 'listener became unreachable after the filtered check'
