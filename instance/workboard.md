# v3 workboard

The tracked plan for finishing v3. Built from measurements taken 2026-08-03, not
from estimates. Sources, all on `v2-deprecated`:
`instance/v3-mechanism-gap-2026-08-03.md` (126 missing mechanisms, 33 blocking),
`instance/consilium2-2026-08-03-v3-viability.md`, `instance/reap-executed-2026-08-03.md`,
`instance/report-pinning-convention-2026-08-03.md`.

Every row has an acceptance criterion that is a command, not a judgement. A row is
done when the command exits 0 at a landed SHA. Rows are ordered by dependency: a
later phase cannot start honestly until the earlier one holds, because the earlier
phase is what makes "done" measurable at all.

Operator constraints in force: HR-1720 (host deployment deferred to v3, so all of
this lands in the repo and is proven in a container, not by touching this host),
HR-1718 (v3 stays the working line; cutover last), HR-1726 (review rounds capped at
3, escalate to executable locks).

---

## Phase 0 — make the loop work at all

Nothing else can be trusted until a lane can finish, be reviewed, and land without a
human nursing it.

| id | row | acceptance | state |
|---|---|---|---|
| V3-0.1 | Port `gate/land.sh --target-branch` from the abandoned line. Without it landing is only possible onto the repository default branch. | `env -u BUN_BIN bash gate/land-target-branch.test.sh; echo $?` → 0 | **done** — landed `f331295`, `verdict=landed review=accepted`. See "Nested gate invocations" below: the apparent flakiness was the verify command, not the change. |
| V3-0.2 | Lane terminal reports: enforce the corrected convention. The report is an external file naming the branch tip; a report committed into its own branch can never match the tip (proven, see `report-pinning-convention`). Wire `gate/completion-guard.ts` at lane exit, not only at land time. | a dispatched lane cannot end while `bun gate/completion-guard.ts --report <path> --repo . --branch <tip>` exits non-zero | **partial** — `gate/lane-exit.sh` wraps `gate/completion-guard.ts` and is taught in `instructions/lane-lifecycle.md` (coder baseline, self-check) and `instructions/orchestrator-cold-start.md` §2.5 (orchestrator, right after the lane reports done). See "Two live report contracts" below: `orchestrator/dispatcher.ts`'s separate inline check was left un-reconciled, on purpose, and is documented as remaining work. |
| V3-0.3 | Landing gate rollback defect: an aborted landing left local `main` advanced to the merged commit with a dirty tree. Origin was never touched, so the push boundary held, but the local ref moved after `verdict=aborted`. | a test that aborts a landing at post-merge-verify and asserts `git rev-parse <target>` is unchanged | **done** — landed `5f24575`. The gate no longer prints `verdict=aborted` while leaving the target advanced; rollback is verified on ref position AND tree cleanliness, and reports `verdict=rollback-failed` when restoration cannot be proven. Took three review rounds and closed by the HR-1726 lock exit; lock verified red at `5d1c16d`, green at `45a395a` by the orchestrator directly. |
| V3-0.4 | Ledger drift check — **done**, landed 2687420 + 76c5363. | `bun test tools/check-decision-ledger-drift.test.ts` → 2 pass | **done** |
| V3-0.5 | Make the lane-exit guard structural rather than advisory. Independent review of V3-0.2 confirmed nothing in `orchestrator/`, `core/` or the watchdog invokes `gate/lane-exit.sh` — it is delivered as instruction prose only, so a lane can skip it. Correct, fail-closed logic with no executor is this repository's dominant defect shape. | `grep -rn "lane-exit.sh" orchestrator/ core/` returns a real caller, and a lane that skips it cannot report done | **partial** — investigation found no single choke point: real AI coder-lane dispatch is entirely prose-mediated (`instructions/orchestrator-cold-start.md`), `orchestrator/dispatch-lane.sh` gates only launch (the prompt marker), and `orchestrator/dispatcher.ts`'s fenced-dispatch `validTerminal()` is exercised only by `tests/fixtures/*.ts` synthetic workers, never by a real lane. `core/schema.ts`'s `DurableStore.completeLane()` — the one method both callers funnel through — is deliberately storage-only (`core/schema.test.ts`, `core/state.test.ts` exercise it with symbolic, non-filesystem evidence on purpose) and correctly cannot host a git-aware gate. `core/mission-cli.ts`'s `lane complete` action is the one real, git/filesystem-aware caller: it took a bare `reportPath` string and never read it. It now shells out to `gate/lane-exit.sh` (env stripped of `BUN_BIN`, see "Nested gate invocations") before calling `completeLane`, requires a `--branch`-equivalent 7th argument, derives the recorded sha from the guard-checked report rather than trusting the caller, and cross-checks the caller's claimed verdict against the guard's. `grep -rn "lane-exit.sh" orchestrator/ core/"` now returns `core/mission-cli.ts`. Proven with a real caller-level before/after: pre-change, `lane complete` recorded `terminalVerdict: clean` for a fabricated sha and a reportPath that did not exist on disk (captured output in the terminal report); post-change the identical call is refused (`ERROR GATE ... FAIL report-file missing`, exit 1, lane state stays `running`). `core/mission-cli.test.ts` adds the three required rejection shapes (intermediate SHA, missing report, report committed into its own branch) plus a same-owner/token retry-after-rejection case and a claimed-verdict-vs-report mismatch case, all proven red before the fix and green after. `orchestrator/dispatcher.ts`'s parsing hardened too (new `gate/report-contract.ts` shared, anchored `lineValue()` parser replaces a `report.includes()` substring check that a "line-injection" regression test proves was foolable), but its `validTerminal()` still runs its OWN bespoke fencing contract, not `gate/completion-guard.ts`'s — reconciling that still needs the branch-field schema change V3-0.2 flagged as bigger than one row, since it is exercised only by synthetic fixtures with zero real-lane traffic today. **Remains, next row:** (a) real AI coder-lane dispatch still has no code-mediated choke point at all — nothing in this repo can stop an LLM orchestrator from simply not calling `mission-cli.ts lane complete`, only make that call gated when it IS made; (b) `orchestrator/dispatcher.ts`'s fenced protocol is still a second, unreconciled report contract per "Two live report contracts" below; (c) `instructions/orchestrator-cold-start.md` references `mission transition`/`lane transition` CLI actions that do not exist anywhere in `core/mission-cli.ts` — found during this row's investigation, flagged in the doc itself, not fixed here (mission/manager have no state-machine transitions at all beyond their fixed creation state). |
| V3-0.6 | **New.** The fleet counter measures the wrong thing. The autonomy nudge reports `running lanes=0` while lanes are demonstrably working, because `tools/state-contract/check.ts:FLEET-IDLE` counts system lane units (tmux sessions) and not lanes running as separate agent sessions. A counter that cannot see the work it exists to measure will report FLEET-IDLE during a busy night and silence during an idle one. | seed N running lanes by the mechanism actually used for dispatch; the reported count equals N | **done (PARTIAL)** — landed `1f30726`. `core/mission-cli.ts lane complete` took a report path and NEVER READ IT; a lane could record itself terminal pointing at a nonexistent file. It now shells out to `gate/lane-exit.sh` and derives the recorded SHA from the guard-checked report. Also replaced `dispatcher.ts`'s foolable `report.includes()` substring check with a shared anchored parser (`gate/report-contract.ts`) — a forged report used to pass. Open: no code choke point forces an orchestrator to call the gated CLI (no launcher on v3); `dispatcher.ts`'s fenced protocol is a second contract, confirmed inert; `orchestrator-cold-start.md` cites `mission/lane transition` commands that do not exist. |
| V3-0.7 | **New.** `refs/stash` is repo-global, not per-worktree. Two lanes running in sibling worktrees of this repo share one stash stack; that collided today and pulled a foreign file into the wrong worktree. At the fleet floor of 10 this silently mixes two agents' work, and no test would show it because each file stays individually valid. | two concurrent lanes each stash and restore; neither sees the other's entry | implemented — scratch commits are worktree-local; `hygiene/check-shared-stash.sh` rejects a non-empty shared stash |
| V3-0.8 | **New.** `bootstrap/check-unit-drift.sh`'s manifest is not anchored to anything harder to edit than itself: deleting a template AND its `expected-units.tsv` line passes silently (reproduced in review). | a test asserting the manifest lists at least the units the 2026-08-01 incident named — orchestrator, watchdog service and timer, telegram-daemon | **coder complete; Tier-A review required** — the test now independently pins all four incident units by name in both the manifest and template tree; coupled deletion is proven red and the lane tip green. |
| V3-0.9 | **New.** The ledger drift check resolved only a local `v2-deprecated` branch, so a fresh clone with only `origin/v2-deprecated` failed closed despite carrying the donor ref. | `bun test tools/check-decision-ledger-drift.test.ts` includes a temporary repository where the donor exists only at `refs/remotes/origin/<name>` and exits 0; an absent donor still fails closed | **done** — the checker tries the caller's ref first, then its `origin/` remote-tracking name, without fetching or writing refs; the regression lock was red before the change and all 3 cases are green after it. |
| V3-0.10 | **New.** The privilege-drop fixture in `hygiene/reap.test.ts` inherited an untraversable lane `TMPDIR`, so it failed before reaching the unreadable protected-list behavior. | both ambient and default `TMPDIR` runs pass; an explicit dropped-privilege traversal/execute probe names fixture setup failures; fail-open mutation makes the regression case red | **done** — the copied toolroot now uses the system temporary directory derived with ambient temp variables removed, is always cleaned up, and its unprivileged traversal/execute precondition is checked before the subject assertion. |
| V3-0.11 | **New.** The landing gate collected no `*.test.sh` files, leaving all nine tracked shell tests inert, including the gate's own regression suite. | the gate-collected `tools/shell-test-tier.test.ts` independently pins all nine paths, executes every runnable test with `BUN_BIN` cleared, and names every measured exclusion with its blocker | **coder complete** — seven measured-green shell tests are wired into the framework suite. Two measured failures remain explicit exclusions: `gate/land-rollback.test.sh` fails its root/privilege-drop dirty-tree fixture; `orchestrator/watchdog.test.sh` uses the obsolete lane-complete CLI without the required branch argument. |

