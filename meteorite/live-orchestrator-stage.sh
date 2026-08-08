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
# THE CREDENTIAL BOUNDARY, which is where that sentence had to be finished.
# The paragraph above stops one gate too early. A rebuilt host has no
# subscription credentials and, structurally, cannot have any: the credential
# store is written by a human running the provider CLI once and answering
# /login, so Hard Floor 5 deliberately keeps it OUT of git. The tracked launch
# path therefore refuses at `orchestrator/preflight-cli-auth.sh` on every
# rebuilt host, forever, and that refusal is the auth gate doing its job rather
# than a defect of the rebuild.
#
# So this stage has TWO pass boundaries and decides which one applies by
# measuring the world, never by being told:
#
#   liveness_boundary=full
#     Credentials are present (a real host, or a harness fixture that supplies
#     a credential store). The boundary does not apply: the launcher must
#     start, the startup handshake must land, the pulse must renew and the
#     session must tear down. Stopping at the auth gate with credentials
#     present is a FAIL -- that is the launch path being broken somewhere this
#     boundary was never meant to excuse.
#
#   liveness_boundary=auth-preflight-refusal
#     Credentials are absent. The pass condition is that the launch path
#     executed TRUTHFULLY up to and including the auth preflight and refused
#     there for exactly the preflight's own named reason. That is not a small
#     claim: launch.sh reaches its auth gate only through the singleton lock
#     handoff, `mission_cli reap`, `mission_cli status` and the lease-held
#     check, so a refusal AT the gate is positive evidence that all of them
#     ran. Everything past the gate travels in `unproven=`.
#
# Any failure BEFORE the boundary still fails the stage and the run. The world
# is classified by RUNNING the tracked preflight -- the same file resolved the
# same way launch.sh resolves it, in the same environment the launch will get --
# and reading the refusal class it names itself with
# (`AUTH-PREFLIGHT refused=<class>`, whose one home is that script). A boundary
# pass additionally requires the launch log to END with the probe's own refusal
# class and line, verbatim, and the launcher to return the auth-boundary status.
# That terminal suffix matters: the same lines earlier in a log prove only that
# the gate ran, not that its refusal caused the launch to stop. An exit 2 is what
# launch.sh returns for a missing session hook, an unbuildable command and an
# absent provider binary too, so neither text presence nor status is enough by
# itself.
#
# The assertion half is reachable on its own (`--assert-liveness`), so a host
# test can drive it against a fabricated runtime directory without a container.
#
# WHAT THE CONTAINER ACTUALLY DID, measured rather than expected, because this
# stage's history is a sequence of blockers each of which was invisible until
# the one in front of it cleared:
#
#   2026-08-06 (1e19580)  `ERROR orchestrator-unknown-action` -- core/mission-cli.ts
#                         implemented neither `reap` nor `lease`. Cleared by V3-5.37.
#   2026-08-06            `ERROR orchestrator-singleton-owner-unverified` --
#                         launch.sh locates its singleton owner in /proc/locks,
#                         which is namespace-filtered and reads EMPTY inside a
#                         container while a flock is held (measured: 11 FLOCK
#                         rows on the host, 0 in the container, same probe).
#                         Cleared by V3-5.38's named degradation.
#   2026-08-07 (8a591b8)  `refusing unproven subscription auth` -- the auth
#                         preflight, reached for the first time because the two
#                         above were gone. Structural, permanent, and NOT a
#                         defect: it is the credential boundary above, and it is
#                         declared here rather than worked around. Weakening a
#                         fail-closed auth gate to green a rebuild proof would
#                         invert the entire point of the proof.
#
# Each of the first two travels in this stage's reason as the launcher's own
# refusal token, because a bare `launch-refused` sends the reader to a container
# log by hand.
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
#
# Evidence line (stdout, exactly one, judged by meteorite/run.sh):
#   METEORITE-LIVENESS proven=yes liveness_boundary=<full|auth-preflight-refusal> ... \
#     substitutions=<set> unproven=<set>
#   METEORITE-LIVENESS proven=no reason=<token>
set -euo pipefail

