# Guards for the orchestrator's own recurring mistakes

date: 2026-08-05
status: proposed, awaiting operator go
source: the operator's question — *«щойно я тебе залишаю… ти знову десь не туди йдеш»*

## Why this list exists

Every item below is a mistake the orchestrator made **today**, with a count. None is
hypothetical and none is drawn from judgement about what might go wrong. Each is the same
shape: *the orchestrator must remember X*, with no mechanism that fails when it does not.

The operator's observation is the finding, stated exactly: when he is present he catches
these within minutes, so **he is currently the safeguard**. That is not a workable design,
and it is the reason his absence reads as things going wrong — nothing else is watching.

The asymmetry that let this persist: all day, defects found in lane work were filed as
workboard rows with acceptance criteria. The orchestrator's own repeats were recorded in
commit messages as intentions. **V3-5.12 was filed for one of them and the same mistake
happened twice more afterwards** — because a row is a record, not a mechanism. That is the
whole argument for this list.

---

## G1 — a commit to a file a live branch is rewriting

**Happened 3×** (V3-5.1 twice, V3-5.18 once). Each cost a rebase, an invalidated ACCEPT and
a re-attestation lane. The third happened **after** V3-5.12 was filed for it.

**Guard:** before any orchestrator commit, refuse if a tracked file in the staged set is also
modified on a branch with an open lane or an unlanded ACCEPT. `instance/workboard.md` is the
common victim; the rule is general.

**Provably able to fail:** stage a workboard edit while a fixture branch holds a change to it,
and the commit must be refused.

## G2 — assigning a row id without checking it is free

**Happened 2×**: `V3-3.1`/`V3-3.2` (already held by Phase 3 backlog rows) and `V3-2.17`
(filed that morning by another lane). The second broke `main` — the fleet-nudge parser
refused the whole board on the duplicate and alerted the operator, who asked what it was.

**Guard:** id allocation is a command, not a decision. It reads the board, the review-items
registry and the exemption ledgers, and returns the next free id. A duplicate id anywhere is
already caught by the parser — the guard moves the catch to before the commit.

## G3 — verifying a commit with a narrow command instead of the suite

**Happened 2×, both pushed a red `main`.** Most recently the cap change: verified with
`check-fleet-cap`, the ledger checker and the nudge test, while `daemon/autonomy-keepalive.test.ts`
asserted the old number. The landing gate caught it at baseline — the only reason it surfaced.

**Guard:** the orchestrator's own pre-push check runs what the landing gate's baseline runs.
If the gate would refuse it, the push is refused first. Cheap, because it is the same command.

## G4 — brief boilerplate asserting a fact that has changed

**Happened all day, in every brief written.** *"Foreground is killed at 2m00s"* — removed the
previous day by V3-0.51, which declares a 30-minute bound. It pushed every lane toward the
background, which is what kills lanes (V3-5.16). This is the **second** inversion of the same
text: V3-0.51's row records the first, where briefs told lanes to measure in the foreground
*while* the foreground was being axed.

**Guard:** operating facts a brief asserts — timeout bounds, execution model, cap, live units
— come from a tracked source that is generated, not retyped. A changed fact cannot then
survive in briefs. Already filed as V3-5.17; this is its promotion.

## G5 — a check that cannot fail

**Found 8× today**, in lane work rather than orchestrator work — but the rule that would have
caught them is the orchestrator's to enforce. `instructions/verification-and-locks.md` already
requires a lock to be proven able to fail. It is prose, and nothing runs it.

**Guard:** a dispatch that adds or modifies a check must carry its red-before evidence, and
the completion guard refuses a report claiming a new lock without it. This is the class fix
the operator asked about — *«скільки нам треба, до сотні добіг?»* — and the honest answer is
that we have been fixing instances because nothing was attacking the class.

## G6 — reading a mechanism's intermediate state as its verdict

**Happened 1×, and it broke a landing.** `git log` showed the merge commit, so the landing was
treated as done; the gate's own verdict was `aborted`. A reviewed branch reached `origin/main`
outside the gate's push and reap steps.

**Guard:** no orchestrator path answers "did it land?" from anything but `LAND verdict=`. A
test asserts the substitution cannot be reintroduced. Filed as V3-5.12; unimplemented.

---

## What this is not

It is not a promise to be more careful. Each item above was already something the orchestrator
knew and intended. The list exists because intention has now been measured, over one day, at a
failure rate of eleven.

## Order

G3 and G1 first — they are the two that cost the most today and both are cheap. G2 next. G5
is the largest and the most valuable, because it is the only one that attacks a class rather
than a habit. G4 and G6 have rows already and can be promoted into the same sprint.
