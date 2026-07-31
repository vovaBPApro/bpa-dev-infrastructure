set -euo pipefail
REPO=/root/bpa-dev-infrastructure; LANES=/root/.cache/infra-lanes
start() { local name="$1"; local role="$2"; local wt="$3"; local body="$4"
  local unit="lane-$name"; local log="$LANES/lane-$name.log"; local prompt="$LANES/lane-$name.prompt.md"
  bun "$REPO/tools/instructions/compose.ts" --role "$role" --repo "$REPO" --out "$LANES/pack-$name" >/dev/null
  { cat "$LANES/pack-$name/preamble.md"; printf '\n---\n\n%s\n' "$body"; } > "$prompt"
  bash "$REPO/orchestrator/dispatch-lane.sh" "$prompt" >/dev/null
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  systemd-run --collect --unit "$unit" --setenv=HOME=/root --setenv=TMPDIR=/root/.cache/lane-tmp \
    --setenv=PATH="/usr/local/bin:/usr/bin:/bin" --working-directory="$wt" \
    bash -lc "codex exec --dangerously-bypass-approvals-and-sandbox \"\$(cat '$prompt')\" > '$log' 2>&1" >/dev/null 2>&1
  echo "launched $unit"; }

REBASE='IMPORTANT — main has moved. Rebase onto latest origin/main first. Now landed
there: the CI dispatch-gate fix (pack SHA pinned to --short=8, CI is unblocked)
and ML-4 (transport-aware /health + centralized daemon child env isolation via
daemon/test-env.ts). If you were carrying your own copy of an isolate-env helper,
use the shared one instead of re-deriving it.'

# Re-review the branches whose fixups claimed ACCEPT-worthy state
start rev2-w16 reviewer "$LANES/ag-w16-count-provenance" "# Task — re-review \`ag-w16-count-provenance\` after its fixup

$REBASE

You are the independent reviewer. The previous review REJECTED this branch; a
fixup lane has since worked on it and believes the blockers are closed. Read
\`reports/ag-w16-count-provenance.review.md\` for the prior verdict, then judge
the CURRENT state.

Subject: a reported test count must not be accepted as evidence. The gate must
re-run \`verify:\` and compare, or parse the mandated command's own output, and a
MISMATCH must FAIL the landing rather than warn.

Verify above all:
1. Construct a lane report that CLAIMS a false count and prove the gate REJECTS
   it. That is the whole point of the feature — if you cannot demonstrate the
   rejection, it is not done.
2. Prove the honest case still passes, so the gate is usable.
3. Can it fail OPEN — pass when it cannot determine the real count? That must be
   a failure, not a pass.
4. Re-run every count yourself.

Write the verdict to \`reports/ag-w16-count-provenance.review.md\`, commit,
terminal report."

start rev2-onboarding reviewer "$LANES/ag-onboarding-truth" "# Task — independent review of \`ag-onboarding-truth\`

$REBASE

You did NOT write this. ACCEPT or REJECT on evidence.

Subject: make onboarding actually reproduce THIS host — the documented path
previously could not (bootstrap renders systemd --user units that cannot start
here; installer root defaults to /home/... vs the real /root/...; the lane
fan-out mechanism was not in the repo at all).

The binding standard is Hard Floor 5 / \`instructions/reproducible-from-git.md\`:
the METEORITE TEST — if this host were destroyed, does the repository ALONE bring
it back?

Judge against that, not against how well-written the document is:
1. Follow the document literally on a CLEAN throwaway target (Docker). Where it
   breaks, that is a finding. Paste real output.
2. Does it enumerate every host-supplied item (bot token, access.json,
   runtime.env, service-account key path+perms, whisper, bun, CLI auth) WITH a
   verification command for each — and with NO secret values?
3. Is it LINKED from somewhere discoverable? An unlinked doc is one nobody reads;
   \`runbook.md\` is an archived stub.
4. Does it honestly separate steps that were EXECUTED from steps merely written?
   A confident untested runbook is the exact defect that created this lane —
   reward honesty about gaps, reject false confidence.

Write \`reports/ag-onboarding-truth.review.md\`, commit, terminal report."

for spec in "fix5-ml1:ag-ml1-alarm-classes" "fix5-ml2:ag-ml2-autonomy-keepalive" "fix5-ml10:ag-ml10-delivery-fallback"; do
  name="${spec%%:*}"; dir="${spec##*:}"; b="$dir"
  start "$name" coder "$LANES/$dir" "# Task — close the REJECT blockers on \`$b\`

$REBASE

An independent reviewer REJECTED this branch again. The verdict in
\`reports/$b.review.md\` is your specification. Read it first.

Non-negotiable:
- Every fix ships a regression lock proven FAIL-BEFORE / PASS-AFTER, with both
  runs' real output pasted. A lock that passes in both directions is not a lock.
- Never report a count you did not personally reproduce with the quoted command.
- Do not go green by making a check lenient, skipping a test, or special-casing
  an environment. If a check cannot determine the truth it must FAIL, not pass.
- If a blocker is genuinely wrong, argue it with evidence; do not ignore it.

If you cannot close a blocker, report NO-GO with the concrete reason. An honest
NO-GO is correct; a false clean is a firing offence in this repo.

Commit \`[CODER]\`, secret-scan, terminal report."
done

start fix2-fleet-idle-ci coder "$LANES/ag-fleet-idle-check" "# Task — finish the FLEET-IDLE scope fix

$REBASE

Your previous run reported NO-GO. Read your own terminal report for where you
stopped.

Recap of the defect: \`tools/state-contract/check.ts\` FAILS whenever lane state
is zero OR unknown, and CI runs this checker, so landing it makes CI permanently
red. Reproduction:

    mkdir -p /tmp/cipath && for b in git bun node sh bash env grep cat; do
      ln -sf \"\$(command -v \$b)\" /tmp/cipath/\$b; done
    env -i PATH=/tmp/cipath HOME=/root bun tools/state-contract/check.ts
    -> FAIL FLEET-IDLE ... unknown/degraded -> exit 1

The fix is SCOPE, not strictness. FLEET-IDLE asserts something about the
orchestrator HOST. In a checkout with no orchestrator its subject does not exist,
so the honest result is NOT-APPLICABLE with a reason — not a pass, and not a bare
SKIP (the skip gate exists to catch those). Detect an orchestrator host from
POSITIVE evidence, never from 'am I in CI'.

Required evidence, all four:
1. CI-shaped run -> exit 0 with an explicit not-applicable reason.
2. This host, orchestrator live, zero lanes -> still FAILS.
3. Orchestrator host, lane state unknown/degraded -> still FAILS (fail-closed).
4. Existing tests green + a new lock for the not-applicable path.

Commit \`[CODER]\`, secret-scan, terminal report with real output for each."