## Phase 1 — a clean server can be rebuilt from this repo

The 33 blocking mechanisms from the gap inventory. Until this phase holds, wiping the
host is unrecoverable and Hard Floor 5 is not satisfied by v3 alone — the only copy of
the rebuild path is on `v2-deprecated`.

| id | row | acceptance | state |
|---|---|---|---|
| V3-1.1 | Port/rewrite `bootstrap/` — `install.sh`, `deploy-host-mechanism.sh`, `check-unit-drift.sh`, `check-deployed-drift.sh`, `telegram-transport-preflight.sh` and their tests. | `bash bootstrap/bootstrap.test.sh; echo $?` → 0 | **stage 1 done** — landed `88361ff`. Ports `ensure_prerequisites`, `install_bun`, `sync_repository`, `render_environment`, `initialize_state_db` with `--dry-run`/`--verify-source`, validated by stub fixtures the way the donor does, not a container. Review round 1 rejected it twice over: `sync_repository` fast-forwarded whatever branch happened to be checked out (on this host that is `v2-deprecated`, so it would have reported a clean bootstrap while leaving the machine on the abandoned line), and `unzip` had been trimmed although `bun.sh/install` hard-fails without it. Both fixed and locked. Still later rows: `--verify`, `activate_units`, watchdog arm/disarm. **Stage 2 PARKED 2026-08-03** — `install_hygiene_cron`, `run_install_test_gate` and `render_units` exhausted the HR-1726 three-round cap without an ACCEPT. Round 3's blocking finding, reproduced by the reviewer: `unit_publication_signal` resets HUP/INT/TERM to default before rollback begins, so a second signal during rollback leaves a half-restored unit set and emits neither `rolled-back` nor `rollback-failed`. Work retained on branch `ag-s3-2-r3` (`09082ecdf1d41c88f49a8a83b957aa46958e6e94`, pushed to origin, do not reap). Evidence, what the three rounds did establish, and the lock the recut must satisfy: `instance/parked/V3-1.1-stage2-2026-08-03.md`. |
| V3-1.2 | Port the 17 unit templates under `bootstrap/units/`, including `bpa-telegram-daemon.service.in` and `bpa-orchestrator.service.in` — the units that start the system at all. | **done** — landed `51ae687`. Templates plus a drift checker with an INDEPENDENT manifest (`instance/expected-units.tsv`), so a deleted template is caught and not only a changed one; round 1 was rejected because deleting the watchdog template produced exit 0 in silence. Product-named `agentic-bpa-*` units moved to `instance/units/` per HR-309. Follow-up filed: a test pinning the units the 2026-08-01 incident named, so a coupled delete of template AND manifest line cannot pass. |
| V3-1.3 | `tools/whisper/install.sh`. v3 has `daemon/transcribe.ts`, which calls whisper, and nothing that installs it. Raised by the operator directly (Telegram 1760). | in a clean container: install, then `$WHISPER_BIN --version` exits 0, then a voice fixture transcribes | **landed `fac4f35`, container proof deferred.** **Container proof now closed — landed `e32efa5`.** Installer and 9 tests landed; an independent supply-chain review returned ACCEPT and answered yes to running it as root on a clean server. Source pinned by 40-hex commit (a moved tag aborts the build), model checksum verified before the file is moved into place, installer paths byte-identical to `resolveWhisperConfig()`. NOT proven without a container: a real model download against production URLs, a non-stubbed transcription, the `apt-get` branch. Blocked on V3-1.1. |
| V3-1.4 | `hygiene/reap.sh` + `install-cron.sh`, and an executor. On the old line the cron was tracked and never invoked (`crontab -l` → "no crontab for root"), which is why 1372 branches accumulated. | reap runs on a timer in the container and a seeded stale branch disappears | **done** — landed `d7abf55`, 18 tests. Three review rounds, each catching a different route to deleting the branch `v3`: a missing protect list, a trailing blank line killing the script under `set -e`, and a final line without a trailing newline. Closed by the HR-1726 lock exit; lock verified red at `fec502d` (16 pass, 2 fail), green at `a170a53`. Cron arming still deferred to V3-1.1. |
| V3-1.5 | `meteorite/run.sh` — the clean-rebuild proof itself, absent from v3 while the plan measured v3 against it. | `bash meteorite/run.sh` from a clean clone in Docker exits 0 |

