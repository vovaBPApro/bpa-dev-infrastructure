# Why lane reports do not pin their tip — the convention was self-defeating

Found 2026-08-03 when a coder lane refused an instruction the orchestrator had given
it, and was right to refuse.

## The instruction that cannot be satisfied

The orchestrator dispatched a lane telling it to:

> write the report, commit it, and then — because that commit moved the tip — AMEND
> the report's `commit:` line to the new tip SHA and amend that same commit so the
> file and the tip agree.

That is **mathematically impossible**. A file cannot state the SHA of the commit that
contains it: writing the resulting hash back into the tree changes the tree, which
changes the commit hash. Amending never converges — each cycle produces a new,
still-different SHA. The lane tested this empirically before concluding it, rather
than asserting it, and reported it instead of quietly faking a value.

## What the gate actually requires

`gate/land.sh` takes the report as an **external argument**, not as a tracked file:

```
gate/land.sh --branch <ag-name> --report <file> --repo <path> ...
```

`gate/land-guard-exacttip.test.sh` shows the intended shape — it writes the report to
`$fixture/report`, a path **outside the repository tree**, and lands the branch with
it:

```sh
printf 'commit: %s A\nverify: true\n...' "$sha_a" > "$fixture/report"
"$root/gate/land.sh" --branch ag-stale --report "$fixture/report" --repo "$repo" --no-push
```

So the report describes the branch from outside it. The `commit:` line names the
branch tip; the report itself is not part of what it describes.

## Why this matters beyond one lane

The measurement in `instance/landable-candidates-2026-08-03.md` found 6 of 1314
unmerged branches satisfying the tip-pinning precondition. This is a large part of the
explanation, and it partly exonerates the lanes:

- A lane that commits its report **into its own branch** is structurally guaranteed to
  fail the check, because the commit carrying the report moves the tip past the SHA
  the report names. The harder the lane tries to "fix" it by amending, the more it
  spins.
- The reports that DID match were exactly the ones stored outside the branch: four in
  the canonical tree under `orchestrator/runtime/reports/` (already landed), and two
  as untracked `terminal.md` files in lane worktrees.

A convention that is impossible to satisfy does not produce failures that look like
failures — it produces lanes that finish, believe they are done, and leave work that
cannot land. That is precisely the shape of today's 1314.

## Corrected rule for dispatch

When dispatching a lane, instruct it to:

1. Commit all deliverable work. The final deliverable commit is the tip.
2. Write the terminal report to a path **outside the branch tree** — the lane's
   worktree root or a scratch path — with `commit:` set to `git rev-parse HEAD`.
3. Not commit the report into the branch.
4. Verify before finishing: `git rev-parse HEAD` equals the report's `commit:` value.

The orchestrator then passes that path to `gate/land.sh --report`.

If a durable copy of the report is wanted in git, it belongs in a **separate commit on
the canonical tree after landing**, not in the candidate branch — which is exactly
where the four already-landed reports live.

## Correction to earlier records

`instance/consilium2-2026-08-03-v3-viability.md` Finding 2 said nothing makes a lane
pin its report before its session ends, and proposed enforcing the guard at lane exit.
That remains true and worth doing, but it is incomplete: enforcement alone would have
made lanes fail loudly against an unsatisfiable rule. The convention had to be fixed
first. Both are needed — the corrected convention above, then the guard at lane exit
to enforce it.
