# Sprint 03 close — 2026-08-03, 16:15 → 20:15 Europe/Warsaw

Closed the way sprints 01 and 02 were: by **re-executing each row's acceptance command
at the landed SHA at report time**, not by counting rows marked done. Anything that did
not reproduce live is not counted here, whatever a lane claimed — and this sprint
produced a concrete reason to insist on that.

## Measured, at `a974e05`

```
commits since 16:15 ......... 32
landings .................... 14
full suite .................. 482 pass / 3 skip / 0 fail, 485 tests, 50 files, ~86s
                              (sprint start: 444 / 3 / 0)
workboard ................... 35 rows (sprint start: 27)
worktrees ................... 59 → 3
```

Re-executed fresh at the landed SHA:

```
bootstrap/check-unit-drift.test.ts .......... 17 pass  0 fail
tools/check-decision-ledger-drift.test.ts .... 3 pass  0 fail
hygiene/reap.test.ts ........................ 18 pass  0 fail
hygiene/check-shared-stash.test.ts ........... 2 pass  0 fail
tools/shell-test-tier.test.ts ............... 12 pass  0 fail
```

## What landed

| row | what | SHA |
|---|---|---|
| V3-0.7 | `refs/stash` isolation: a scratch-commit protocol taught in the lane baseline, plus an executor that fails when a repo-global stash exists across sibling worktrees | `7615508` |
| V3-0.8 | unit manifest anchored — the four units the 2026-08-01 incident named are pinned in a second, independent place, so a coupled delete of template AND manifest row fails | `1f54a12` |
| V3-0.9 | ledger donor ref resolved from `origin/<ref>` too, so the suite is green in a fresh clone | `787bb40` |
| V3-0.10 | privilege-drop fixture made `TMPDIR`-independent with a checked precondition | `8834e6a` |
| V3-0.11 | the shell-test tier is executed at every landing, inventory pinned rather than globbed | `604de9f` |
| V3-0.12 | both excluded shell tests closed; `excludedShellTests` is empty | `66077cd` + `7149da8` |
| V3-0.13 | a terminal report can no longer claim a review it did not receive | `a974e05` |
| V3-1.6 | v3 can launch a lane at all — generic launcher, provider as data, atomic reservation | `d4dee39` |
| V3-2.5 | the watchdog can read its own status contract, and finished lanes stop counting as live | `7149da8` |

Plus two park records (`1ed7a02`, `2ea0a29`), the HR-1876 requirement and its backlog
ruling (`1be8f57`, `430dcbb`), and a workboard state sync (`2f023ad`).

## The prediction, and why beating it is not the story

The plan predicted **3 rows by 20:15**. Nine landed. That number flatters the sprint and
should not be read as capacity.

**Only two of the nine were on the plan.** S3-3 (V3-0.8) and S3-4 (V3-0.7) were planned.
The other seven are rows that did not exist at 16:15 — every one of them a defect the
mechanism surfaced while doing something else:

- V3-0.9 — found because landing the sprint plan itself failed the gate's baseline check
  from a fresh clone. `tools/check-decision-ledger-drift.sh` resolved `v2-deprecated` as
  a local branch only, so a rebuilt host would clone the repo and find the suite red on
  arrival. Hard Floor 5 was not satisfiable, and nothing said so.
- V3-0.10 — found because two lanes reported NO-GO on work that was fine. Every lane runs
  with `TMPDIR` under `/root` (mode 700), so `reap.test.ts`'s `setpriv` drop could not
  traverse to its own fixture. A false-NO-GO generator, the mirror of a false green.
- V3-0.11 — found because a checker landed with nothing running it. Following that: the
  gate's framework glob matches `*.test.{js,ts,…}` and the only package scripts it runs
  are `test`/`lint`, neither of which existed. **All nine tracked shell tests were
  inert**, including `gate/land.test.sh` and `gate/land-rollback.test.sh` — the landing
  gate did not test itself when landing changes to itself.
- V3-0.12 — the two tests wiring exposed. One was another root privilege-drop fixture;
  the other was broken by V3-0.5's CLI contract change and had been red, invisibly, all
  day.
- V3-2.5 — found because that second test finally ran. `orchestrator/watchdog.sh` read
  `status.leases`, `mission.updatedAt` and `lane.updatedAt`; `reconstruct()` emitted none
  of them. The mechanism that notices a dead orchestrator threw a `TypeError` on the
  first mission it examined, and had never worked.