## Phase 2 — supervision that does not depend on the Human noticing

The 2026-08-03 investigation found the watchdog had not run since 2026-08-01 12:35:57Z,
`orch-runtime-watchdog.timer` installed but never armed, and
`notify_human_below` declared in `params.yaml` and read nowhere.

| id | row | acceptance |
|---|---|---|
| V3-2.1 | Unattended orchestrator restart, armed by the bootstrap path, not by hand. | kill the orchestrator in a container; it is back within the configured interval |
| V3-2.2 | Human escalation when running lanes fall below `fleet.notify_human_below`. Make the knob live or delete it — a config promising escalation and delivering nothing is worse than none. | seed 0 lanes in the container; a Human-addressed message is emitted |
| V3-2.3 | Deployment-drift detection that is not itself subject to the drift it detects. `bpa-deploy-drift-guard` was among the 8 units missing from the host, which is why the gap went unreported for days. | remove a deployed unit in the container; the guard reports it and exits non-zero |
| V3-2.4 | Orchestrator model pin asserted at startup; a mismatch between the pin and the live session is a fail-closed error. HR-1680: the orchestrator may never change its own model, and v3 must make it structurally impossible. | start with a mismatched pin; startup refuses |

## Phase 3 — requirements that were agreed and silently dropped

From the requirements-coverage audit. These are not new features; each was ruled by the
Human and then lost when the fork copied a file tree instead of a ledger.

