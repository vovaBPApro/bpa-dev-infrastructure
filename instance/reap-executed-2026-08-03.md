# Reap executed — 2026-08-03

Authorized by Vova (Telegram 1728): «мені все виглядає логічно. я думаю, можемо
рухатись за планом, що ти пропонуєш» — approving the plan proposed in Telegram 1722,
whose item 2 was the reap of 392 branches described in
`instance/branch-reap-plan-2026-08-03.md`.

## Result

| | before | after |
|---|---|---|
| local branches | 1372 | **995** |
| unmerged branches | 1314 | **991** |
| registered worktrees | 1393 | **1034** |

377 branches removed from `refs/heads/`, 359 worktrees released.

## Tier 1 — tips already ancestors of `main` (57 candidates)

Deleted with `git branch -d`, which refuses anything not fully merged — the safety
net was left in place rather than forced. 18 had no worktree and deleted directly;
36 required releasing their worktree first (`git worktree remove`, non-force).

**54 deleted, 3 retained** because their worktree is dirty or locked, listed in
`instance/evidence/retained-2026-08-03.tsv`. Nothing was forced.

## Tier 2 — superseded recut rounds (336 candidates)

Rule, computed rather than judged: within a recut group (branch name with the `-r<N>`
round token and trailing message-id stripped), every branch below the group's highest
round is superseded. `main` and `v3` were excluded from the population before the
rule ran — `v3` is a protected ref per `instance/decisions/HR-1718.md`.

**323 removed, 13 retained** (dirty or locked worktrees, same file).

### These are archived, not destroyed

Before any deletion, every one of the 336 tips was written to
`refs/archive/2026-08-03/<branch>`. That keeps the objects reachable, so git will not
garbage-collect them. Restoring any branch is one command:

```sh
git branch <name> refs/archive/2026-08-03/<name>
```

Verified end to end at execution time, not assumed: restored
`ag-ancestry-gate-r1-1565` from its archive ref, confirmed it resolved to
`e7f6209 [CODER] bind landing to reviewed dispatch ancestry`, then removed the test
branch again.

`instance/evidence/reaped-2026-08-03.tsv` records every removed branch with its full
40-hex tip SHA, its recut group, and its archive ref — so the record survives in git
even if the archive refs do not.

## Honest limit of this recovery guarantee

The archive refs are **local to this host**. `git ls-remote --heads origin` returns
**18** branches: the ~1300 lane branches were never pushed and exist nowhere but this
machine. The reap did not create that exposure — it was already true for every lane
branch before today, and it is a standing Hard Floor 5 gap worth its own decision.
What the reap did add is a committed manifest of tips, which is strictly more recovery
information than existed this morning.

If the Human wants these preserved against host loss, the archive refs must be pushed
(`git push origin 'refs/archive/2026-08-03/*'`). That is an outward-facing action on
his repository and has not been taken.

## What was deliberately not touched

- `v3` and `main`.
- The 991 remaining unmerged branches — Tier 3 in the reap plan. They need triage, not
  a name rule: per `instance/landable-candidates-2026-08-03.md` only 6 branches in the
  whole repository currently satisfy the landing gate's own precondition, so deleting
  the rest before that is understood would destroy the only copy of work that has no
  path to land yet.
- `/root/.cache/infra-lanes` on disk — 359 worktrees were released from git's registry,
  but disk reclamation and the missing reaper timer remain open (`hygiene/reap.sh` is
  wired into nothing; see the consilium report §6).
