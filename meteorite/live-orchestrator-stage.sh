#!/usr/bin/env bash
# Start the orchestrator on the rebuilt machine and prove it reached a live
# state. This is the meteorite's `orchestrator-live` stage; it runs INSIDE the
# container, against the tree bootstrap/install.sh just installed.
#
# WHY THIS EXISTS. Until now the meteorite ended at "install succeeded and the
# suite passed", i.e. it proved the FILES copied across. On 2026-08-04 the
# orchestrator could not start from the repository at all -- `preflight-cli-auth.sh`
# was absent from HEAD and `mission-cli` implemented neither `reap` nor `lease` --
# while the meteorite stayed green through both
# (instance/incidents/2026-08-04-orchestrator-launcher-unstartable-from-git.md,
# "the meteorite proof can stay green through exactly this failure again").
# Starting the thing is the only assertion that closes that class.
#
# WHAT LIVENESS MEANS HERE, AND WHERE IT STOPS. A rebuilt container has no
# provider credentials and no provider CLI, so "a live LLM session" is not
# observable in it and claiming it would be a lie. What IS observable is the
# tracked launch path itself: singleton handoff, startup handshake, the in-pane
# liveness pulse renewing its stamp, and a clean teardown. That is what this
# stage asserts, and every boundary it does not cross is named in `unproven=` on
# its own evidence line and carried into the run's JSON artifact. The provider
# binary is a declared stand-in (`substitutions=provider`) -- meteorite/run.sh
# refuses a PASS for any evidence line whose substitution set is larger, so a
# fixture cannot quietly stub the launcher's mechanisms into a green rebuild.
#
# The assertion half is reachable on its own (`--assert-liveness`), so a host
# test can drive it against a fabricated runtime directory without a container.
#
# Usage:
#   meteorite/live-orchestrator-stage.sh
#   meteorite/live-orchestrator-stage.sh --assert-liveness <runtime-dir> <interval-s> [<deadline-s>]
#
# Environment (all defaulted for the container; overridden only by tests):
#   METEORITE_LIVE_INSTALL_ROOT   installed checkout            (/work/install)
#   METEORITE_LIVE_RUNTIME_DIR    launcher runtime dir          ($INSTALL_ROOT/../runtime/orchestrator)
#   METEORITE_LIVE_STATE_DB       durable state database        ($INSTALL_ROOT/../runtime/state.db)
#   METEORITE_LIVE_PROVIDER       provider branch to launch     (claude)
#   METEORITE_LIVE_SESSION        tmux session name             (meteorite-orchestrator)
#   METEORITE_LIVE_PULSE_INTERVAL liveness pulse seconds        (5, the knob floor)
set -euo pipefail

install_root="${METEORITE_LIVE_INSTALL_ROOT:-/work/install}"
default_runtime_parent="$(dirname "$install_root")/runtime"
runtime_dir="${METEORITE_LIVE_RUNTIME_DIR:-$default_runtime_parent/orchestrator}"
state_db="${METEORITE_LIVE_STATE_DB:-$default_runtime_parent/state.db}"
provider="${METEORITE_LIVE_PROVIDER:-claude}"
session="${METEORITE_LIVE_SESSION:-meteorite-orchestrator}"
pulse_interval="${METEORITE_LIVE_PULSE_INTERVAL:-5}"
start_timeout="${METEORITE_LIVE_START_TIMEOUT:-180}"

# Every mechanism the launcher would refuse to start without. A knob that
# arrives already set REPLACES one of them, so it is recorded as a substitution
# rather than trusted: this list is what stops a fixture-shaped environment from
# producing a green rebuild proof. It is derived from what is actually set in the
# environment, never self-declared by the caller.
guarded_knobs=(
  ORCH_AUTH_PREFLIGHT
  ORCH_MISSION_CLI
  ORCH_CONFIG_FILE
  ORCH_SESSION_HOOK
  ORCH_CODEX_SESSION_HOOK
  ORCH_SKIP_SESSION_HOOK
  ORCH_CLAUDE_STOP_RELAY
  ORCH_TURNEND_RELAY
  ORCH_LIVENESS_PULSE
  ORCH_SKIP_TRUST_CHECK
  ORCH_TERMINAL_ALERT
)

# What a container run structurally cannot prove, stated rather than implied
# away. `cgroup-isolation`: the container has no systemd, so the tmux server has
# no scope to land in and ORCH_TMUX_ISOLATION=none is the only runnable mode --
# placement has its own live rehearsal in orchestrator/tmux-isolation.test.sh.
# `provider-session`: no credentials, so the provider is a stand-in and no turn
# is ever taken. `telegram-transport`: no token, no daemon, no authenticated
# channel. `watchdog-supervision`: nothing arms the watchdog timer here.
unproven="cgroup-isolation,provider-session,telegram-transport,watchdog-supervision"