| id | row | source |
|---|---|---|
| V3-3.1 | `/model` switches the live session, not only the next relaunch. | HR-1349 |
| V3-3.2 | Spark routable as the cheap tier for mechanical lanes; quota is measured today and cannot be spent. | HR-1734, restating 1562 |
| V3-3.3 | Weekly per-provider model discovery with fit metadata, pluggable providers, fail-closed to the last committed catalog. | HR-1739 |
| V3-3.4 | Review round cap enforced by a counter and the gate, not by prose. The current rule carries a PROSE ONLY banner because nothing counts rounds. **Plus a no-progress detector** (operator ask, Telegram 1780): the cap counts attempts, which is not the same as detecting a stuck item. If N consecutive rounds on one item produce no landed SHA, park it automatically — an item can burn rounds while looking busy, which is exactly what the `authority` epic did across r6–r23. | HR-1726, HR-1780 |
| V3-3.5 | Decision-request options explained in the message body; a button label is ~3 legible words. | HR-1752 |
| V3-3.6 | Vendor quota display, so a quota cliff is visible before it is hit. | ML-6 |
| V3-3.7 | Self-hosted, user-teachable OCR. | HR-1418 |

## Phase 4 — cutover

Only after Phases 0–2 hold.

| id | row | acceptance |
|---|---|---|
| V3-4.1 | v3's daemon proven to hold the Telegram channel across a restart. | restart in the container; a round-trip message survives |
| V3-4.2 | Clean-machine rehearsal from a bare container using only this repo. | `meteorite/run.sh` green from a fresh clone |
| V3-4.3 | Host cutover — the operator's "почищу сервак і з нуля почнемо". | his explicit go, after 4.1 and 4.2 |

