---
id: landing-and-merge
layer: L1
status: binding
audience: orchestrator
tags: [landing, merge, git]
summary: Landing is serialized on the canonical tree; worktrees are evidence sources, not the integration tree.
---

# Landing and Merge

## Binding rules

- Landing is serialized. Coder worktrees are evidence sources, not the canonical integration tree.
- A lane supplies a fixed terminal report with commit, runnable verification command, verdict, secret-scan result, and remaining work. Missing or contradictory evidence is `NO-GO`.
- Before merge, run the completion guard and a secret scan over the complete incoming commit range. Review risk according to `gate/review-policy.conf`; risky changes need independent review.
- Merge with the landing gate, not an ad-hoc Git command: `gate/land.sh` performs guard, range secret scan, no-fast-forward merge, optional canonical-tree verification, push, and cleanup fail-closed. Use `gate/land-batch.sh` only for a reviewed serialized batch.
- Re-run required verification from the canonical tree after merge. A worktree's green result cannot prove the merged tree is green.
- Preserve provenance: the landing record names source branch, source SHA, review disposition, merge SHA, commands, and evidence. Do not replace a failed gate with a narrative exception.
- If post-merge verification, push, or reaping fails, retain the evidence and report the exact gate verdict. Do not call the outcome clean until all required stages pass.
- Reap only a landed, accepted lane worktree and branch; unmerged or investigation-required refs are retained with evidence.
- Every write to the integration branch that does not go through the landing gate goes through the bookkeeping fence, `gate/bookkeeping-push.sh`. It takes the same lock `gate/land.sh` holds, so bookkeeping and landings serialize instead of racing. Pushing bookkeeping to the integration branch by hand is a defect even when it happens to succeed.
- The fence may carry only paths listed in `gate/bookkeeping-paths.conf`, and that list may never overlap `gate/review-policy.conf`. Anything else takes the gate. This is what makes it safe for the fence to reach the integration branch at all.
- Freshness is measured, not demanded. The gate fast-forwards a canonical checkout that is strictly behind a published integration branch and lands onto the tip it just measured. A diverged or dirty checkout is still refused, and no operator hand-runs a fast-forward on a shared checkout.
- The push fence is absolute: if the integration branch moved between the measurement and the push, the landing is refused and rolled back, never re-pointed. A merge whose parent no check walked is a false green regardless of what the moving commit contained.
- Read the integration branch from `origin`, not from the canonical checkout's `HEAD`. The checkout is shared and carries a local merge for the duration of a landing that may still be rolled back; a reader who treats that transient as landed reports a merge that never happened.
- The fence decides what it is entitled to publish BEFORE it changes anything, on the commits as they stand. A commit it may move is a non-merge, orchestrator-tagged commit, reachable from no ref other than the integration branch itself, touching only allowlisted paths — every one of those checked per commit, not on a net diff and not after a replay. A reconciliation that rewrites first and inspects afterwards has already destroyed the evidence its own guards depend on: a rebase flattens a merge, so a merge-commit guard placed after it can never fire.
- A dry run of any landing-path mechanism is read-only. A canonical checkout is shared, so a flag an operator reaches for to see what *would* happen must not be the thing that makes it happen. If a mechanism cannot answer without mutating, it is not a dry run and must not be named one.
- A mechanism that waits on a bound belonging to another mechanism derives its wait from that bound rather than restating it as a literal. A literal both drifts silently when the inner bound is raised and tends to be chosen from typical rather than worst-case observations — landing it inside the range it is meant to sit outside of.
- A landing refused after its merge has already spent one of the item's review rounds: the attempt record necessarily precedes the merge, and releasing it would collide with attempt-forgery detection. State that cost wherever the refusal is reported. A refusal that reads as free is a refusal whose price gets paid twice.
- Nothing yet compels a write to the integration branch to use the fence; a raw push still reaches it, and the gate can only name the bypass after the fact. Until ref protection carries that enforcement, the fence is a mechanism plus a discipline, and the discipline is the weaker half.

## The second cost of an unfenced write: every in-flight base goes stale

An unfenced bookkeeping push does not only abort the landing that was in
flight. It advances the integration branch under every lane already cut,
so each in-flight branch silently falls further behind. Measured on
2026-08-04: four queued branches sat 12–15 commits behind, and a merged tree
failed its meteorite three times over roughly forty minutes because a lane had
pinned an invocation to a line number the integration branch had since moved.
About an hour went into establishing that the reproducibility floor was not
broken when the real cause was base drift.

Serializing bookkeeping behind the landing lock reduces this rather than merely
relocating it: bookkeeping is the cheap, frequent writer, so making it wait
lowers the *rate* at which the integration branch moves under lanes rather than
the amount it moves. It does not eliminate staleness — landings themselves
advance the branch — so a lane still checks its own base distance before
reporting, and no lane couples an assertion to a line number in a file it does
not own.

## Bookkeeping versus landing: why serialize rather than tolerate

Decided under V3-0.47, after four landings were lost to this collision in one
day. The alternative considered was to let the gate accept an integration
branch that moved when the move "does not touch the paths it guards". It was
rejected because the guarded set is not enumerable: the gate's declared checks
parse every tracked source file and run every tracked test file, and the
meteorite runs the full suite in a clean container. The paths bookkeeping
writes are read by tracked tests and by the decision-ledger and instruction
checkers, so the one move the exception was meant to wave through is precisely
the move that can change a verdict. A path allowlist that must stay correct as
the suite grows is a false green waiting to happen, and Hard Floor 7 outranks
convenience.

Serializing costs a bookkeeping write at most one landing of latency, because
landings already serialize against each other on the same lock — the wait is
bounded by one walk, not by the fleet size. Nothing blocks on a board row
reaching the integration branch within ten minutes; a landing that loses the
race discards ten minutes of container work. The cheap writer waits for the
expensive one.

Why: one canonical, fail-closed sequence prevents unreviewed merges, secret leakage, and false-green worktree results.
