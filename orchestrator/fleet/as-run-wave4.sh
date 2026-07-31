set -euo pipefail
REPO=/root/bpa-dev-infrastructure; LANES=/root/.cache/infra-lanes
BASE=$(git -C "$REPO" rev-parse HEAD)
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
newlane() { local name="$1"; local wt="$LANES/$name"
  [ -d "$wt" ] && { git -C "$REPO" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"; }
  git -C "$REPO" branch -D "$name" >/dev/null 2>&1 || true
  git -C "$REPO" worktree add -b "$name" "$wt" "$BASE" -q; echo "$wt"; }

wt=$(newlane ag-ci-dispatch-gate)
start ag-ci-dispatch-gate coder "$wt" '# Task — CI is RED: dispatch-check refuses its own valid packs in a fresh clone (TOP PRIORITY)

GitHub CI on `main` fails: jobs `bun-suites` and `shell-suites` are red.

REPRODUCED locally, and this is the actual cause — do not chase the typecheck,
that was a separate blocker and is already fixed and landed (b096cb5f).

Reproduction (a fresh SHALLOW clone, which is what actions/checkout does):

    cd /root/.cache && rm -rf ci-repro
    git clone --depth 1 file:///root/bpa-dev-infrastructure ci-repro
    cd ci-repro/daemon && bun install --frozen-lockfile && cd ..
    bun test tools/instructions/dispatch-check.test.ts

Result: 6 failures across `tools/instructions/dispatch-check.test.ts` and
`dispatch-check-fullpack.test.ts`, including:
  - "exit 0 for a complete compose-produced prompt" -> got exit 3 (3 = REFUSAL)
  - "accepts an unmodified compose.ts-produced pack" -> refused
  - "refuses a hash mismatch in a declared materialized document" -> wrong result
  - the `dispatch-lane.sh` wrapper cases

So in a clean checkout the dispatch gate REFUSES a pack that compose.ts itself
just produced. The same tests pass in the working tree, which is why this was
invisible until CI.

Investigate the real mechanism before changing anything. Strong hypothesis to
CONFIRM OR REFUTE with evidence: the pack marker embeds an L1 SHA
(`<!-- compose.ts pack v1 role=... l1=<sha> -->`) and its derivation behaves
differently in a shallow/fresh clone than in a full working tree. Check what the
SHA is computed from and whether the depth-1 history or missing local state
changes it.

Constraints:
- The gate is FAIL-CLOSED by design and must STAY fail-closed. Do not "fix" this
  by making refusal lenient, by skipping the tests in CI, or by special-casing
  CI. A gate that passes because it stopped checking is the false-green class
  this repo has closed three times already.
- The correct fix makes the SHA derivation deterministic and correct in BOTH a
  full working tree and a fresh shallow clone.

Evidence required: the fresh-clone reproduction above must go from 6 failures to
0, AND the full working-tree run must stay green. Paste the real output of both.
Also run `.github/scripts/run-suites.sh bun` in the fresh clone.

Then look at `shell-suites` (2 annotations) the same way and report whether it
shares this root cause or is separate — do not assume.

Commit `[CODER]`, secret-scan, terminal report with the exact commands and their
real output.'

for spec in "fix3-ml1:ag-ml1-alarm-classes" "fix3-ml4:ag-ml4-health-honest" "fix3-ml10:ag-ml10-delivery-fallback" "fix3-w16:ag-w16-count-provenance" "fix3-ml2:ag-ml2-autonomy-keepalive" "fix3-fleet-idle:ag-fleet-idle-check"; do
  name="${spec%%:*}"; dir="${spec##*:}"
  start "$name" coder "$LANES/$dir" "# Task — finish this lane and get it landable

Read your own previous terminal report in this worktree first; it says what is
left. Do not redo committed work.

GOOD NEWS: the typecheck failure that blocked you is FIXED and LANDED on main
(b096cb5f, a one-line type narrowing in daemon/inbound-media-pipeline.test.ts).
REBASE onto the latest origin/main so you pick it up, then re-run your checks.
That blocker is gone — it must not appear in your report again.

Close every remaining blocker that is genuinely yours. Regression locks proven
fail-before / pass-after with real pasted output. Never report a count you did
not personally reproduce.

Note: CI is currently red for an UNRELATED reason (dispatch-check refuses valid
packs in a fresh clone; lane ag-ci-dispatch-gate owns it). Do not chase it and do
not let it block you — exclude it explicitly and say so in your report.

If a blocker genuinely cannot be closed, report NO-GO with the concrete reason.
An honest NO-GO is correct; a fake clean is not.

Commit \`[CODER]\`, secret-scan, terminal report."
done
