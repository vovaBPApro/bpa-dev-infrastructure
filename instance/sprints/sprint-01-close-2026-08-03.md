# Sprint 01 close — 2026-08-03

Planned 13:30–18:30 Europe/Warsaw. Closed early, at 15:5x, with every planned row
landed. Plan: `instance/sprints/sprint-01-2026-08-03.md`.

## Verified the ungameable way

The plan committed to a close condition that could not be gamed: **re-execute each
row's acceptance command fresh, against the exact landed SHA, at report time** — not
trust a lane's self-reported exit code. Counting rows marked `done` is gameable in
precisely the way counting review rounds was.

Run at `51ae687` (= `origin/main`) in a clean checkout:

| row | acceptance command | exit |
|---|---|---|
| V3-0.1 | `env -u BUN_BIN bash gate/land-target-branch.test.sh` | 0 |
| V3-0.2 | `env -u BUN_BIN bash gate/lane-exit.test.sh` | 0 |
| V3-0.3 | `env -u BUN_BIN bash gate/land-rollback.test.sh` | 0 |
| V3-0.4 | `env -u BUN_BIN bun test tools/check-decision-ledger-drift.test.ts` | 0 |
| V3-1.2 | `env -u BUN_BIN bun test bootstrap/check-unit-drift.test.ts` | 0 |
| V3-1.3 | `env -u BUN_BIN bun test tools/whisper/install.test.ts` | 0 |
| V3-1.4 | `env -u BUN_BIN bun test hygiene/reap.test.ts` | 0 |

Plus `env -u BUN_BIN bun test` → **438 pass, 3 skip, 0 fail** across 48 files.

One command exits non-zero, correctly: `bash bootstrap/check-unit-drift.sh` → **1**,
because nothing is deployed or armed on this host under HR-1720. The checker reporting
`bpa-orchestrator-watchdog.*` as DRIFT is it doing its job — that unit is genuinely
still not installed, which is the 2026-08-01 incident, still open by decision.

## What landed

Eleven commits reached `origin/main`, `2687420` → `51ae687`.

- **V3-0.1** `gate/land.sh --target-branch` — landing onto a non-default branch was
  impossible; every lane targeting v3 produced work with nowhere to go.
- **V3-0.2** `gate/lane-exit.sh` — a lane self-checks its terminal report against
  `gate/completion-guard.ts` before ending, instead of the report being validated days
  later at landing time. **Landed PARTIAL, honestly labelled**: the guard is
  *advisory*, not structural — nothing in `orchestrator/`, `core/` or the watchdog
  invokes it, so a lane can still skip it. Tracked as V3-0.5.
- **V3-0.3** the landing gate no longer lies about rollback. It used to print
  `verdict=aborted` while leaving the target branch advanced at the merged commit with
  a dirty tree — observed live twice. Now the rollback is verified on both ref position
  and tree cleanliness, and when restoration cannot be proven it reports
  `verdict=rollback-failed`.
- **V3-0.4** the decision ledger audits itself, with an executor.
- **V3-1.2** 17 unit templates plus a drift checker with an independent manifest, so a
  *deleted* template is caught, not just a changed one. Product-named units moved to
  `instance/units/` per HR-309.
- **V3-1.3** `tools/whisper/install.sh` — v3 could call whisper and could not install
  it. Container proof deferred to V3-1.1.
- **V3-1.4** `hygiene/reap.sh` with 18 tests and an executor. Cron arming deferred.

## The review cap did its job, twice

`instructions/review-policy.md` caps an item at three review rounds; at the cap
HR-1726 allows two exits — escalate the concern to an executable lock, or park.

V3-0.3 and V3-1.4 both reached the cap. Both took the lock exit. In both cases the
orchestrator verified the lock red at the prior tip and green at the candidate
personally, in a throwaway clone, rather than accepting the lane's word:

- V3-1.4 at `fec502d`: `16 pass, 2 fail` — the two new trailing-newline assertions.
  At `a170a53`: `18 pass`.
- V3-0.3 at `5d1c16d`: `assertion failed: grep -Fq RESULT: STALE …`. At `45a395a`:
  `land rollback tests: pass`.

This morning the `authority` epic had run rounds r6 through r23 across 184 branches
and landed nothing. That is what the cap exists to stop, and today it stopped two
items from going the same way — without discarding their work.

## What the reviews caught that the lanes did not

Worth recording, because it is the argument for the cost of independent review:

- The reaper would have **deleted the branch `v3`** — three separate times, by three
  different routes: a missing protect-list file, a trailing blank line that killed the
  script under `set -e`, and a final line lacking a trailing newline. Each was
  *reproduced*, not argued.
- The unit drift checker reported **exit 0 with no mention of the watchdog** when its
  template was deleted — the 2026-08-01 incident recurring one layer up, inside the
  guard built to prevent it.
- The rollback fix, once correct, became **too strict**: on a host where 224 of 226
  processes belong to other uids, a non-root scanner could never clear even a genuinely
  stale lock. Caught by asking the opposite question as well as the obvious one.

## Adversarial prediction, settled

The planning consilium's adversarial seat predicted **3 rows** by 18:30 and that
prediction was recorded in the plan in advance, so it could not be adjusted afterwards.
Actual: **4 rows**, closed early. The seat's reasoning — that the remaining rows were
Tier A and would each cost a full review cycle — was right about the cost; three of the
four did take multiple rounds.

Its throughput correction was also right and its clock correction essential: the plan
had read Telegram's UTC timestamps as Warsaw time and set the window two hours wrong.

## Carried into sprint 02

- **V3-1.1** `bootstrap/install.sh` — the block everything else waits on. Until it
  exists there is no container, so V3-1.3's and V3-1.4's deferred proofs cannot run and
  no Phase 1 acceptance criterion requiring a container can be executed.
- **V3-0.5** make the lane-exit guard structural.
- **V3-0.6** the fleet counter measures tmux sessions, not the lanes actually running.
- **V3-0.7** `refs/stash` is repo-global; two lanes in sibling worktrees collided
  through it today and a foreign file entered the wrong tree.
- Follow-up on V3-1.2: a test pinning the units the 2026-08-01 incident named, so a
  coupled deletion of a template *and* its manifest line cannot pass silently.