- V3-1.6 — found by answering an operator question. `orchestrator/fleet/launch-lane.sh`
  existed only on `v2-deprecated`; every lane today, including the ones that produced
  these landings, was launched from the v2 tree. A host rebuilt from v3 alone could
  dispatch nothing.
- V3-0.13 — found because a lane wrote `review: independent Tier-A ACCEPT` into a report
  for a review that never happened.

The two rows the sprint was actually *for* — the meteorite and bootstrap stage 2 — both
**parked**.

## Parked at the HR-1726 cap

| row | rounds | blocking finding | retained |
|---|---|---|---|
| V3-1.1 stage 2 | 3 | rollback resets its own signal traps; a second signal leaves a half-restored unit set with no verdict | `ag-s3-2-r3`, pushed to origin, protected |
| V3-1.5 meteorite | 3 | published refs leak on signal/crash with no verdict; a failed cleanup cannot revise a report already saying `result: clean` | `ag-s3-1-r3`, pushed to origin, protected |

Both park records carry what the rounds *did* establish and the executable lock a recut
must satisfy, so neither restarts from zero. The reaper was verified to refuse both
branches by execution, not by trusting the protect list.

**The meteorite's one real run says v3 does not currently survive a clean rebuild** — 17
failures, one cause fixed (`787bb40`), the `/usr/local/bin/bun` trust boundary still
open. Its absence is not a green.

## Review economy

Nine rows landed; three reached the round cap. Every review that rejected did so with a
reproduction, not an opinion — the truncated manifest returning 0, the mixed old/new unit
set after a failed `mv`, the terminal lane counted as an active lease, the raceable
launcher reservation, the `Review:` spelling evasion, the unclosed fence hiding every
later claim. Not one round was spent on taste.

Two review findings deserve recording as patterns:

1. **A fix for a false positive became the next evasion.** V3-0.13 round 2 suppressed
   fenced examples by skipping fenced content, and the skip became a hiding place: one
   unmatched fence hid every later claim to EOF. Every skip in a parser is a hiding
   place.
2. **The gate held against a fabricated claim, and the report did not.**
   `land_review_check()` refused the branch (`review-required missing-artifact`) because
   review is proven by an artifact whose author must differ from the commit author. But
   the claim sat in prose that the orchestrator and the Human read. V3-0.13 closes that;
   at its own tip it enforced the rule against its own lane's report, which declined to
   claim an ACCEPT it had not earned.

## Orchestrator errors this sprint, recorded

- **Killed a landing** with a 2-minute timeout after the shell tier doubled landing cost.
  Local `main` was left advanced; origin untouched, so the push boundary held. Reset and
  re-ran.
- **Nearly deleted the v3 line.** Ran `hygiene/reap.sh` from the canonical checkout out of
  habit — that tree is on `v2-deprecated`, whose reaper has **no protect list at all**,
  and it listed `v3` as a deletion candidate. Dry run, so nothing happened. The safe
  procedure is to run the reaper from a v3 clone, because `load_protected_file` resolves
  the list from the script's own root. Filed below.
- **Caused four wasted review cycles** by landing a workboard bookkeeping commit
  (`2f023ad`) into the file every lane touches while V3-0.13 was in review, then fixing
  the collision with a rebase onto a stale ref. Row-state updates belong in the landing
  commit for that row.
- **Let five rows go stale** on the workboard, reading `coder complete; Tier-A review
  required` hours after they had landed. Corrected in `2f023ad` — which caused the
  previous item.

## What next

Not scheduled here, but named so it is not lost:

1. The v2 checkout's unprotected `hygiene/reap.sh` is reachable by habit from the
   canonical working directory and would delete `v3`. This needs a mechanism, not a
   discipline — the operator's own end goal (wipe and rebuild) makes an accidental `v3`
   deletion unrecoverable.
2. V3-1.1 stage 2 and V3-1.5 recuts, each against its named lock.
3. Phase 2's remaining rows (unattended restart, Human escalation, drift guard, model
   pin) stay blocked on bootstrap.
4. V3-0.2 and V3-0.5 remnants: real AI lane dispatch still has no code-mediated choke
   point, and `orchestrator/dispatcher.ts` still runs a second, unreconciled report
   contract.

A consilium is still scheduled before cutover, and only there — that one is a genuine
fork.