install_root="${METEORITE_LIVE_INSTALL_ROOT:-/work/install}"
default_runtime_parent="$(dirname "$install_root")/runtime"
runtime_dir="${METEORITE_LIVE_RUNTIME_DIR:-$default_runtime_parent/orchestrator}"
state_db="${METEORITE_LIVE_STATE_DB:-$default_runtime_parent/state.db}"
provider="${METEORITE_LIVE_PROVIDER:-claude}"
session="${METEORITE_LIVE_SESSION:-meteorite-orchestrator}"
pulse_interval="${METEORITE_LIVE_PULSE_INTERVAL:-5}"
start_timeout="${METEORITE_LIVE_START_TIMEOUT:-180}"

# Resolved exactly as launch.sh resolves it (launch.sh:27), so the world probe
# below and the launch it predicts consult the same file. A caller that
# overrides it has substituted a launcher mechanism, and `guarded_knobs` already
# records ORCH_AUTH_PREFLIGHT as such -- meteorite/run.sh then refuses the run.
auth_preflight="${ORCH_AUTH_PREFLIGHT:-$install_root/orchestrator/preflight-cli-auth.sh}"

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

# What is additionally unproven when the run stops at the credential boundary.
# Everything past the auth gate is untouched there, so it is named rather than
# left to be inferred from the boundary token: a reader deciding policy on this
# artifact must be able to see WHAT was not crossed without knowing what
# launch.sh does after its auth gate.
unproven_beyond_auth="launch-start,startup-handshake,provider-supervision,liveness-pulse,teardown"

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
launch_env() {
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
    "$@"
}

run_launcher() {
  launch_env timeout "$start_timeout" bash "$launcher" "$@"
}

# The world probe. It runs the SAME auth gate the launch is about to run, under
# the SAME environment, so its verdict is about the world rather than about the
# difference between two environments -- the preflight refuses on a banned
# variable, and this stage's own wrapper is the thing that decides which
# variables the launch will see.
run_auth_preflight() {
  launch_env "$auth_preflight" "$provider"
}

# True only when the auth preflight's measured refusal is the launcher's
# terminal result. Merely finding both genuine lines anywhere is insufficient:
# a launcher can invoke the real gate, ignore its refusal, fail later, and still
# exit 2. The tracked launcher returns 2 immediately from the auth gate and the
# gate's class+sentence are therefore its final two non-empty log lines. Holding
# both that status and that exact terminal suffix is the observable boundary.
auth_refusal_is_terminal() {
  local log="$1" status="$2" refusal_class="$3" refusal_line="$4"
  local -a lines=()
  local count

  [[ "$status" == 2 ]] || return 1
  mapfile -t lines < <(sed '/^$/d' "$log")
  count="${#lines[@]}"
  ((count >= 2)) || return 1
  [[ "${lines[count - 2]}" == "AUTH-PREFLIGHT refused=$refusal_class" ]] || return 1
  [[ "${lines[count - 1]}" == "$refusal_line" ]]
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

# ── Classify the world before touching the launcher ────────────────────────
#
# Which boundary applies is decided HERE, by executing the tracked auth gate,
# and it is decided before anything is started so the decision cannot be
# rationalized from whatever the launch happened to do. Three outcomes, and the
# third one is a refusal rather than a default:
#
#   exit 0                          credentials present -> boundary `full`
#   refused=subscription-unproven   no credential store -> boundary
#                                   `auth-preflight-refusal`
#   anything else                   the world is UNDETERMINED. A metered-billing
#                                   signal, an expired login, an unsupported
#                                   provider, a missing Bun, an unreadable
#                                   credential file: each is a real problem with
#                                   this environment and none of them is the
#                                   boundary. Refuse rather than pick a boundary
#                                   that happens to make the run pass.
#
# An install with NO auth gate at its default path is a fourth case and it is
# deliberately not decided here: launch.sh refuses on exactly that, in its own
# words, and that refusal is the more precise report of a rebuild that failed to
# install its auth gate. Such a run gets the STRICT boundary, so if it somehow
# starts anyway it must still reach full liveness.
credential_world="indeterminate"
auth_refusal_class=""
auth_refusal_line=""
auth_probe_status=0
auth_probe_output=""
if [[ ! -x "$auth_preflight" ]]; then
  credential_world="no-auth-gate"
else
  auth_probe_output="$(run_auth_preflight 2>&1)" || auth_probe_status=$?
  if ((auth_probe_status == 0)); then
    credential_world="present"
  else
    auth_refusal_class="$(printf '%s\n' "$auth_probe_output" |
      sed -n 's/^AUTH-PREFLIGHT refused=\([a-z0-9-]\{1,\}\)$/\1/p' | head -n 1)"
    # The exact sentence the gate printed, kept so the launch log can be checked
    # against what the gate ACTUALLY said rather than against a copy of it living
    # here. `warning:` lines are advisory (GOOGLE_CLOUD_PROJECT) and the token
    # line is matched separately.
    auth_refusal_line="$(printf '%s\n' "$auth_probe_output" |
      grep -v -e '^AUTH-PREFLIGHT ' -e '^warning: ' -e '^$' | tail -n 1)"
    # ONE class qualifies, and it is the narrow one. `subscription-unproven`
    # means a credential store EXISTS here and does not prove anything --
    # corrupt, logged out, unknown schema, or no parser to read it with. That is
    # a broken machine, not a rebuilt one, and a rebuild proof that passed on it
    # would be reporting a defect as a structural boundary.
    if [[ "$auth_refusal_class" == "subscription-store-missing" && -n "$auth_refusal_line" ]]; then
      credential_world="absent"
    fi
  fi
