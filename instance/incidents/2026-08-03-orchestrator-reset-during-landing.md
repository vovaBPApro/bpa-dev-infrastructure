# Orchestrator destroyed a lane's landing with `git reset --hard`, 2026-08-03

An orchestrator error, recorded because the mechanism defect it exposed (V3-0.18) is
only half the lesson.

## What happened

`/root/.cache/infra-lanes/land-main` is the clone the landing gate runs from — the gate
must run from a repository checked out on the target branch. The orchestrator had also
been using that same clone as its own working repository for `[ORCH]` bookkeeping
commits (workboard rows, park records, sprint files).

While lane `s5-11`'s landing was in flight there, the orchestrator ran:

```sh
git fetch -q origin && git reset -q --hard origin/main
```

That discarded the gate's merge commit `b857786`. The gate then pushed, git said
`Everything up-to-date`, and the gate reported `verdict=landed-reap-failed
sha=b857786…` — a SHA on no remote.

## Why the safeguards did not catch it

The gate serialises landings against each other with `flock`. It does not — and
arguably cannot — defend against a *different* process mutating the branch underneath
it. The lock protects landing-vs-landing, not landing-vs-owner.

The orchestrator also held no lock, checked none, and had no reason to look: resetting
a clone to `origin/main` is an ordinary, safe operation *in a clone nobody else is
using*. The defect was the shared clone, not the command.

## What was lost, and what was not

Nothing. `ag-s5-11` still carried `124cbb7` and was re-landed. `origin/main` was never
wrong; the false claim existed only in the lane's log and report.

## The fixes

1. **Mechanism (V3-0.18)**: the gate must verify the remote ref equals the SHA it is
   about to claim. `Everything up-to-date` after a merge is a failure.
2. **Process**: the orchestrator now commits from a **separate** clone,
   `/root/.cache/infra-lanes/orch-main`, and treats `land-main` as owned by the gate
   alone. A clone the gate runs in is not a working directory.

## The general shape

This is the same lesson as the shared `refs/stash` collision (V3-0.7) and the shared
lanes root in V3-1.9's review: **two writers on one piece of git state, where only one
of them knows a transaction is in progress.** Each time it has looked like an unrelated
new bug and each time it was this. Expect the next instance to look unrelated too.
