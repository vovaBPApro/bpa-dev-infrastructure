#!/usr/bin/env bash
# The lane unit payload: run the agent, mask its output, decide terminal state.
#
# This is a FILE, and deliberately not an inline `/bin/bash -c '...'` body in
# orchestrator/fleet/launch-lane.sh. The reason is specific and was expensive.
#
# systemd performs its own variable expansion on the ExecStart line before the
# shell ever sees it. `${10}`, `${PIPESTATUS[@]}` and `${pipeline_status[0]}`
# are not valid environment variable names, so systemd substituted an EMPTY
# STRING for each and said so in the unit journal on every single launch:
#
#   lane-….service: Invalid environment variable name evaluates to an empty
#   string: 10, PIPESTATUS[@], pipeline_status[0], pipeline_status[1]
#
# Unbraced $1…$9 survived, because systemd only rewrites the braced form, so
# the damage looked like a working launcher. `role` is the tenth parameter, so
# every lane invoked gate/lane-exit.sh as `--role ""`; that gate rejects an
# empty flag value as a usage error and exits 2 before running a single check,
# and the lane was recorded `failed / report-invalid` however good its work
# was. The second effect was silent and worse: `pipeline_status` was empty, so
# `agent_status` and `mask_status` were empty strings, `((agent_status != 0))`
# on an empty string is a do-nothing no-op, and the crashed-agent and
# failed-masker checks below were disabled outright.
#
# Because systemd never parses this file's body, nothing in it can be eaten,
# and no later edit here can reintroduce that class of defect. Escaping every
# expansion as `$${...}` in place is a real systemd mechanism and it does work
# (orchestrator/fleet/lane-payload-systemd.test.sh proves it rather than
# assuming it), but it has to be remembered perfectly, forever, by everyone who
# touches the body, and a single miss fails silently. A file cannot be
# misremembered.
#
# Full write-up: instance/incidents/2026-08-04-systemd-ate-the-tenth-argument.md
#
# Usage, positional, from launch-lane.sh:
#   lane-payload.sh PROMPT BUN MASKER LOG REPORT STATUS GATE REPO BRANCH ROLE AGENT_ARGV...
set -o pipefail

# Ten fixed parameters plus at least one agent-command element. An argv that
# arrives short means something between the launcher and here dropped it, which
# is precisely the failure mode this file exists to end; say so rather than
# running with holes in it.
if (($# < 11)); then
  printf 'lane-payload: expected 10 parameters and an agent command, got %s argument(s)\n' "$#" >&2
  exit 2
fi

prompt=$1; bun=$2; masker=$3; log=$4; report=$5; status=$6; gate=$7; repo=$8; branch=$9; role=${10}
shift 10

# A lost role is the exact defect above. Name it distinctly instead of handing
# `--role ""` to the gate and letting it come back as a generic usage error:
# that misfiling as `report-invalid` is what hid this for a day and made 59
# lane status files untrustworthy.
if [[ -z "$role" ]]; then
  printf "state: failed\nreason: invalid-role\nexit: 2\nreport: %s\n" "$report" >"$status"
  printf 'lane-payload: role is empty; refusing to run the exit gate\n' >&2
  exit 2
fi

set +e
"$@" "$(cat "$prompt")" 2>&1 | "$bun" "$masker" >>"$log"
pipeline_status=("${PIPESTATUS[@]}")

# The two checks below decide whether a crashed agent or a failed masker is
# reported at all, and an empty pipeline_status turns both into no-ops without
# failing. Never infer success from an unreadable status array.
if ((${#pipeline_status[@]} != 2)); then
  printf "state: failed\nreason: pipeline-status-lost\nexit: 2\nreport: %s\n" "$report" >"$status"
  printf 'lane-payload: PIPESTATUS did not survive; agent and masker exit status are unknown\n' >&2
  exit 2
fi

agent_status=${pipeline_status[0]}
mask_status=${pipeline_status[1]}
if ((agent_status != 0)); then
  printf "state: failed\nreason: payload-exit\nexit: %s\nreport: %s\n" "$agent_status" "$report" >"$status"
  exit "$agent_status"
fi
if ((mask_status != 0)); then
  printf "state: failed\nreason: log-masker-exit\nexit: %s\nreport: %s\n" "$mask_status" "$report" >"$status"
  exit "$mask_status"
fi

# This gate runs inside callers such as gate/land.sh, which deliberately export
# their own trusted BUN_BIN. The nested gate must resolve its own interpreter
# instead of tripping the land_resolve_bun caller-override guard.
env -u BUN_BIN "$gate" --report "$report" --repo "$repo" --branch "$branch" --role "$role" >>"$log" 2>&1
guard_status=$?
if ((guard_status == 0 || guard_status == 3)); then
  printf "state: terminal\nreason: report-valid\nexit: %s\nreport: %s\n" "$guard_status" "$report" >"$status"
  exit 0
fi
printf "state: failed\nreason: report-invalid\nexit: %s\nreport: %s\n" "$guard_status" "$report" >"$status"
exit "$guard_status"
