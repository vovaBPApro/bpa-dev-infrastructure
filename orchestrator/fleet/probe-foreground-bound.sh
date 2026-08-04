#!/usr/bin/env bash
# Measure the foreground-command bound a lane agent actually runs under.
#
# A lane agent harness may kill a foreground command at a bound the lane never
# declared and cannot see. That bound is invisible from outside a lane: running
# the same command in an operator shell proves nothing about it. This probe
# launches the configured agent exactly as the fleet launcher would, asks it to
# run one foreground command that sleeps for a known duration, and decides from
# a token file on disk — not from the agent's narration — whether the command
# survived.
#
# The probe is deliberately provider-agnostic. It never names an environment
# variable or a CLI flag: it takes an agent command file, the same data the
# launcher takes, and reports what a lane launched with that file would get.
# Declaring the bound is the command file's job (it is installation data); this
# script only answers whether the declaration takes effect.
#
# Deliberately NOT registered in instance/expected-mechanisms.tsv and not wired
# into the landing gate: every run launches a real agent and spends real quota,
# and it takes as long as the bound it is measuring. It is a prover run when the
# declaration changes, not a check run on every candidate. The cheap, always-on
# half of this guarantee is orchestrator/fleet/lane-agent-command-bound.test.ts,
# which audits the declaration itself on every landing.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: probe-foreground-bound.sh --agent-command FILE --sleep-seconds N [options]

Required:
  --agent-command FILE  One-argv-entry-per-line command file, parsed exactly as
                        orchestrator/fleet/launch-lane.sh parses it
  --sleep-seconds N     Duration of the probed foreground command

Options:
  --label TEXT          Label echoed in the result line (default: probe)
  --expect completed|killed
                        Exit non-zero unless the observed outcome matches

Output (one line):
  probe label=L sleep=Ns elapsed=Es outcome=completed|killed

Exit: 0 outcome observed (and matches --expect when given), 4 expectation
      violated, 2 usage or environment error.
EOF
}

die() { printf 'probe-foreground-bound: %s\n' "$*" >&2; exit 2; }

agent_command_file=""; sleep_seconds=""; label="probe"; expect=""
while (($#)); do
  case "$1" in
    --agent-command) agent_command_file="${2:-}"; shift 2 ;;
    --sleep-seconds) sleep_seconds="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --expect) expect="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -f "$agent_command_file" && -r "$agent_command_file" ]] ||
  die "agent command file missing or unreadable: $agent_command_file"
[[ "$sleep_seconds" =~ ^[1-9][0-9]*$ ]] || die '--sleep-seconds must be a positive integer'
case "$expect" in ""|completed|killed) ;; *) die '--expect must be completed or killed' ;; esac

# Same parse as launch-lane.sh: blank lines and column-1 comments are data, not
# argv. Resolving argv[0] here keeps a broken command file a usage error rather
# than a mysterious "killed" result.
agent_argv=()
while IFS= read -r arg || [[ -n "$arg" ]]; do
  [[ -z "$arg" || "$arg" == \#* ]] && continue
  agent_argv+=("$arg")
done <"$agent_command_file"
((${#agent_argv[@]})) || die "agent command file is empty: $agent_command_file"
if [[ "${agent_argv[0]}" == */* ]]; then
  [[ -x "${agent_argv[0]}" ]] || die "agent executable is unavailable: ${agent_argv[0]}"
else
  agent_argv[0]="$(command -v "${agent_argv[0]}" 2>/dev/null || true)"
  [[ -x "${agent_argv[0]}" ]] || die 'configured agent executable is unavailable'
fi

token="$(mktemp -u "${TMPDIR:-/tmp}/probe-foreground-bound.XXXXXX.token")"
transcript="$(mktemp "${TMPDIR:-/tmp}/probe-foreground-bound.XXXXXX.out")"
cleanup() { rm -f -- "$token" "$transcript"; }
trap cleanup EXIT

# The agent is given no discretion: one foreground call, no tool-level timeout
# override, no backgrounding. The token write is the last thing the command
# does, so the token exists if and only if the command was allowed to finish.
read -r -d '' prompt <<EOF || true
Run this exact command with the Bash tool as ONE foreground call.
Do not set the tool timeout parameter. Do not run it in the background.
Do not split it into multiple calls.

Command: sh -c 'sleep $sleep_seconds; printf survived > $token'

Then reply with only the exit code you observed.
EOF

started="$(date +%s)"
agent_status=0
"${agent_argv[@]}" "$prompt" >"$transcript" 2>&1 || agent_status=$?
elapsed="$(( $(date +%s) - started ))"

if [[ -s "$token" ]]; then
  outcome="completed"
else
  outcome="killed"
fi

printf 'probe label=%s sleep=%ss elapsed=%ss outcome=%s agent-exit=%s\n' \
  "$label" "$sleep_seconds" "$elapsed" "$outcome" "$agent_status"

if [[ -n "$expect" && "$outcome" != "$expect" ]]; then
  printf 'probe-foreground-bound: expected %s, observed %s\n' "$expect" "$outcome" >&2
  sed -n '1,40p' "$transcript" >&2
  exit 4
fi