---

## Two live report contracts — read before touching lane completion again

V3-0.2 set out to wire `gate/completion-guard.ts` at lane-exit time (done: see
`gate/lane-exit.sh`, `instructions/lane-lifecycle.md`,
`instructions/orchestrator-cold-start.md` §2.5). Investigating the wiring found
a second, pre-existing, un-related terminal-report contract that the row as
briefed would have left silently untouched:

1. `gate/completion-guard.ts` — the CLAUDE.md contract: `commit:` / `verify:` /
   `result:` / `secret-scan:` / `remaining:`, git-branch-aware (checks
   `commit:` against a branch tip). Used by `gate/land.sh` at landing time, and
   now also by `gate/lane-exit.sh` at lane-exit time. **This is the
   authoritative contract for real, git-branch-centered coder-lane reports** —
   the path documented in `instructions/orchestrator-cold-start.md` and the one
   every dispatched coder lane is taught.
2. `orchestrator/dispatcher.ts:validTerminal()` — a separate, older, lower-level
   contract: `lane:` / `attempt:` / `commit:` / `result:` plus
   laneId/fencingToken/ownerToken authentication, checked inline (no
   subprocess, no completion-guard.ts). It has no branch concept at all —
   `LaneRecord` carries no branch field — so it cannot check tip-pinning. It
   guards `core/DurableStore`'s fenced dispatch/retry state machine
   (`dispatchOnce`/`reconcileRunning`), exercised today only by the synthetic
   workers under `tests/fixtures/*.ts` (`noop-worker.ts`, `gated-worker.ts`,
   `forged-worker.ts`, `never-exit-worker.ts`). It is NOT the path real AI
   coder lanes go through — `orchestrator/dispatch-lane.sh` says outright "the
   repo has no lane launcher yet" — so this contract has no live coder lane to
   diverge from today, but it is real, tested, merged code, and it disagrees
   with contract 1 in both field names and in whether tip-pinning is checked
   at all.

