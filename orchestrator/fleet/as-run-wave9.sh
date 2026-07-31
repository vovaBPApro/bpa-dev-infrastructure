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

REBASE='Rebase onto latest origin/main FIRST. Newly landed there: the CI dispatch-gate fix,
ML-4 (transport-aware /health + shared daemon/test-env.ts isolation helper), and
W-16 (the landing gate now RE-RUNS `verify:` and REJECTS a report whose claimed
count disagrees with the actual output — so a typed number is no longer evidence
anywhere in this repo).'

# The fleet-idle check: reviewer says ACCEPT, coder still says NO-GO. Resolve.
start fix3-fleet-idle coder "$LANES/ag-fleet-idle-check" "# Task — close out FLEET-IDLE: reviewer ACCEPTed, your report still says NO-GO

$REBASE

There is a disagreement to resolve honestly: the independent review returned
ACCEPT, but your own last terminal report returned NO-GO. One of those is wrong.
Determine which, state it plainly, and finish.

The orchestrator will NOT land this until all four proofs below are pasted with
real output — the earlier ACCEPT on this branch already hid a CI-breaking
regression, so the verdict alone is not enough:

1. CI-shaped run exits 0 with an explicit NOT-APPLICABLE reason:
       mkdir -p /tmp/cipath && for b in git bun node sh bash env grep cat; do
         ln -sf \"\$(command -v \$b)\" /tmp/cipath/\$b; done
       env -i PATH=/tmp/cipath HOME=/root bun tools/state-contract/check.ts
2. On THIS host, orchestrator live, zero lanes -> still FAILS.
3. Orchestrator host with lane state unknown/degraded -> still FAILS (fail-closed
   intact; do not let 'unknown' become a pass).
4. Existing tests green PLUS a lock for the not-applicable path.

Not-applicable must be distinguishable from a bare SKIP — the skip gate exists
because green-on-SKIP is how this repo has been fooled before.

Commit \`[CODER]\`, secret-scan, terminal report."

start fix-onboarding-2 coder "$LANES/ag-onboarding-truth" "# Task — the onboarding doc was REJECTED. Close the blockers.

$REBASE

The independent review REJECTED your work. Its verdict is in
\`reports/ag-onboarding-truth.review.md\` — that is your specification.

Remember the standard you are being judged against: Hard Floor 5 /
\`instructions/reproducible-from-git.md\`, the METEORITE TEST. Not 'is the
document nice' but 'if this host were destroyed, does the repo ALONE bring it
back'.

The failure mode to avoid is the one that created this lane: a confident runbook
nobody executed. So:
- Actually RUN the steps on a clean Docker target and paste the real output.
- Where a step cannot be executed in that environment, say so explicitly and why.
  An honest gap is acceptable; an unmarked untested step is not.
- Enumerate every host-supplied item with its path, permissions and a
  verification command — and NO secret values anywhere in the doc.
- Make the document discoverable/linked; an unlinked doc is one nobody reads.

Commit \`[CODER]\`, secret-scan, terminal report."

for spec in "fix6-ml1:ag-ml1-alarm-classes" "fix6-ml2:ag-ml2-autonomy-keepalive" "fix6-ml10:ag-ml10-delivery-fallback"; do
  name="${spec%%:*}"; dir="${spec##*:}"; b="$dir"
  start "$name" coder "$LANES/$dir" "# Task — \`$b\` was REJECTED again. Close the blockers properly.

$REBASE

This branch has now been rejected by independent review more than once. Read
\`reports/$b.review.md\` and close EVERY blocker it lists.

Before you start, consider seriously whether the repeated rejections mean the
approach itself is wrong rather than the details. If you believe the reviewer is
mistaken, say so with evidence — do not silently ignore a blocker and do not
paper over it.

Non-negotiable:
- Regression locks proven FAIL-BEFORE / PASS-AFTER, both runs' real output
  pasted. A lock that passes in both directions is not a lock.
- The landing gate now RE-RUNS \`verify:\` and rejects a mismatched count, so a
  typed number will be caught. Report only counts you actually reproduced.
- Never go green by weakening a check, skipping a test, or special-casing an
  environment. A check that cannot determine the truth must FAIL.

If you cannot close a blocker, report NO-GO with the concrete reason.

Commit \`[CODER]\`, secret-scan, terminal report."
done
