#!/usr/bin/env bash
# Wave 3: unblock the typecheck that gated all nine wave-2 lanes, then let each
# lane finish its own tail against a repaired base.
set -euo pipefail
REPO=/root/bpa-dev-infrastructure
LANES=/root/.cache/infra-lanes
BASE=$(git -C "$REPO" rev-parse HEAD)

start() { # name role workdir body
  local name="$1"; local role="$2"; local wt="$3"; local body="$4"
  local unit="lane-$name"; local log="$LANES/lane-$name.log"; local prompt="$LANES/lane-$name.prompt.md"
  bun "$REPO/tools/instructions/compose.ts" --role "$role" --repo "$REPO" --out "$LANES/pack-$name" >/dev/null
  { cat "$LANES/pack-$name/preamble.md"; printf '\n---\n\n%s\n' "$body"; } > "$prompt"
  bash "$REPO/orchestrator/dispatch-lane.sh" "$prompt" >/dev/null
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  systemd-run --collect --unit "$unit" \
    --setenv=HOME=/root --setenv=TMPDIR=/root/.cache/lane-tmp \
    --setenv=PATH="/usr/local/bin:/usr/bin:/bin" --working-directory="$wt" \
    bash -lc "codex exec --dangerously-bypass-approvals-and-sandbox \"\$(cat '$prompt')\" > '$log' 2>&1" >/dev/null 2>&1
  echo "launched $unit"
}

newlane() {
  local name="$1"
  local wt="$LANES/$name"
  [ -d "$wt" ] && { git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"; }
  git -C "$REPO" branch -D "$name" >/dev/null 2>&1 || true
  git -C "$REPO" worktree add -b "$name" "$wt" "$BASE" -q
  echo "$wt"
}

# ── PRIORITY: the shared blocker ────────────────────────────────────────────
wt=$(newlane ag-typecheck-repair)
start ag-typecheck-repair coder "$wt" "# Task — repair the broken typecheck on main (BLOCKS EVERY OTHER LANE)

\`cd daemon && bun run typecheck\` FAILS on main right now:

    inbound-media-pipeline.test.ts(278,56): error TS2345: Argument of type
    'Uint8Array<ArrayBufferLike>' is not assignable to parameter of type
    'BodyInit | null | undefined'.

This arrived with e898ac4e (the whisper/voice-media hardening landed this
morning) and it is currently gating NINE lanes: every one of them correctly
refused to report \`clean\` while a repo check fails, exactly as fail-closed
requires. So this single break is costing the whole fleet.

Fix the type error properly. Do NOT silence it with \`any\`, \`@ts-expect-error\`,
or by deleting the assertion — the test's coverage must survive intact. Establish
what the value genuinely is at that call site and give it a correct type.

Then:
1. \`cd daemon && bun run typecheck\` must exit 0.
2. \`cd daemon && bun test\` must stay green — paste the real counts, do not
   retype numbers from any other report.
3. Add whatever guard keeps a typecheck break from reaching main again if that
   is cheap and in scope; if it is NOT in scope, say so explicitly rather than
   half-doing it.

Commit \`[CODER]\`, secret-scan, terminal report with the exact commands and their
real output."

# ── The nine tails, each rebased onto the repair once it lands ──────────────
for spec in \
  "fix2-ag-howto-core:review-ag-howto-core" \
  "fix2-ag-personas-phase1:review-ag-personas-phase1" \
  "fix2-ag-statecontract-argv:review-ag-statecontract-argv" \
  "fix2-ag-status-human:review-ag-status-human" \
  "fix2-fleet-idle:ag-fleet-idle-check" \
  "fix2-ml1:ag-ml1-alarm-classes" \
  "fix2-ml4:ag-ml4-health-honest" \
  "fix2-ml10:ag-ml10-delivery-fallback" \
  "fix2-w16:ag-w16-count-provenance" ; do
  name="${spec%%:*}"; dir="${spec##*:}"
  start "$name" coder "$LANES/$dir" "# Task — finish this lane's remaining blockers

You are continuing work already done in this worktree. Read your own previous
terminal report and the review verdict in \`reports/\` first — they define what is
left. Do not redo what is already committed here.

IMPORTANT — about the typecheck failure you may have hit: the error in
\`daemon/inbound-media-pipeline.test.ts:278\` (Uint8Array vs BodyInit) is NOT
yours. It is a pre-existing break on main from commit e898ac4e, and a dedicated
lane (\`ag-typecheck-repair\`) is fixing it in parallel right now. Do not fix it
here and do not let it block you: exclude it explicitly, state in your report that
it is external, and judge YOUR OWN work on everything else.

Close every remaining blocker that IS yours. Every bug fix ships a regression
lock proven fail-before / pass-after with real pasted output. Never report a test
count you did not personally reproduce with the command you quote.

If a blocker cannot be closed, say so plainly as \`NO-GO\` with the concrete
reason — an honest NO-GO is correct, a fake \`clean\` is not.

Commit \`[CODER]\`, secret-scan, terminal report."
done