These were deliberately NOT reconciled in V3-0.2 — full reconciliation needs a
branch field on `LaneRecord`/`DurableStore` (a schema change touching
`core/schema.ts`, `core/mission-cli.ts`, and every dispatcher test fixture),
which is bigger than this row. `orchestrator/dispatcher.ts` carries a comment
at `validTerminal()` pointing back here. Remaining work, next row: either (a)
add branch-awareness to `LaneRecord` and make `validTerminal()` delegate to
`gate/completion-guard.ts` for report-shape and tip-pinning, keeping only the
attempt-fencing fields as dispatcher-specific, or (b) if `dispatcher.ts`'s
fenced primitive is retired before it is ever wired to real lanes, delete
`validTerminal()`'s bespoke contract instead of reconciling it. Do not treat
V3-0.2 as fully closing "one report contract" until one of those happens.

V3-0.5 update: the two contracts are still not the same shape (that still
needs the branch-field schema change above), but they no longer parse their
respective `label: value` lines two different ways. `gate/report-contract.ts`
extracts `gate/completion-guard.ts`'s anchored, single-match `lineValue()`
parser; `orchestrator/dispatcher.ts`'s `validTerminal()` now imports and uses
the same function instead of a `report.includes()` substring test (which a
regression test proves could be fooled by the right text appearing anywhere
in the report, not only on its own `commit:` line). Separately,
`core/mission-cli.ts`'s `lane complete` — the one real, git/filesystem-aware
caller of `DurableStore.completeLane()` (`orchestrator/dispatcher.ts` calls
it directly too, but only from the synthetic fenced-dispatch path) — now
shells out to `gate/lane-exit.sh` and refuses to record a lane as terminal
when the guard fails. See the V3-0.5 row above for what that does and does
not close.

## Nested gate invocations — a property to know before writing a `verify:`

`gate/land-lib.sh:19-23` (`land_resolve_bun`) refuses to run when `BUN_BIN` is already
set in the environment:

```sh
if [ -n "${BUN_BIN:-}" ]; then
  echo "LAND step=preflight status=fail detail=caller-bun-override-refused" >&2
  return 1
fi
```

That is a deliberate supply-chain control: a caller must not be able to choose which
`bun` binary the landing gate trusts. It resolves only from the fixed host baseline
`/usr/local/bin:/usr/bin:/bin` and canonicalises symlinks.

The consequence is easy to trip over. `gate/land.sh` exports `BUN_BIN` for its own
run, so **any test that itself invokes `gate/land.sh` will fail when used as a
landing's `verify:` command** — the nested gate correctly refuses. It passes standalone
and fails under the gate, which looks exactly like flakiness and is not.

This cost roughly an hour of misdiagnosis on 2026-08-03, including a workboard row
wrongly marked blocked. The fix in a `verify:` line is `env -u BUN_BIN`, which restores
the standalone condition without weakening the control — the nested gate still resolves
its own bun from the trusted path.

Note also that this host carries two bun installations: `/usr/local/bin/bun` 1.2.22
(the one the gate's trusted path finds) and `/root/.bun/bin/bun` 1.3.14 (the one on
the interactive `PATH`, which lanes test with). The gate is not wrong to pin the
baseline, but lanes verifying on a different version than the gate is a skew worth
closing in Phase 1.

## Standing check this plan creates

The fork copied files and lost rulings. `tools/check-decision-ledger-drift.sh` now
closes that for the decision ledger. The same shape is still open for mechanisms: a
scheduled inventory diff of executable mechanisms between this line and
`v2-deprecated`, failing until each absence is either ported or dispositioned with a
reason. Until that exists, Phase 1's list is a snapshot that can go stale the same way
the ledger did.
