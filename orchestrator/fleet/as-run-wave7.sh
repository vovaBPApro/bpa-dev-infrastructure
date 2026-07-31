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

start fix-fleet-idle-ci coder "$LANES/ag-fleet-idle-check" '# Task — your ACCEPTed branch breaks CI. Fix the scope, not the strictness.

Your branch passed independent review, and the orchestrator caught a regression
the review missed. Do NOT land as-is.

## The defect, reproduced

`tools/state-contract/check.ts` now FAILS whenever lane state is zero OR
unknown. CI runs this checker (`repo-checks` -> `.github/scripts/run-suites.sh
checks`). A CI runner has no lanes, so the check fails there ALWAYS. Landing this
turns CI permanently red.

Reproduction (git present, systemctl absent):

    mkdir -p /tmp/cipath && for b in git bun node sh bash env grep cat; do
      ln -sf "$(command -v $b)" /tmp/cipath/$b; done
    env -i PATH=/tmp/cipath HOME=/root bun tools/state-contract/check.ts

    FAIL FLEET-IDLE: 24 open workboard row(s), running lane unit(s)
    unknown/degraded: could not execute system systemctl: ... -> EXIT 1

The same FAIL occurs on a runner where systemctl EXISTS but reports zero
`lane-*` units. Both CI shapes are red.

## The fix — and the trap to avoid

Do NOT fix this by making the check lenient, by skipping it in CI, or by keying
on a CI env var to stay quiet. That is the green-on-SKIP / fail-open hole this
repo has closed three times, and your own review criteria forbid it.

The real error is one of SCOPE. FLEET-IDLE is a HOST-STATE assertion about the
orchestrator machine. In a checkout with no orchestrator, the check is not
passing and not failing — its SUBJECT does not exist. Encode that honestly:

- Detect whether this checkout IS an orchestrator host, from positive evidence
  (e.g. the live orchestrator runtime/lock/session state this repo already
  defines), not from "am I in CI".
- Where there is no orchestrator host, report NOT-APPLICABLE with an explicit
  reason — and make sure `run-suites.sh` treats not-applicable distinctly from
  SKIP, since a bare SKIP is what the skip gate exists to catch.
- Where there IS an orchestrator host, behaviour must be exactly as now,
  including the fail-closed unknown/degraded case. Do not weaken it.

## Evidence required

1. The CI-shaped reproduction above -> exits 0 with an explicit not-applicable
   reason.
2. On THIS host with the orchestrator live and zero lanes -> still FAILS.
3. Unknown/degraded on an orchestrator host -> still FAILS (fail-closed intact).
4. Your existing tests stay green, plus a new lock for the not-applicable path.
   Paste real output for each; reproduce every count yourself.

Commit `[CODER]`, secret-scan, terminal report.'

start rev-ag-ci-dispatch-gate reviewer "$LANES/ag-ci-dispatch-gate" '# Task — independent review of `ag-ci-dispatch-gate`

You did NOT write this branch. Decide ACCEPT or REJECT on evidence. It reports
its coder work done and NO-GO only because gated work owes this review.

It fixes CI: `dispatch-check` was refusing packs that `compose.ts` itself
produced, in a fresh shallow clone (6 failures). Verify the fix REALLY works and
did not simply relax the gate:

1. Reproduce in a FRESH shallow clone, which is what CI does:
       cd /root/.cache && rm -rf rev-repro
       git clone --depth 1 file:///root/bpa-dev-infrastructure rev-repro
   then apply/checkout this branch state and run the dispatch-check suites.
2. THE KEY QUESTION: is the gate still FAIL-CLOSED? Confirm it still REFUSES a
   marker-less prompt, a tampered pack, and a wrong-SHA marker. A "fix" that
   makes refusal lenient is worse than the bug — it disarms the only thing
   stopping a hand-assembled prompt from reaching a lane.
3. Re-run every count yourself; trust no number from its report.
4. Confirm the full working-tree run is ALSO still green — the fix must work in
   both environments, not trade one for the other.

