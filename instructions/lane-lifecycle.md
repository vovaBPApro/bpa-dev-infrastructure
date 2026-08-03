---
id: lane-lifecycle
layer: L1
status: binding
audience: all
tags: [lane, lifecycle]
summary: Mission scope and evidence contract from dispatch through verification, teardown, and reaping.
floor: true
floor-line: Artifacts beat explanations — finish the file, commit, test, and report the exact SHA.
---

# Lane Lifecycle

## Binding rules

- A mission names scope, owner, acceptance rows, risk tier, evidence destination, and a durable correlation identifier before dispatch.
- Give every lane one branch, one worktree, and one writer. Never allow two writers to edit the same tree.
- A lane never runs `git stash`: `refs/stash` is repository-global, so sibling worktrees share it and one lane can restore another lane's files. To set work aside locally, make a scratch commit on the lane branch with `git add -A && git commit --no-verify -m "scratch: set work aside"`; restore those changes in that same worktree with `git reset --soft HEAD^`. The commit and index are worktree-local through the lane's own branch and index; remove or replace the scratch commit before reporting the lane complete.
- Lanes commit early and often. A lane that exits with zero commits loses all work; commit the first durable slice promptly and publish it to the lane branch when the mission's transport policy permits.
- Liveness is derived from a fresh lease, heartbeat, process probe, and durable status—not a chat claim. `orchestrator/watchdog.sh` and `orchestrator/status.sh` are the operational projections; their notifications must be deduplicated and rate-limited.
- A terminal lane writes its report to the durable evidence path using the fixed report contract. Agent stdout is not a delivery channel and must not be the only location of a verdict.
- The report is a file OUTSIDE the branch tree: never commit it into the candidate branch and never add/amend it there. A file cannot state the SHA of the commit that carries it — every amend produces a new, different hash, so that convention can never converge and is a defect wherever it is taught. Write the report to the durable evidence path (outside the worktree), with `commit:` set to `git rev-parse HEAD` on the branch at the moment of writing, and leave the branch itself untouched by it.
- A terminal report may use the optional structured `review:` field only to claim a completed review. The field name is case-insensitive, may have leading whitespace, and permits whitespace before the colon; field-looking lines inside closed backtick or tilde fenced code blocks are examples, not fields. An unterminated fenced block makes the report malformed and `completion-guard.ts` rejects it. When the field exists outside a fence, the guard requires the sibling artifact `<branch>.review.md` to exist, contain exactly one `verdict: ACCEPT`, and name the report commit in exactly one `reviewed-sha:` field. Outstanding review belongs in `remaining:` and must not be represented by `review:`. Other useful extra fields remain allowed.
- Before ending its turn, a lane runs `bun gate/completion-guard.ts --report <path> --repo <repo> --branch <branch>` (or the `gate/lane-exit.sh` wrapper) against its own report. A contract violation (exit 2 — missing report, wrong shape, or `commit:` not equal to the branch tip) means the lane is not finished: fix the report or commit and rerun the check before ending the turn. A pass (exit 0) or an honest `NO-GO` (exit 3) are the only turns a lane may end on; the latter is a legitimate parked row, not a violation.
- Retries are idempotent and fenced: an expired owner cannot dispatch, overwrite status, or report success. Preserve earlier evidence rather than replacing it.
- Reap lanes only after final acceptance and landing. Reaping is conservative, scoped, and auditable; `hygiene/reap.sh` reports by default and mutates only with explicit apply.
- A stalled, failed, or unreapable lane remains a visible `NO-GO` row with the next bounded action.

Why: durable ownership and evidence make concurrent work recoverable without trusting a transient session or memory.