fail() {
  printf 'METEORITE-LIVENESS proven=no reason=%s\n' "$1"
  printf '[live-orchestrator] NO-GO %s: %s\n' "$1" "${2:-$1}" >&2
  exit 1
}

# ── The assertion, reachable on its own ────────────────────────────────────
#
# Reads only durable evidence the launch path leaves behind, never the
# launcher's exit status: a launcher that returns 0 over a dead pane is exactly
# the failure this stage exists to catch.
#
# Prints `LIVENESS-ASSERT ok pid=<n> first=<epoch> last=<epoch>` on success and
# `LIVENESS-ASSERT fail reason=<token>` otherwise. The measurements travel on
# that line rather than in variables, because the caller reads it through a
# command substitution and a subshell cannot hand variables back.
assert_liveness() {
  local dir="$1" interval="$2" deadline_seconds="${3:-}"
  local startup="$dir/orchestrator.startup"
  local stamp="$dir/orchestrator.liveness"
  local identity="$stamp.identity"
  local pid first last deadline

  if [[ ! -f "$startup" ]]; then
    printf 'LIVENESS-ASSERT fail reason=startup-handshake-missing\n'
    return 1
  fi
  if [[ ! -f "$identity" ]]; then
    printf 'LIVENESS-ASSERT fail reason=provider-identity-missing\n'
    return 1
  fi
  pid="$(sed -n 's/^pid=//p' "$identity" | head -n 1)"
  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    printf 'LIVENESS-ASSERT fail reason=provider-identity-malformed\n'
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    printf 'LIVENESS-ASSERT fail reason=provider-not-running\n'
    return 1
  fi
  if [[ ! -f "$stamp" ]]; then
    printf 'LIVENESS-ASSERT fail reason=liveness-stamp-missing\n'
    return 1
  fi
  first="$(head -n 1 "$stamp")"
  if ! [[ "$first" =~ ^[1-9][0-9]*$ ]]; then
    printf 'LIVENESS-ASSERT fail reason=liveness-stamp-malformed\n'
    return 1
  fi

  # A stamp that merely EXISTS proves only that the launcher seeded it before
  # returning (launch.sh does exactly that). Renewal is the property worth
  # asserting: it can only come from the pulse loop running inside the
  # supervised pane, which dies with the process it vouches for.
  [[ -n "$deadline_seconds" ]] || deadline_seconds=$(( interval * 3 + 10 ))
  deadline=$(( SECONDS + deadline_seconds ))
  last="$first"
  while (( SECONDS < deadline )); do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then
      printf 'LIVENESS-ASSERT fail reason=provider-died-during-observation\n'
      return 1
    fi
    last="$(head -n 1 "$stamp" 2>/dev/null || printf '')"
    [[ "$last" =~ ^[1-9][0-9]*$ ]] || continue
    if (( last > first )); then
      printf 'LIVENESS-ASSERT ok pid=%s first=%s last=%s\n' "$pid" "$first" "$last"
      return 0
    fi
  done
  printf 'LIVENESS-ASSERT fail reason=liveness-stamp-not-advancing\n'
  return 1
}

