# BPA Dev Infrastructure Agent Rules

## Mission

This repository is the clean infrastructure control plane for BPA agent work. It
must replace fragile human-operated coordination with a reproducible Bun/TypeScript
orchestrator stack: isolated workspaces, Docker stands, Telegram admin, watchdogs,
leases, cleanup, restart/recovery, evidence gates, and review routing.

The repo is not a dumping ground for the old project. Import old behavior only
after source inventory, parity notes, and tests show why it belongs here.

## Instruction Routing

Instructions live in three layers — L1 infra (this repo), L2 framework, L3 agent
— plus L1 `instance/` for this-installation facts. One instruction has one home;
reference, never copy. Full routing rule (Step 0 + Q1–Q4, delivery, capture):
`instructions/instruction-layers.md`.

## Report Contract

Every report to the Human must contain:

1. the exact commit SHA;
2. the command the Human can run to verify it;
3. the result: `clean`, `NO-GO`, or the concrete blocker.

No SHA means not done. What `result: clean` requires (SHA current, verify run at
that SHA exit 0, review/landing evidence present, no unexplained dirty state,
secret-scan evidence) and the canonical secret-scan command are defined once in
`instructions/verification-and-locks.md` (Decidable report contract) — that is
the binding definition; this section does not restate it. If evidence is absent,
stale, contradictory, or unverifiable, report `NO-GO` and the next bounded action.

<!-- hard-floor:begin -->
## Hard Floor

Generated from `instructions/*` docs carrying `floor: true` (edit the source doc's `floor-line:`, then regenerate — hand-edits here fail the checker).

1. Branch and worktree hygiene is mandatory — lane branches die after merge; do not let refs breed. (`branching-policy`)
2. Preserve Human words verbatim when they define work; never reword, trim, or "fix" them. (`human-requirements`)
3. Artifacts beat explanations — finish the file, commit, test, and report the exact SHA. (`lane-lifecycle`)
4. Zero secrets in git — secret-scan before every commit and record `secret-scan: clean`. (`repository-hygiene`)
5. Keep the permission surface versioned and fail-closed; ask the Human only for the irreversible set. (`tool-permissions`)
6. Green is fail-closed — never relabel a failure as a warning; missing evidence is `NO-GO`. (`verification-and-locks`)
<!-- hard-floor:end -->

## Hard Rules

1. **Artifacts beat explanations.** Finish the file, commit, test, and report the
   SHA. Do not substitute long reasoning for a landed artifact.
2. **Zero secrets in git.** Never commit credentials, tokens, private keys,
   `.env` values, logs with secrets, or historical imports that may contain them.
   Run a secret scan before every commit and record `secret-scan: clean`.
3. **Clean history only.** Do not seed this repo with legacy commits. Bring in
   files through reviewed, narrow commits that preserve no old secret history.
4. **Bun/TypeScript only for THIS repository's runtime code.** This repo's
   daemon/orchestrator stack is Bun + TypeScript; Python may exist only as
   temporary migration evidence until replaced. This is an instance fact about
   this control plane, not a generic rule for every agent — product repos pick
   their own stack (L2).
5. **No provider-specific prompt files.** `CLAUDE.md` is the single root agent
   contract; `AGENTS.md` must be a symlink to it. Do not add `GEMINI.md`,
   `CODEX.md`, or other vendor rule forks.
6. **Single-repo boundary.** Binding while `phase: sole-mission` in
   `instance/params.yaml` (`sunset: phase != sole-mission` — stops applying the
   day product repos exist). Work in this repository only; coder lanes touch only
   assigned paths. For instruction work, only `instructions/`, `instance/`, plus
   the root `CLAUDE.md`/`AGENTS.md` pair are in scope.
7. **Orchestrator dispatches, lands, reports.** The orchestrator does not author
   product/runtime code, tests, migrations, or risky diffs. It creates missions,
   routes lanes, verifies terminal evidence, merges/lands, cleans up, and reports.
8. **Coder lanes produce evidence.** A coder changes the assigned files, adds or
   updates tests, runs the narrowest meaningful checks, secret-scans, commits
   with `[CODER]`, and writes a terminal report.
9. **Review follows risk.** Auth, authorization, migrations, money, orchestrator
   core, secrets, CI, env schema, production infra, rollback, and evidence-gate
   logic require independent review. Risky diffs use a reviewer from another
   vendor/session when available; false-green checks are review scope.
10. **Green is fail-closed.** Do not weaken tests, ignore timeouts, relabel failed
    Docker/rollback evidence as warnings, or report a green result from partial
    output. Missing evidence is `NO-GO`.
11. **Docker/runtime claims need runtime evidence.** For behavior involving a
    service, include build/start, health/auth route, ports, resource limits, soak
    or replay when relevant, teardown, and rollback evidence.
12. **Branch and worktree hygiene is mandatory.** Lane branches die after merge.
    Terminal worktrees are reaped. Protected or unmerged refs are retained with
    evidence. Do not let branches or worktrees breed.
13. **One mission chain stays visible.** Do not promise the same audit repeatedly
    or switch topics over an unfinished artifact. Park a blocked row as `NO-GO`
    with evidence, then move only to a bounded autonomous task.
14. **Ask the Human almost never.** Ask only for irreversible/product decisions:
    product direction, production deploy/cutover, live production data mutation,
    secret provisioning, dependency policy changes, CI/env-schema policy, or a
    destructive cleanup whose safety cannot be proven. Do everything else.
15. **Do not outsource agent work to the Human.** If the agent can inspect,
    test, scan, commit, link, or summarize, the agent does it.
16. **Preserve Human words when they define work.** Store verbatim Human
    requirements in the mission artifact and keep generated summaries separate.
17. **Language.** Code, comments, docs, commits, and reports are English. Chat
    with the Human in the operator's language (`instance/params.yaml:
    operator.language`) unless the Human asks otherwise.

## Required Before Commit

- `git status --short`
- relevant tests or an explicit `NO-GO` blocker
- secret scan over changed files/history surface
- commit message tagged `[CODER]`, `[REVIEW]`, or `[ORCH]`

## Required Final Report

Use this shape:

```text
commit: <SHA> <title>
verify: <command>
result: <clean|NO-GO|blocker>
secret-scan: clean
remaining: <none|specific next row>
```
