# Branch inventory, 2026-08-05

Row V3-5.13. Ordered by the operator (Telegram 2525) after he asked how many branches exist
and how many are in an unknown state: *«прибирання це завжди добре»*. Hard Floor 12 applied.

Every branch that existed on this host or on `origin` at the time of the sweep appears below
with a disposition and the evidence for it. Deletions are the consequence of this file, not
the other way round: a future reader can re-run the named command and get the same answer
without re-deriving the classification.

**Pinned SHAs.** Classification and every deletion were decided against
`main = 42a0cdbf91beaa50b3ece6fbc26a943f840744a2`. `main` advanced several times during the
sweep (`7e34fbd` → `4060137` → `42a0cdb` → …, all `[ORCH]` commits), which is why every
judgment below names the SHA it was made against rather than "main". It is harmless: "carried
by `main`" is monotone, so a later `main` can only carry more, never less. Nothing here
touched `main`.

## Counts

| | before | after |
|---|---|---|
| local branches | 80 | 17 |
| remote branches on `origin` | 46 | 40 |
| registered worktrees (14 branch-attached + 3 detached after) | 71 | 17 |
| `refs/bpa-review-attempts/*` + `refs/bpa-review-attempt-mirrors/*` on origin | 90 | 90 |

63 local branches deleted, 6 remote branches deleted, 54 worktrees removed. The review-attempt
namespaces were not touched — they are the round counter's durable state (V3-3.4).

### The dispatch's numbers, re-measured

The brief said to verify them. Three of the five reproduce; two do not.

- **`46 reapable` — reproduces.** 49 local refs were ancestors of `origin/main` at `7e34fbd`;
  minus `main` itself and the two lane branches created minutes before the measurement
  (`ag-v3-5.13`, `ag-v3-5.14`) that is 46.
- **`19 in an unknown state` — reproduces exactly.** The same 19 branches, listed below.
- **`78 local branches` — actually 80**, for the same reason: `ag-v3-5.13` and `ag-v3-5.14`
  were cut after the measurement was taken.
- **`50 remote` — actually 46.** `git for-each-ref refs/remotes/origin` returns 47, of which
  one is the `origin/HEAD` symref (it shortens to the bare name `origin`, so a `grep -v
  origin/HEAD` does not remove it — a plausible source of an off-by-one, but not of four).
  `git fetch --prune` removed nothing, so these were not stale refs. I cannot reproduce 50
  and do not know which command produced it.
- **`34 not merged` — actually 31, and the brief's own breakdown double-counts.** The four
  branches holding real unlanded work are a *subset* of the eleven dated today, not an
  addition to them: 19 + 11 + `v2-deprecated` = 31. (`main` is not an unmerged branch; it is
  the thing merge status is measured against.)

## Method

The judgment of "provably merged" is not `git branch --merged`. It is
`land_assert_reap_safe` in `gate/land-lib.sh` — the same predicate `gate/land.sh` applies
after a landing — reached through the documented mechanism `hygiene/reap.sh`, which is
report-only unless `--apply` is passed. It accepts a branch whose commits are *patch-id*
equivalent to something on `main` (a squash or cherry-pick landing is not a fast-forward
ancestor but is just as safe to delete), and refuses a branch that is remote-only, held by a
worktree, or has a dirty worktree.

```sh
# 1. classification, report-only
hygiene/reap.sh branches --repo /root/bpa-dev-infrastructure
# 2. worktree removal, only for branches in the reap set, only when clean
git -C /root/bpa-dev-infrastructure worktree remove <path>
# 3. deletion
hygiene/reap.sh branches --repo /root/bpa-dev-infrastructure --apply
# 4. remote deletion, one ref at a time
git push origin --delete <branch>
```

Three guards were applied before every removal and every deletion, re-evaluated per branch
rather than once at the start:

- the live-lane set was re-read from `systemctl list-units 'lane-*' --state=running` before
  each worktree removal, and no branch held by a running unit was touched;
