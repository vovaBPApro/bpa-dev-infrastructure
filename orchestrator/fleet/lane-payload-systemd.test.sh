#!/usr/bin/env bash
# Regression lock for V3-0.44 r2: the lane payload's argv and pipeline status
# must survive systemd, not merely survive bash.
#
# This lock has to cross a boundary. orchestrator/fleet/launch-lane.test.sh
# stubs `systemd-run` with a shell script that ends in `exec "$@"`, so in that
# fixture `${10}` and `${PIPESTATUS[@]}` are expanded by bash and everything
# looks correct. The real defect lived in systemd's expansion of the ExecStart
# line, one layer above -- which is exactly why a landed fix (V3-0.44 round 1)
# and a full green suite both missed it, and why a unit test of the launcher in
# isolation can never catch it. So this file launches through a REAL
# `systemd-run` and asserts what the payload actually received.
#
# The IPAddressDeny/IPAddressAllow properties that launch-lane.sh sets are
# deliberately omitted here: they need a BPF-capable systemd, they are
# irrelevant to argv delivery, and making the lock depend on them would turn an
# unrelated container limitation into a red. The static half of the contract --
# that the launcher builds an ExecStart with no shell body and no `${...}` in
# it -- is locked in launch-lane.test.sh, which needs no systemd at all.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$SCRIPT_DIR/lane-payload.sh"
SCRATCH="$(mktemp -d)"
# NOT `lane-payload-probe-$$`, which is what this was: `lane-*` is the glob the
# fleet census and the daemon's completion channel read as "a live lane", so
# these six transient units were counted as lanes and reported as lanes
# finishing (workboard V3-5.19). The name is built by the shared helper, which
# refuses any name inside that namespace -- see its header for why a distinct
# namespace was chosen over an exclusion in the census.
# shellcheck source=orchestrator/fleet/probe-unit-namespace.sh
. "$SCRIPT_DIR/probe-unit-namespace.sh"
UNIT_TAG="$(probe_unit_name payload "$$")" || exit 1
cleanup() {
  # --collect reaps a completed transient unit, but a unit that failed to start
  # can linger; never leave residue behind.
  for suffix in probe inline escaped role crash masker; do
    systemctl reset-failed "$UNIT_TAG-$suffix" >/dev/null 2>&1 || true
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

capability_forced_missing() {
  [[ ",${INFRA_TEST_FORCE_MISSING_CAPABILITIES:-}," == *",$1,"* ]]
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

# Skip loudly and by name, never silently. The EXCLUDED lines below are pinned
# in instance/expected-shell-capability-exclusions.tsv and reproduced by
# tools/shell-test-tier.test.ts, so this test cannot quietly stop asserting:
# if it skipped without saying so, or named a different case, that inventory
# check goes red.
systemd_usable=true
if capability_forced_missing systemd-transient-unit; then
  systemd_usable=false
elif ! command -v systemd-run >/dev/null 2>&1; then
  systemd_usable=false
elif ! timeout 60 systemd-run --collect --wait --quiet --unit "$UNIT_TAG-probe" \
  /bin/true >/dev/null 2>&1; then
  systemd_usable=false
fi

if ! "$systemd_usable"; then
  printf '%s\n' 'lane-payload-systemd: EXCLUDED case=systemd-eats-braced-expansions capability=systemd-transient-unit'
  printf '%s\n' 'lane-payload-systemd: EXCLUDED case=role-across-systemd capability=systemd-transient-unit'
  printf '%s\n' 'lane-payload-systemd: EXCLUDED case=pipestatus-across-systemd capability=systemd-transient-unit'
  printf 'lane payload systemd boundary: SKIPPED capability=systemd-transient-unit\n'
  exit 0
fi

run_unit() {
  local suffix="$1"; shift
  systemctl reset-failed "$UNIT_TAG-$suffix" >/dev/null 2>&1 || true
  local rc=0
  timeout 120 systemd-run --collect --wait --quiet --unit "$UNIT_TAG-$suffix" \
    --setenv="HOME=$HOME" --setenv="LANE_REPORT_PATH=$SCRATCH/report.md" \
    --working-directory="$SCRATCH" "$@" >/dev/null 2>&1 || rc=$?
  printf '%s' "$rc"
}

# ---------------------------------------------------------------------------
# Red proof: the defect mechanism itself, observed rather than assumed.
#
# This is the pre-fix shape -- the shell body inline in the ExecStart line --
# and it must still LOSE the tenth argument and PIPESTATUS. If this case ever
# goes green, systemd changed its expansion behaviour and the two assertions
# below stopped discriminating; that must surface as a failure here rather than
# as a lock that silently proves nothing.
# ---------------------------------------------------------------------------
rm -f "$SCRATCH/inline.out"
# The output path travels as `$1` -- an unbraced, single-digit parameter, the
# one form systemd leaves alone -- because a braced `${...}` reference to it
# would be eaten by the very defect this probe is measuring.
run_unit inline /bin/bash -c '
  printf "nine=[%s] ten=[%s] pipestatus=[%s]\n" "$9" "${10}" "${PIPESTATUS[@]}" >"$1"
' _ "$SCRATCH/inline.out" a2 a3 a4 a5 a6 a7 a8 NINE TEN >/dev/null || true
[[ -f "$SCRATCH/inline.out" ]] || fail 'inline red proof produced no output at all'
inline_observed="$(cat "$SCRATCH/inline.out")"
[[ "$inline_observed" == 'nine=[NINE] ten=[] pipestatus=[]' ]] || fail \
  "inline red proof no longer reproduces the defect: $inline_observed"
printf '%s\n' 'lane-payload-systemd: RAN case=systemd-eats-braced-expansions'

# The `$${...}` escape is a real systemd mechanism and lane-payload.sh's header
# claims it works. Prove that claim here rather than leaving it as an assertion
# in a comment -- getting this subtly wrong is what produced the defect.
rm -f "$SCRATCH/escaped.out"
run_unit escaped /bin/bash -c '
  printf "ten=[%s]\n" "$${10}" >"$1"
' _ "$SCRATCH/escaped.out" a2 a3 a4 a5 a6 a7 a8 NINE TEN >/dev/null || true
[[ -f "$SCRATCH/escaped.out" ]] || fail 'escaped probe produced no output'
grep -Fxq 'ten=[TEN]' "$SCRATCH/escaped.out" || fail \
  "\$\${10} did not survive systemd: $(cat "$SCRATCH/escaped.out")"

# ---------------------------------------------------------------------------
# Fixture: the payload's real collaborators, reduced to recorders.
# ---------------------------------------------------------------------------
mkdir -p "$SCRATCH/worktree"
printf 'lane prompt body\n' >"$SCRATCH/prompt.md"

cat >"$SCRATCH/gate" <<'EOF'
#!/usr/bin/env bash
# Stands in for gate/lane-exit.sh and records exactly what it was handed.
printf '%s\n' "$@" >"$GATE_ARGV"
exit 0
EOF

cat >"$SCRATCH/bun" <<'EOF'
#!/usr/bin/env bash
# Stands in for `bun daemon/mask-stream.ts`: argv is the masker path.
if [[ "${MASKER_MUST_FAIL:-}" == 1 ]]; then cat >/dev/null; exit 9; fi
shift
cat
EOF

cat >"$SCRATCH/agent-ok" <<'EOF'
#!/usr/bin/env bash
printf 'agent ran\n'
EOF

cat >"$SCRATCH/agent-crash" <<'EOF'
#!/usr/bin/env bash
printf 'agent about to die\n'
exit 17
EOF
chmod +x "$SCRATCH/gate" "$SCRATCH/bun" "$SCRATCH/agent-ok" "$SCRATCH/agent-crash"

payload_argv() {
  # PROMPT BUN MASKER LOG REPORT STATUS GATE REPO BRANCH ROLE AGENT...
  printf '%s\0' "$SCRATCH/prompt.md" "$SCRATCH/bun" "$SCRATCH/masker.ts" \
    "$SCRATCH/lane.log" "$SCRATCH/report.md" "$SCRATCH/lane.status" \
    "$SCRATCH/gate" "$SCRATCH/worktree" "ag-payload-probe" "$1" "$2"
}

# ---------------------------------------------------------------------------
# Case: the role -- the tenth parameter, the one systemd ate -- reaches the gate
# non-empty and with its real value.
# ---------------------------------------------------------------------------
rm -f "$SCRATCH/lane.status" "$SCRATCH/gate.argv" "$SCRATCH/lane.log"
mapfile -d '' -t argv < <(payload_argv reviewer "$SCRATCH/agent-ok")
rc="$(run_unit role --setenv="GATE_ARGV=$SCRATCH/gate.argv" \
  /bin/bash "$PAYLOAD" "${argv[@]}")"
[[ "$rc" == 0 ]] || fail "payload exited $rc on the happy path; log: $(cat "$SCRATCH/lane.log" 2>/dev/null)"
[[ -f "$SCRATCH/gate.argv" ]] || fail 'the exit gate was never invoked'

# The precise regression: `--role` present, and its value neither empty nor
# defaulted. `reviewer` is used rather than `coder` so that a silently dropped
# role cannot be mistaken for a correct one -- lane-exit.sh defaults to `coder`.
grep -Fxq -- '--role' "$SCRATCH/gate.argv" || fail 'the gate received no --role flag'
role_value="$(grep -A1 -Fx -- '--role' "$SCRATCH/gate.argv" | tail -n1)"
[[ -n "$role_value" ]] || fail 'the gate received an EMPTY role -- systemd ate the tenth argument'
[[ "$role_value" == reviewer ]] || fail "the gate received role '$role_value', expected 'reviewer'"
grep -Fxq 'state: terminal' "$SCRATCH/lane.status" || fail \
  "expected terminal state, got: $(cat "$SCRATCH/lane.status")"
printf '%s\n' 'lane-payload-systemd: RAN case=role-across-systemd'

# ---------------------------------------------------------------------------
# Case: PIPESTATUS survives, so the crashed-agent and failed-masker checks are
# actually armed. Empty PIPESTATUS did not fail loudly -- it made
# `((agent_status != 0))` a no-op, disabling both checks in silence.
# ---------------------------------------------------------------------------
rm -f "$SCRATCH/lane.status" "$SCRATCH/gate.argv" "$SCRATCH/lane.log"
mapfile -d '' -t argv < <(payload_argv coder "$SCRATCH/agent-crash")
rc="$(run_unit crash --setenv="GATE_ARGV=$SCRATCH/gate.argv" \
  /bin/bash "$PAYLOAD" "${argv[@]}")"
[[ "$rc" == 17 ]] || fail "crashed agent surfaced exit $rc, expected 17"
grep -Fxq 'reason: payload-exit' "$SCRATCH/lane.status" || fail \
  "a crashed agent was not reported as payload-exit: $(cat "$SCRATCH/lane.status")"
grep -Fxq 'exit: 17' "$SCRATCH/lane.status" || fail \
  "payload-exit lost the agent's exit code: $(cat "$SCRATCH/lane.status")"
[[ ! -f "$SCRATCH/gate.argv" ]] || fail 'the exit gate ran despite a crashed agent'

rm -f "$SCRATCH/lane.status" "$SCRATCH/gate.argv" "$SCRATCH/lane.log"
mapfile -d '' -t argv < <(payload_argv coder "$SCRATCH/agent-ok")
rc="$(run_unit masker --setenv="GATE_ARGV=$SCRATCH/gate.argv" --setenv=MASKER_MUST_FAIL=1 \
  /bin/bash "$PAYLOAD" "${argv[@]}")"
[[ "$rc" == 9 ]] || fail "failed masker surfaced exit $rc, expected 9"
grep -Fxq 'reason: log-masker-exit' "$SCRATCH/lane.status" || fail \
  "a failed masker was not reported as log-masker-exit: $(cat "$SCRATCH/lane.status")"
grep -Fxq 'exit: 9' "$SCRATCH/lane.status" || fail \
  "log-masker-exit lost the masker's exit code: $(cat "$SCRATCH/lane.status")"
[[ ! -f "$SCRATCH/gate.argv" ]] || fail 'the exit gate ran despite a failed masker'
printf '%s\n' 'lane-payload-systemd: RAN case=pipestatus-across-systemd'

printf 'lane payload systemd boundary: PASS\n'
