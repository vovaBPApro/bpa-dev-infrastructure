#!/usr/bin/env bash
# Wave 1 fan-out: one independent review lane per open branch.
# Each lane runs as its own systemd --user unit so it survives the orchestrator
# relaunch (provider switch to codex is queued right behind this).
set -euo pipefail

REPO=/root/bpa-dev-infrastructure
LANES=/root/.cache/infra-lanes
BRANCHES=(ag-statecontract-argv ag-pack-hygiene ag-codex-launcher ag-howto-core ag-status-human ag-personas-phase1)

mkdir -p "$LANES"

for b in "${BRANCHES[@]}"; do
  wt="$LANES/review-$b"
  unit="lane-review-$b"
  log="$LANES/$unit.log"
  prompt="$LANES/$unit.prompt.md"

  # Fresh worktree at the branch tip; detached so the lane cannot move the branch.
  if [ -d "$wt" ]; then
    git -C "$REPO" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"
  fi
  git -C "$REPO" worktree add --detach "$wt" "$b" -q

  # Composed context pack (fail-closed: dispatch-lane.sh refuses a prompt with
  # no compose marker, so this is not a hand-assembled prompt).
  bun "$REPO/tools/instructions/compose.ts" --role reviewer --repo "$REPO" \
    --out "$LANES/pack-$b" >/dev/null

  {
    cat "$LANES/pack-$b/preamble.md"
    cat <<EOF

---

# Your task — independent review of branch \`$b\`

You are the INDEPENDENT REVIEWER for this branch. You did not write it. Your job
is to decide ACCEPT or REJECT on evidence, not to be agreeable.

Repository: this worktree (detached at the tip of \`$b\`). Base: \`origin/main\`.

1. Read the full diff: \`git diff origin/main...HEAD\`
2. For every claim the commit messages make, verify it against the code. A commit
   title that overclaims what the code does is a finding.
3. Run the narrowest meaningful checks yourself. Do NOT trust any test count
   written in a report — re-run and paste the command's own output. A reported
   number that you did not reproduce is not evidence (this repo has had three
   separate false-count incidents; see W-16).
4. Look specifically for: false-green (a check that passes when it should fail),
   fail-open error paths, secrets, and any change outside the branch's stated
   scope.
5. If the branch touches \`tools/state-contract/check.ts\`, say so explicitly in
   your verdict — two branches edit that registry and their landings must be
   serialized with a rebase between them.

Write your verdict to \`reports/$b.review.md\` in this worktree, then commit it
on this detached HEAD. The report must contain:
- verdict: ACCEPT or REJECT
- for REJECT: each blocker, with file:line and the concrete failure it causes
- the exact commands you ran and their real output
- secret-scan result

Finish with a terminal report. Do not ask questions — decide on the evidence and
state your assumptions.
EOF
  } > "$prompt"

  # Fail-closed marker gate.
  bash "$REPO/orchestrator/dispatch-lane.sh" "$prompt" >/dev/null

  # System-level transient unit, deliberately NOT --user: there is no user bus
  # for root here ("Failed to connect to bus: No medium found"), and a system
  # unit also sits OUTSIDE the telegram-daemon cgroup, so lanes survive both the
  # orchestrator relaunch and a daemon restart. Clean env by construction, which
  # also avoids the ORCH_* env-leak hazard that bit the parallel suites.
  systemctl reset-failed "$unit" 2>/dev/null || true
  systemd-run --collect --unit "$unit" \
    --setenv=HOME=/root \
    --setenv=TMPDIR=/root/.cache/lane-tmp \
    --setenv=PATH="/usr/local/bin:/usr/bin:/bin" \
    --working-directory="$wt" \
    bash -lc "codex exec --dangerously-bypass-approvals-and-sandbox \"\$(cat '$prompt')\" > '$log' 2>&1" \
    >/dev/null 2>&1

  echo "launched $unit -> $wt"
done