- **no worktree was force-removed.** All 54 were clean (`git status --porcelain
  --untracked-files=normal` empty) and came out with a plain `git worktree remove`. A
  `--force` would have silently discarded uncommitted lane work, so a dirty worktree was
  defined as a skip, not an obstacle;
- `git branch -D` was never used to get past a refusal. `hygiene/reap.sh` uses `-D`
  internally, but only *after* it has proved carriage or read an explicit disposition —
  the safety argument is made before the delete, not by the delete succeeding.

Live at the time of the sweep and deliberately untouched: `ag-v3-3.1-r3-review`
(`lane-v3-5.1-r3-review.service`, which finished before this lane did), `ag-v3-5.14`
(`lane-v3-5.14-board-triage.service`, cut during this lane's own run and still running), and
`ag-v3-5.13` (this lane). The live set was re-read from systemd rather than assumed, which is
how `ag-v3-5.14` was caught: it did not exist when this lane started, and it is
ancestry-merged into `main`, so a set computed once at the start would have deleted the
branch out from under a running lane.

## 1. Reaped — provably carried by `main` (52 local, 6 remote)

### 1a. Ancestors of `main` (45 local)

Proof for every row: `git merge-base --is-ancestor <sha> 42a0cdb` exits 0.

| branch | tip |
|---|---|
| ag-s3-11-rebase2 | d1ec462 |
| ag-s3-11-review-r2 | d4dee39 |
| ag-s3-11-review-r3 | 7149da8 |
| ag-s3-11-review-rebase | 2f023ad |
| ag-s3-11-review-rebase2 | 2f023ad |
| ag-s3-11-review-rebase3 | 2f023ad |
| ag-s3-9-rebase | 533c854 |
| ag-s3-9-review-rebase | d4dee39 |
| ag-s4-1-meteorite | b624fdd |
| ag-s4-1-review | 3a602b4 |
| ag-s4-2-refprotect | 47220f6 |
| ag-s4-3-r2 | 3ceef50 |
| ag-s4-3-review | 133541c |
| ag-s4-3-review-r2 | 133541c |
| ag-s4-5-review | 33bae26 |
| ag-v3-0.44-r2 | 41d99e2 |
| ag-v3-0.44-r2-review | 41d99e2 |
| ag-v3-0.44-r2-review2 | 41d99e2 |
| ag-v3-2.11-r2 | d764a15 |
| ag-v3-2.11-r3 | 585581d |
| ag-v3-2.11-review-r2 | d764a15 |
| ag-v3-2.11-review-r3 | 585581d |
| ag-v3-2.12 | 60878c5 |
| ag-v3-2.12-r2 | 2856a1a |
| ag-v3-2.12-r2-review | 2856a1a |
| ag-v3-2.12-r3 | 2856a1a |
| ag-v3-2.12-r4 | 2d8567d |
| ag-v3-2.12-r4-review | 2d8567d |
| ag-v3-2.12-review1 | 60878c5 |
| ag-v3-2.12-review2 | 60878c5 |
| ag-v3-2.13 | 7956bde |
| ag-v3-2.13-r2 | b89f8f3 |
| ag-v3-2.13-r2-review | b89f8f3 |
| ag-v3-2.13-r2b | b89f8f3 |
| ag-v3-2.13-review | 7956bde |
| ag-v3-2.15-r2-review | bd5f6b1 |
| ag-v3-2.15-r2b | bd5f6b1 |
| ag-v3-2.16 | 5daea14 |
| ag-v3-2.16-review | 5daea14 |
| ag-v3-2.17-review | 0acca9c |
| ag-v3-2.18-review | 2c26482 |
| ag-v3-3.2 | 16e5c95 |
| ag-v3-3.2-r2-review | 5c8753a |
| ag-v3-fable-plan | d3fdb6d |
| ag-v3-false-facts-audit | 2ff3881 |

Most of these are *review* branches that never carried a commit of their own — the reviewer
worked on the coder's tip. They were nonetheless real refs holding real worktrees, and are
the bulk of the breeding this floor item names.

### 1b. Patch-carried, not ancestors (7 local)

Not fast-forwards; every commit has a patch-identical counterpart on `main`, so the work is
on `main` under a different SHA. Named carrier per branch:

| branch | tip | carried by, on `main` |
|---|---|---|
| ag-s3-2-bootstrap2 | ec1a07a | 5005474 `[CODER] add bootstrap installer stage 2` |
| ag-s3-2-r2 | 0a43105 | 1e3c1d8 `[CODER] make unit rendering fail closed` |
| ag-s4-3-container | bc3d0e5 | 8df9b5c `[CODER] Make clean-container exclusions explicit` |
| ag-v3-2.11-review | a2f7e90 | 1cdac84 `[CODER] restore the fleet watchdog into v3…` |
| ag-v3-2.11-review-ops | a2f7e90 | 1cdac84 (same commit) |
| ag-v3-2.15 | 1bf59c9 | 8dd36e8 `[CODER] V3-2.15: the cap replaces the floor…` |
| ag-v3-fleet-nudge-restore | a2f7e90 | 1cdac84 (same commit) |

### 1c. Remote deletions (6)

Each was re-verified immediately before deletion: present on `origin`, absent from
`instance/hygiene-protected-branches.txt` and `instance/github-protected-refs.tsv`, and
`git cherry 42a0cdb origin/<b>` reporting zero `+` lines and zero unique merge commits.

| ref | tip | why |
|---|---|---|
| origin/ag-v3-2.11-r2 | d764a15 | ancestor of `main` |
| origin/ag-v3-2.12-r2 | 2856a1a | ancestor of `main` |
| origin/ag-v3-2.15-r2 | bd5f6b1 | ancestor of `main` |
| origin/ag-v3-fable-plan | d3fdb6d | ancestor of `main` |
| origin/ag-v3-fleet-nudge-restore | a2f7e90 | patch-carried by 1cdac84 |
| origin/ag-s6-13 | cf665cd | patch-carried by 45fc210 `[CODER] persist review rounds in target history`; `instance/hygiene-protected-branches.txt` already records it as deliberately unprotected on 2026-08-04 because V3-3.4 landed at 7c428e0 |

## 2. The 19 unknown-state branches, classified

The set the row exists for: local, unmerged by ancestry, last commit 2026-08-03 or 08-04.
Reproduced exactly as the brief measured it. None was `abandoned` — every one turns out to
be an earlier round of work that reached `main` by another route, or work deliberately parked
with a record.

| branch | class | evidence |
|---|---|---|
| ag-s3-1-meteorite | superseded | V3-1.5 meteorite, round 1. Tree byte-identical to `f147fb1`, the first commit of round 2, so contained in it. Row recut and landed at `133541c`. |
| ag-s3-1-r2 | superseded | Round 2. Tree byte-identical to `60eda4c`, the second commit of round 3, so contained in it. |
| ag-s3-1-r3 | superseded | Round 3. `instance/hygiene-protected-branches.txt` records the ruling of 2026-08-03 (his question, Telegram 1931, *«ці для чого захищати??»*): the recut landed at `133541c`, `meteorite/run.sh` and `prove-candidate.sh` are on `main`, the branch holds the only copy of nothing. **`origin/ag-s3-1-r3` was deliberately kept** — `instance/github-protected-refs.tsv` requires it to exist. Only the local ref was deleted. |
| ag-s3-11-review-claim | superseded | V3-1.11, review claims in the report contract. `ag-s3-11-rebase2` (`d1ec462`) is an ancestor of `main`; the diff from this branch to it only replaces the naive `/^review:/m` test with the fence-aware parser and adds the unterminated-fence refusal. The landed guard is strictly the stronger one. |
| ag-s3-11-r2 | superseded | Same lineage; diff to `d1ec462` is the unterminated-fence refusal only. |
| ag-s3-11-r3 | superseded | Tree byte-identical to `d1ec462` on all three changed files (`gate/completion-guard.ts`, `gate/completion-guard.test.ts`, `instructions/lane-lifecycle.md`). |
| ag-s3-11-rebase | superseded | Tree byte-identical to `d1ec462` on the same three files. |
| ag-s3-2-bootstrap2 | superseded | V3-1.1 stage 2, round 1. Patch-carried by `5005474`. |
| ag-s3-2-r2 | superseded | Round 2. Patch-carried by `1e3c1d8`. |
| **ag-s3-2-r3** | **retained** | **Protected.** Parked V3-1.1 stage 2 under the HR-1726 three-round cap; park record `instance/parked/V3-1.1-stage2-2026-08-03.md`, and the workboard row names the branch and says *do not reap*. See finding 3 below — the merge-safety argument for keeping it no longer holds, but the protect entry does, and it wins. |
| ag-s3-4-stash | superseded | V3-1.7, the shared-stash boundary. `hygiene/check-shared-stash.sh` on the branch is byte-identical to `main`'s (blob `7519e85`), landed at `c7f1c79`; the rule is in `instructions/lane-lifecycle.md` on `main`. The only difference in the test is `main`'s later `CHECK_SHARED_STASH_CHECKER` override — an addition. |
| ag-s3-9-watchdog | superseded | V3-1.13, the watchdog status contract, round 1. `ag-s3-9-rebase` (`533c854`) is an ancestor of `main` and carries this lineage under the same commit titles (`334ebcd`). |
| ag-s3-9-r2 | superseded | Round 2. Tree identical to `ag-s3-9-rebase` on every changed file except `tools/shell-test-tier.test.ts`, where the landed version adds one further inventory entry. |
| ag-s4-3-container | superseded | Patch-carried by `8df9b5c`. |
| ag-s4-5-nonroot | superseded | V3-1.9, non-root lanes, round 1. Byte-identical to `29571ad`, the first commit of `ag-s4-5-r2`, which is protected and retained — round 1 is contained in a branch that is being kept. Not a judgment on the row: HR-2335 puts non-root out of scope until cutover. |
| **ag-s4-5-r2** | **retained** | **Protected.** Round 2 of V3-1.9, reported NO-GO and never landed; kept as the only copy of what round 2 established before round 3 moved to the single-service-user model. See finding 2 — no workboard row names it. |
| ag-v3-2.11-review | superseded | Review branch for V3-2.11; the coder commit it sat on is patch-carried by `1cdac84`. |
| ag-v3-2.11-review-ops | superseded | Second reviewer on the same tip; same carrier. |
| ag-v3-fleet-nudge-restore | superseded | Same tip `a2f7e90`, same carrier `1cdac84`. Deleted locally and on `origin`. |

17 superseded, 2 retained, 0 abandoned, 0 unclassified.

The 11 that `hygiene/reap.sh` could not prove carried are recorded as one-line dispositions in
`instance/hygiene-branch-dispositions.txt`, with the same evidence, so the deletion is
reproducible through the mechanism rather than by hand.

## 3. Retained

### 3a. Local (17 remain)

| branch | tip | disposition | what it needs / who owns it |
|---|---|---|---|
| main | 42a0cdb | protected | the trunk |
| v3 | 99db22d | protected | orphan-history root; required by `instance/github-protected-refs.tsv` |
| v2-deprecated | 445285b | protected | the donor line the meteorite and several checkers read |
| ag-s3-2-r3 | 09082ec | retained, protected | parked V3-1.1 stage 2; recut must satisfy the lock in `instance/parked/V3-1.1-stage2-2026-08-03.md` |
| ag-s4-5-r2 | ba597d4 | retained, protected | parked V3-1.9 round 2; **no workboard row names this branch** (finding 2) |
| ag-v3-3.1-r3-review | 6b97a37 | retained | the review artifact for V3-5.1 round 3; its lane was running for most of this sweep and ended during it |
| ag-v3-5.13 | 7e34fbd | retained, live | this lane; owner V3-5.13 |
| ag-v3-5.14 | 7e34fbd | retained, live | board-triage lane running now; owner V3-5.14 |
| ag-v3-3.1 | 41acf77 | retained, in flight | V3-5.1 round 1, REJECTed; kept while round 3 is under review |
| ag-v3-3.1-review | 41acf77 | retained, in flight | the review artifact for round 1; owner V3-5.1 |
| ag-v3-3.1-r2 | 50fd6ef | retained, in flight | V3-5.1 round 2; kept as the fallback while round 3 is judged |
| ag-v3-3.1-r2-review | 50fd6ef | retained, in flight | the review artifact for round 2; owner V3-5.1 |
| ag-v3-3.1-r3 | 6b97a37 | retained, in flight | V3-5.1 round 3, under review right now |
| ag-v3-2.9-r7 | a69404f | **retained, unlanded** | rebased, suite green, ACCEPT is stale — needs re-attestation, then landing. Owner V3-2.9 |
| ag-v3-3.10 | 6a18bc0 | **retained, unlanded** | token + cost accounting — needs review, then landing. Owner V3-3.10 |
| ag-v3-req-audit | d6fbc80 | **retained, unlanded** | the requirements audit — needs landing. Named by the Phase 5 preamble as evidence; **no row owns landing it** (finding 1) |
| ag-v3-instance-readme | 69a2d08 | **retained, unlanded** | the generated `instance/README.md`, the 285/234/33/18 obligations list — needs review, then landing. **No workboard row names it at all** (finding 1) |

The four the brief named as holding real unlanded work were not reaped, as instructed.

Round-2 branches of an in-flight row are kept on purpose. Reaping `ag-v3-3.1-r2` while round 3
is still under review would destroy the fallback at the moment it is most likely to be needed.

### 3b. Remote-only (40 remain, none deleted)

None of these has a local counterpart, so none was in the brief's count of local unmerged
branches — see finding 4.

**Parked under the HR-1726 three-round cap, all protected in
`instance/hygiene-protected-branches.txt`, each with a park record:** `ag-s5-1` (V3-1.9),
`ag-s5-5-r3` (V3-2.4), `ag-s5-10-r3` (V3-3.5), `ag-s6-12` (V3-2.3), `ag-s6-21` (V3-1.9b),
`ag-s7-7` (V3-0.23), `ag-s9-5-r3` (V3-0.26), `ag-s9-6-r3` (V3-2.1), plus `ag-s3-1-r3`,
`ag-s3-2-r3`, `ag-s4-5-r2` above.

**Required to exist by `instance/github-protected-refs.tsv`:** `main`, `v3`, `v2-deprecated`,
`ag-s3-1-r3`, `ag-s3-2-r3`. `tools/check-github-ref-protection.sh` fails closed if any is
missing, so none may be deleted.

**The live file channel to the old orchestrator:** `channel/oldorch-to-orch`,
`channel/orch-to-oldorch`. Not lane branches; retained.

**Archive lines:** `v2-archive`, `v2-deprecated`.

**Unclassified, retained (19).** These are the honest `unclassified` rows: I did not
classify them, because doing it properly means reading each one's report and the row it
belongs to, and guessing here is exactly what the brief forbids.

- Sprint-era, 1–5 commits ahead of `main`, dated 2026-08-03/04, no local ref, no park
  record, no protect entry (6): `ag-s11-2-r3`, `ag-s11-3-r3`, `ag-s11-4-r4`, `ag-s11-4-r6`,
  `ag-s11-8-r2`, `ag-s11-9-r2`.
- Pre-v3-reset, 271–489 commits ahead of `main` because they branch from the v2 history
  (13): `ag-archive-recovery`, `ag-codex-launcher`, `ag-fleet-floor-enforcement-2`,
  `ag-howto-core`, `ag-ml6-quota-refresh`, `ag-pack-hygiene`, `ag-personas-phase1`,
  `ag-reconcile-full-history`, `ag-session-survival`, `ag-statecontract-argv`,
  `ag-status-human`, `ag-terminal-alarm-false-positive-2`, `ag-w26-dispatch-guard`.

**Pushed and awaiting landing (4):** `ag-v3-2.9-r7`, `ag-v3-3.10`, `ag-v3-instance-readme`,
`ag-v3-req-audit` — the remote side of the four above.

## Findings

**1. Two branches holding finished work are owned by no row.** `ag-v3-instance-readme` is
named by no workboard row at all; `ag-v3-req-audit` is named only by the Phase 5 preamble as
*evidence*, with no row whose acceptance is "land it". `ag-v3-2.9-r7` and `ag-v3-3.10` do have
owners (V3-2.9, V3-3.10). Unowned work is what the operator meant by *«робота губиться»*: the
branch survives, the intent to land it does not. `ag-v3-instance-readme` carries the generated
obligations list — 285 directives captured, 33 open, 18 with no status — which is the artifact
several other rows are currently reasoning about from memory.

**2. `ag-s4-5-r2` is retained by a comment in a protect list and by nothing else.** Its own
protect entry says "Remove this entry when V3-1.9 lands or parks with its own record" — but
the V3-1.9 park record names round 3 (`ag-s5-1`), not round 2, and no workboard row mentions
`ag-s4-5-r2`. The retention is correct; the *ownership* is a dangling reference, and the
condition for releasing it can never be evaluated by anyone who has not read this file.

**3. `ag-s3-2-r3` is protected as parked work, and all three of its commits are already
patch-carried by `main`** (`5005474`, `1e3c1d8`, `f06b5ad`). `hygiene/reap.sh` classifies it
`merged` on the safety predicate and deletes it on `--apply` — only the protect entry stops
it. I did not act on this: the protect comment gives a second, independent reason ("the branch
IS the evidence and the starting point for the recut") which patch-carriage does not
invalidate. But the first reason is stale, and the same is worth re-checking for the other
parked branches before the next sweep.

**4. The unknown-state set is larger than 19, because the measurement was local-only.** Six
remote branches (`ag-s11-2-r3`, `ag-s11-3-r3`, `ag-s11-4-r4`, `ag-s11-4-r6`, `ag-s11-8-r2`,
`ag-s11-9-r2`) are from the same 2026-08-03/04 sprint, are 1–5 commits ahead of `main`, have
no local ref, no worktree, no park record and no protect entry. They are invisible to any
count taken over `refs/heads` — which is what `hygiene/reap.sh branches` iterates, so the
documented mechanism cannot see them either. Thirteen more pre-v3-reset branches are in the
same position. **`hygiene/reap.sh` has no remote-branch command**; every remote deletion in
this sweep was a hand-run `git push origin --delete` guarded by hand-written checks. That is
the mechanism gap this row exposes and does not close.

**5. Fifty-four worktrees outlived their branches by up to two days, and nothing reaps them.**
`hygiene/reap.sh worktrees` only prunes *orphaned metadata* — a worktree whose directory is
gone. A registered, present, terminal worktree is invisible to it, and holding one is exactly
what blocks `hygiene/reap.sh branches` from deleting the branch. So the two halves of the
mechanism deadlock: the branch cannot be reaped because the worktree exists, and the worktree
is never reaped because it still exists. Every deletion in this sweep required a manual
`git worktree remove` first. Note the constraint this sits under: the operator has ruled
`/root/.cache` off-limits for routine cleaning (Telegram 2132/2134), so the fix is not "run a
sweeper" — it is that a lane's own terminal path should remove its worktree once its branch is
landed or dispositioned.

**6. Three detached-HEAD worktrees remain under `/tmp`**, left by completion-guard verify
runs: `/tmp/completion-verify-YSgI42/checkout` (at `a2f7e90`, a commit whose branches are now
all gone), and two under `/tmp/infra-lane-tmp-0/*/completion-verify-*/checkout`. They are
registered in `git worktree list`, so they hold objects alive and count against the fleet's
worktree total. Not removed here: they are outside this row's scope, and one of them belongs
to a lane that is still running.