if [[ "${1:-}" == "--assert-liveness" ]]; then
  if (($# < 3)); then
    printf 'ERROR: --assert-liveness requires <runtime-dir> <interval-s> [<deadline-s>]\n' >&2
    exit 2
  fi
  assert_liveness "$2" "$3" "${4:-}"
  exit $?
fi
if (($#)); then
  printf 'ERROR: unknown argument: %s\n' "$1" >&2
  exit 2
fi

# ── The stage ──────────────────────────────────────────────────────────────

launcher="$install_root/orchestrator/launch.sh"
[[ -f "$launcher" ]] || fail launcher-missing "no launcher at $launcher"

# The state database is REQUIRED, not incidental. launch.sh's lease/reap branch
# is guarded by `state_available()`, so a run without a database skips it -- and
# that branch is precisely where the 2026-08-04 launcher regression lived,
# "armed by ordinary successful work" once lane activity created the file.
# bootstrap/install.sh creates it (initialize_state_db), so its absence here
# means the rebuild did not complete, and starting anyway would prove the one
# configuration a real host never runs in.
[[ -f "$state_db" ]] || fail state-db-missing "no state database at $state_db"

substitutions=(provider)
for knob in "${guarded_knobs[@]}"; do
  # `-v` on a name held in a variable: set-but-empty counts, because an empty
  # ORCH_SKIP_TRUST_CHECK is still a caller reaching into the launcher.
  if [[ -v "$knob" ]]; then
    substitutions+=("$(printf '%s' "${knob#ORCH_}" | tr '[:upper:]_' '[:lower:]-')")
  fi
done

scratch="$(mktemp -d)"
started=0
teardown_state="not-attempted"

# One place where the launcher's environment is decided, so a teardown can never
# talk to a differently configured launcher than the start did.
#
# TELEGRAM_BOUND_CHAT_ID is CLEARED rather than merely left unset: launch.sh
# derives a per-chat instance lock from it ($HOME/.claude/orchestrator-chat-*),
# so a proof that inherited an operator's chat id would reach into a LIVE
# orchestrator's lock file. A rebuilt machine binds no channel, which is the
# `telegram-transport` boundary on the evidence line.
#
# ORCH_TMUX_ISOLATION=none is the only runnable mode in a container: the cgroup
# scope needs systemd, which no container payload has. It disables the placement
# check, so `cgroup-isolation` is declared unproven here and is proven instead by
# the live daemon-restart rehearsal in orchestrator/tmux-isolation.test.sh.
run_launcher() {
  env PATH="$scratch/bin:$PATH" \
    TELEGRAM_BOUND_CHAT_ID= \
    TELEGRAM_CHAT_ID= \
    ORCH_PROVIDER="$provider" \
    ORCH_SESSION="$session" \
    ORCH_WORK_DIR="$install_root" \
    ORCH_RUNTIME_DIR="$runtime_dir" \
    ORCH_STATE_DB="$state_db" \
    ORCH_LIVENESS_PULSE_INTERVAL="$pulse_interval" \
    ORCH_TMUX_ISOLATION=none \
    timeout "$start_timeout" bash "$launcher" "$@"
}

cleanup() {
  local status=$?
  if ((started)); then
    run_launcher stop >/dev/null 2>&1 || true
  fi
  rm -rf "$scratch"
  return "$status"
}
trap cleanup EXIT

# The provider stand-in. The container has neither the CLI nor a credential, so
# this is the one substitution the environment forces; it is declared on the
# evidence line and it is deliberately inert -- it takes no turn, reads no
# prompt, and answers nothing. Everything the launcher wires AROUND it (settings
# file, MCP config, session hook, stop relay, singleton handoff, liveness pulse)
# is the tracked mechanism, unmodified.
mkdir -p "$scratch/bin"
cat > "$scratch/bin/$provider" <<'STANDIN'
#!/usr/bin/env bash
# Meteorite provider stand-in: no credentials exist in a rebuilt container.
# Holds the pane open under the launcher's own supervision and nothing else.
exec sleep 3600
STANDIN
chmod +x "$scratch/bin/$provider"

printf '[live-orchestrator] starting %s in session %s (install=%s)\n' \
  "$provider" "$session" "$install_root" >&2

start_status=0
run_launcher start >&2 || start_status=$?
if ((start_status != 0)); then
  if ((start_status == 124)); then
    fail launch-timeout "launch.sh start did not return within ${start_timeout}s"
  fi
  fail launch-refused "launch.sh start exited $start_status"
fi
started=1

if ! run_launcher status >&2; then
  fail session-not-running "launch.sh status does not report a running session"
fi

assert_output=""
if ! assert_output="$(assert_liveness "$runtime_dir" "$pulse_interval")"; then
  printf '%s\n' "$assert_output" >&2
  fail "$(printf '%s' "$assert_output" | sed -n 's/.*reason=//p')" "$assert_output"
fi
printf '%s\n' "$assert_output" >&2
liveness_pid="$(printf '%s' "$assert_output" | sed -n 's/.* pid=\([0-9]*\) .*/\1/p')"
liveness_first="$(printf '%s' "$assert_output" | sed -n 's/.* first=\([0-9]*\) .*/\1/p')"
liveness_last="$(printf '%s' "$assert_output" | sed -n 's/.* last=\([0-9]*\)$/\1/p')"

# Teardown is part of the proof, not housekeeping: a rebuilt host that can start
# an orchestrator it cannot stop has not proven the lifecycle.
if run_launcher stop >&2; then
  started=0
  if run_launcher status >/dev/null 2>&1; then
    teardown_state="session-survived-stop"
  else
    teardown_state="yes"
  fi
else
  teardown_state="stop-failed"
fi
[[ "$teardown_state" == yes ]] || fail "teardown-$teardown_state" "teardown: $teardown_state"

printf 'METEORITE-LIVENESS proven=yes session=%s provider=%s provider_pid=%s pulse_interval=%s pulse_first=%s pulse_last=%s startup_handshake=yes torn_down=%s substitutions=%s unproven=%s\n' \
  "$session" "$provider" "$liveness_pid" "$pulse_interval" "$liveness_first" "$liveness_last" \
  "$teardown_state" "$(IFS=,; printf '%s' "${substitutions[*]}")" "$unproven"
