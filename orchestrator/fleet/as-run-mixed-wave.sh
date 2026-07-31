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

# Independent review for each branch whose coder work is done and is only
# waiting on the gated-review step.
for b in ag-ml1-alarm-classes ag-ml10-delivery-fallback ag-ml2-autonomy-keepalive ag-w16-count-provenance ag-fleet-idle-check; do
  start "rev-$b" reviewer "$LANES/$b" "# Task — independent review of \`$b\`

You did NOT write this branch. Decide ACCEPT or REJECT on evidence.

The coder reported its work complete and \`NO-GO\` ONLY because gated work owes an
independent review — that review is you. Read its terminal report and the diff.

Base: \`origin/main\`. Diff: \`git diff origin/main...HEAD\`.

Check, in this order:
1. Does the change actually do what its commit messages claim? An overclaiming
   title is a finding.
2. Re-run its tests YOURSELF and paste the real output. Do not trust any number
   written in its report — this repo has had three false-count incidents (W-16).
3. Does the regression lock genuinely bite? Revert the fix, confirm the lock
   FAILS, restore it, confirm it PASSES. A lock that passes both ways is not a
   lock, and reporting it as one is the exact false-green class we keep closing.
4. Fail-OPEN paths: can any new check silently pass when it cannot determine the
   truth? Prefer fail-closed; a check that quietly passes manufactures confidence.
5. Secrets, and any change outside the branch's stated scope.

Known EXCLUSION, do not chase: CI is red for an unrelated reason
(\`dispatch-check\` refuses valid packs in a fresh clone) owned by lane
\`ag-ci-dispatch-gate\`. Judge this branch on everything else.

Write \`reports/$b.review.md\`, commit it, and finish with a terminal report:
verdict, blockers with file:line, the exact commands you ran and their output,
and the secret-scan result."
done

start fix-ml4-isolation coder "$LANES/ag-ml4-health-honest" '# Task — close YOUR remaining blocker: full-suite isolation

Your own report says:

> blocker: повний `bun test` має сторонній fail у `watchdog-turnend-a1.test.ts`
> і зависає через успадкований Telegram runtime config

That is the known ENV-LEAK class in this repo: a suite that shells the launcher
or daemon inherits live `ORCH_*` / Telegram runtime configuration instead of
isolating it, so it touches operator state and hangs or fails spuriously.

The house rule from the earlier incident: any suite that shells
launch.sh/watchdog.sh must isolate the FULL `ORCH_*` surface — every lock, lease,
db, heartbeat and runtime path variable — not a hand-picked subset. A subset is
exactly how the previous stomp happened, and how a suite once forged a fresh
heartbeat for a dead orchestrator.

Do:
1. Reproduce the hang/fail and identify precisely which inherited variables cause
   it. Report the actual list; do not guess.
2. Isolate them into scratch paths for the affected suite(s). If a shared
   isolate helper already exists, use it; if not and one is clearly warranted,
   say so rather than duplicating the list in another file where it will drift.
3. Prove it: the full `cd daemon && bun test` completes without hanging and
   without that spurious failure, from a shell that HAS the live ORCH_* env set.
   Paste the real output and the real counts.
4. Confirm live operator state is untouched: the live lock/lease/heartbeat files
   must be byte-identical before and after the run. Show the check.

Do NOT weaken or skip `watchdog-turnend-a1.test.ts` to make this pass — it is the
A1 drop-fix regression lock and it must keep biting.

Commit `[CODER]`, secret-scan, terminal report with exact commands and output.'
