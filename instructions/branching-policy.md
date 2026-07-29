---
id: branching-policy
layer: L1
status: binding
audience: all
tags: [git, branching]
summary: Trunk-based branch model: `main` plus short-lived `ag-` lanes; environments are not branches.
floor: true
floor-line: Branch and worktree hygiene is mandatory — lane branches die after merge; do not let refs breed.
---

# Branching Policy

Decided with the Human on 2026-07-29 (Telegram 11549–11550), before the VM
migration. Verbatim question that triggered this document (Vova, msg 11549):

> «Доречі по бранчах - в нову інфру в нас прописано політику бранчування? Типу
> щоб був дев майстер і стейджинг, і як ми з бранчами працюємо і все таке?»

## Binding rules

- **Trunk-based. `main` is the only long-lived branch** and the only canonical
  integration line. There is deliberately NO `dev`, NO `master`, NO `staging`
  branch.
- **All work happens on short-lived lane branches** named `ag-<lane>`, cut from
  current `origin/main`, living in an isolated worktree. A lane branch lives
  hours, not days; it holds one unit of work.
- **Lane branches are committed locally, never pushed by the lane.** The only
  path into `main` is the landing gate (`gate/land.sh`, or `gate/land-batch.sh`
  for a reviewed serialized batch of up to 3 disjoint branches). See
  `instructions/landing-and-merge.md` for the gate contract.
- **Environments are runtime targets, not branches.** A staging stand runs
  current `main`; production runs a pinned annotated release tag
  (`release/YYYY-MM-DD[.N]`). Promoting to prod = moving the tag pointer via
  the deploy procedure, never merging a branch.
- **Releases are annotated tags on `main`**, created only from a SHA that
  passed the full gate. Rollback = redeploy the previous tag; never revert-war
  on `main`.
- **Branch hygiene is the gate's job.** A landed, accepted lane branch is
  reaped by the gate. Unmerged or investigation-required branches are retained
  with evidence, never bulk-deleted.
- **Rebase, don't back-merge.** A stale lane refreshes by rebasing onto
  `origin/main` (or is re-cut); `main` is never merged into a lane branch with
  a merge commit.

## Why

Long-lived `dev`/`staging` branches in the previous infrastructure produced
exactly the failures this repo exists to eliminate: drift between branches,
"merge-day" integration pain, environments serving code that no branch
represented, and unreviewed diffs hiding in the gap between `dev` and `main`.
Trunk-based flow with a serialized fail-closed gate makes every change take the
same short, reviewed, secret-scanned path, and makes "what runs where" a
question about tags and stands, not about which branch drifted where.