fi
if [[ "$credential_world" == "indeterminate" ]]; then
  fail "auth-preflight-indeterminate${auth_refusal_class:+:$auth_refusal_class}" \
    "the tracked auth preflight neither proved subscription auth (exit 0) nor refused for an absent credential store (exit $auth_probe_status); no liveness boundary applies to this environment"
fi
printf '[live-orchestrator] credential world: %s (auth preflight exit %s)\n' \
  "$credential_world" "$auth_probe_status" >&2

printf '[live-orchestrator] starting %s in session %s (install=%s)\n' \
  "$provider" "$session" "$install_root" >&2

# The launcher's own refusal token is carried into the reason, so the artifact
# names WHICH mechanism refused rather than an exit status. `launch-refused`
# alone sent the first reader of this stage to read a container log by hand.
# Buffered rather than streamed for that reason only; it is replayed verbatim
# below either way.
launch_log="$scratch/launch.log"
start_status=0
run_launcher start >"$launch_log" 2>&1 || start_status=$?
cat "$launch_log" >&2
if ((start_status != 0)); then
  if ((start_status == 124)); then
    fail launch-timeout "launch.sh start did not return within ${start_timeout}s"
  fi

  # ── The credential boundary, applied ─────────────────────────────────────
  #
  # A PASS here needs four things to hold at once, and each one closes a way of
  # forging it:
  #
  #   1. the world was classified `absent` BEFORE the launch, by running the
  #      tracked gate -- so the boundary cannot be chosen after seeing how the
  #      launch went;
  #   2. the launch log carries the gate's own refusal CLASS, so any other
  #      refusal class (a metered key, an expired login) is not this boundary;
  #   3. the launch log reproduces the gate's own refusal SENTENCE verbatim, as
  #      the probe measured it moments earlier. Nothing in this file restates
  #      that sentence, so nothing here can drift away from it;
  #   4. class+sentence are the log's final two non-empty lines and launch.sh
  #      returned its auth-boundary status. The real gate's text found earlier
  #      beside a later `provider not found` proves the gate ran and was ignored,
  #      so it MUST fail rather than launder that later cause into this boundary.
  #
  # A failure BEFORE the gate fails the stage, which is the whole point: the
  # launcher reaches its auth preflight only through the singleton lock handoff,
  # `mission_cli reap`, `mission_cli status` and the lease-held check, so a
  # refusal at the gate is positive evidence that every one of those ran. Both
  # of the earlier container blockers -- `orchestrator-unknown-action` and
  # `orchestrator-singleton-owner-unverified` -- stop short of it and therefore
  # still fail, exactly as they did before this boundary existed.
  launch_refusal_class="$(sed -n 's/^AUTH-PREFLIGHT refused=\([a-z0-9-]\{1,\}\)$/\1/p' "$launch_log" | head -n 1)"
  if [[ "$credential_world" == "absent" ]] &&
     [[ "$launch_refusal_class" == "$auth_refusal_class" ]] &&
     auth_refusal_is_terminal "$launch_log" "$start_status" "$auth_refusal_class" "$auth_refusal_line"; then
    printf '[live-orchestrator] boundary: auth-preflight-refusal (%s)\n' "$auth_refusal_class" >&2
    printf 'METEORITE-LIVENESS proven=yes liveness_boundary=auth-preflight-refusal session=%s provider=%s credential_world=%s refused_at=auth-preflight refusal_class=%s startup_handshake=no torn_down=not-started substitutions=%s unproven=%s\n' \
      "$session" "$provider" "$credential_world" "$auth_refusal_class" \
      "$(IFS=,; printf '%s' "${substitutions[*]}")" "$unproven,$unproven_beyond_auth"
    exit 0
  fi

  # Credentials were PROVEN moments ago and the launch still stopped at the auth
  # gate. The boundary does not apply and must not be reachable by accident:
  # this is the launch path failing somewhere the boundary was never meant to
  # excuse, and calling it a boundary would turn a real regression green on
  # every host that IS logged in -- including the one this control plane runs on.
  if [[ "$credential_world" != "absent" && -n "$launch_refusal_class" ]]; then
    fail "auth-refused-with-credentials-present:$launch_refusal_class" \
      "the auth preflight proved subscription auth moments before the launch and then refused it (world=$credential_world); no liveness boundary excuses this"
  fi

  refusal="$(sed -n 's/.*ERROR \(orchestrator-[a-z-]*\).*/\1/p' "$launch_log" | head -n 1)"
  if [[ -z "$refusal" ]]; then
    # Not every launcher refusal carries an `ERROR orchestrator-*` token: the
    # missing auth preflight, the missing provider binary and the unsupported
    # provider all print bare prose. Slugify the last real line rather than
    # emitting a bare `launch-refused` for exactly the refusals a rebuilt host is
    # most likely to hit. Truncated at the first colon so a path never becomes
    # part of the token.
    refusal="$(grep -v -e '^WARN ' -e '^$' "$launch_log" | tail -n 1 | cut -d: -f1 |
      tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-' | cut -c1-60)"
  fi
  fail "launch-refused${refusal:+:$refusal}" "launch.sh start exited $start_status"
fi
started=1

# The gate refused this environment moments ago and the launcher started a
# session regardless: the auth preflight is not on the launch path it claims to
# be on. Set `started` first so the trap tears the session down -- a stage that
# fails without stopping what it started leaves a live orchestrator behind on
# the machine it was judging.
if [[ "$credential_world" == "absent" ]]; then
  fail auth-preflight-not-enforced \
    "the tracked auth preflight refuses in this environment, yet launch.sh started a session anyway"
fi

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

printf 'METEORITE-LIVENESS proven=yes liveness_boundary=full session=%s provider=%s credential_world=%s provider_pid=%s pulse_interval=%s pulse_first=%s pulse_last=%s startup_handshake=yes torn_down=%s substitutions=%s unproven=%s\n' \
  "$session" "$provider" "$credential_world" "$liveness_pid" "$pulse_interval" "$liveness_first" "$liveness_last" \
  "$teardown_state" "$(IFS=,; printf '%s' "${substitutions[*]}")" "$unproven"
