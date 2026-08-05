# I committed onto `main` while a landing was in flight, and broke it

date: 2026-08-05
cause: orchestrator error, not a gate defect
severity: a reviewed branch reached `origin/main` outside the gate's own push and reap steps
status: recovered; `main` is `a43fa6a`, content correct, suite green

## What happened

`gate/land.sh --branch ag-v3-2.15-r2` was running. It recorded `pre_merge_sha=df0eec1`,
merged the candidate into local `main` (`9b28a62`, amended to `a7e3696`), and continued
through its post-merge checks.

While it was still running, the orchestrator read `git log --oneline -1`, saw `a7e3696`,
concluded the landing had succeeded, and committed two further commits onto `main`
(`51d8a78`, `a43fa6a`) and pushed each.

When the gate reached its push step, it failed — local `main` was no longer the ref it had
built — and the rollback trap did exactly what it is designed to do:

```
LAND step=push status=fail
LAND verdict=aborted sha=none
main@{0}: reset: moving to df0eec1
```

So the landing's own verdict is **aborted**, while the merge it produced is on `origin/main`
anyway, carried there inside the orchestrator's own push. Local `main` was left two commits
behind origin until this was noticed.

## What this cost

- **A reviewed branch reached the integration branch without the gate's push and reap
  steps.** The content is not in doubt: the branch carried an independent ACCEPT, and the
  gate completed its baseline checks, guard, review, secret-scan, review-rounds, branch-tip,
  payload-guard, meteorite and post-merge declared checks before the push step. What was
  skipped is the gate's own final sequence and its branch reap.
- **The orchestrator reported "Заїхала гілка з лімітом лейнів — a7e3696" to the operator**
  while the landing's recorded verdict was `aborted`. The SHA was real and the content was
  right, so the report was not false — but it was derived from `git log`, not from the gate's
  verdict, which is precisely the substitution this repository treats as a defect everywhere
  else.
- **Two orchestrator commits were silently rewound locally.** They survived only because
  they had already been pushed. Had they not been, they would have been lost with no error.

## The error, named exactly

Not "committed to a busy branch". The error is **reading a mechanism's intermediate state as
its verdict**. `git log` showed the merge commit because the merge had happened; the merge
happening is not the landing succeeding. The gate emits `LAND verdict=…` for exactly this
reason, and the orchestrator had that line available and did not wait for it.

Worse, the risk was identified and then not acted on. Twenty minutes earlier, on the previous
landing, the orchestrator wrote: *"My workboard edit is uncommitted and `land.sh` manipulates
`main` — I'll wait for the landing rather than race it, since that's what dirtied the tree
last time."* It waited that time. It did not wait this time, on a landing it had itself
started in the background.

That is the same shape as the defects this repository keeps cataloguing: **a property
defended by an intention rather than a construction.** The intention held for one landing and
failed on the next, which is what intentions do.

## What must change

A landing must not depend on the orchestrator remembering not to touch `main`. Two candidate
mechanisms, neither built here:

1. **The gate takes the lock it already implies.** `gate/land.sh` serialises against other
   landings with `flock`; it does not hold anything against ordinary commits to the target
   branch. A landing that fails its push because the target moved is detecting the collision
   at the last possible moment, when the cheap fix is refusing the write at the first.
2. **The orchestrator reads verdicts, never intermediate state.** Any "did it land?" check is
   `LAND verdict=` from the gate's own output. `git log` answers a different question.

Filed as `instance/workboard.md` V3-5.12.

## Recovery performed

`git merge --ff-only origin/main` — local `main` fast-forwarded from `df0eec1` to `a43fa6a`,
clean tree, no content reconstructed by hand. Spot-checks at the recovered SHA:
`orchestrator/fleet/fleet-nudge.test.sh` exit 0, and
`bun tools/check-fleet-cap.ts --repo .` exit 0 reporting
`FLEET-CAP clean cap=5 wake_below=1 notify_human_below=1 target=0 declared_by=HR-2456`.

The `ag-v3-2.15-r2` branch was reaped by hand after the aborted landing, so the reap the gate
would have performed did happen — by the same route as the push, which is the point of this
write-up.