Write `reports/ag-ci-dispatch-gate.review.md`, commit it, terminal report with
verdict, exact commands and real output.'

start rev-ag-ml4-health-honest reviewer "$LANES/ag-ml4-health-honest" '# Task — independent review of `ag-ml4-health-honest` (ML-4 + suite isolation)

You did NOT write this branch. ACCEPT or REJECT on evidence.

It does two things: makes `/health connected` reflect real transport liveness
instead of `activeServer !== null` (it was reporting connected on a dead socket),
and fixes a full-suite isolation failure where a test inherited live Telegram
runtime config and hung.

Verify:
1. The health fix: a dead/half-open transport must NOT report connected. Revert
   the fix, confirm the lock FAILS, restore it, confirm it PASSES. A lock that
   passes both ways is not a lock.
2. The isolation fix: run the FULL `cd daemon && bun test` from a shell that HAS
   the live ORCH_* environment set. It must complete without hanging.
3. CRITICAL — live state untouched: the live lock/lease/heartbeat files must be
   byte-identical before and after that run. Check and paste the hashes. A suite
   that writes the live heartbeat can convince a watchdog that a dead
   orchestrator is alive; that is the worst failure mode in this repo.
4. `watchdog-turnend-a1.test.ts` must NOT have been weakened or skipped — it is
   the A1 drop-fix lock.

Write `reports/ag-ml4-health-honest.review.md`, commit, terminal report.'

for spec in "fix4-ml1:ag-ml1-alarm-classes" "fix4-ml2:ag-ml2-autonomy-keepalive" "fix4-ml10:ag-ml10-delivery-fallback" "fix4-w16:ag-w16-count-provenance"; do
  name="${spec%%:*}"; dir="${spec##*:}"; b="$dir"
  start "$name" coder "$LANES/$dir" "# Task — an independent reviewer REJECTED your branch. Close the blockers.

The verdict is in this worktree at \`reports/$b.review.md\`. Read it first; it is
your specification. Do not widen scope beyond it.

Rules that the review will be re-checked against:
- Every fix ships a regression lock proven FAIL-BEFORE / PASS-AFTER. Actually run
  both states and paste the real output. A lock that passes in both directions is
  not a lock and claiming it is counts as a false green.
- Never report a count you did not personally reproduce with the command you
  quote.
- Do not make a check lenient or skip it to go green. Fail-closed stays
  fail-closed; if a check cannot determine the truth it must say so, not pass.
- If you believe a blocker is wrong, argue it with evidence rather than silently
  ignoring it.

Known EXCLUSION: CI is red for an unrelated reason (dispatch-check in a fresh
clone), owned by \`ag-ci-dispatch-gate\`. Do not chase it; state it as external.

Commit \`[CODER]\`, secret-scan, terminal report with exact commands and output."
done

start cont-onboarding coder "$LANES/ag-onboarding-truth" '# Task — continue: finish the onboarding truth work

Read your own previous terminal report in this worktree; it says what is left.
Do not redo committed work.

Since you started, `orchestrator/fleet/` has LANDED on main and now carries the
as-run wave scripts, the fleet-nudge watchdog, its systemd units, and a README
documenting the real launch sequence plus the host traps. Rebase onto latest
origin/main and build on that instead of re-deriving it — your job is to turn
that captured-as-run material into a tested, parameterized entry point and to
reconcile `bootstrap/install.sh` (which still renders systemd --user units that
cannot start on this host).

Also now landed and binding: Hard Floor 5 and
`instructions/reproducible-from-git.md` — the meteorite test. Your document is
the thing that has to make that test pass.

Evidence: rehearse on a clean throwaway target (Docker, as
`bootstrap/REHEARSAL.md` does) and paste the real output. State plainly which
steps you executed and which you could not, and why. An honest partial rehearsal
beats a confident untested runbook — that is precisely the defect that created
this lane.

Commit `[CODER]`, secret-scan (you are near credential paths — no values in the
doc), terminal report.'
