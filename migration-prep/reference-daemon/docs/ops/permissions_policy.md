# Permissions Policy

This is the default command-permission policy for projects created from this
template. Tighten it for the target project after setup.

## Allowed By Default

Routine read and verification commands are normally safe:

- `git status`, `git diff`, `git log`, `git show`,
- `rg`, `find`, `ls`, `wc`, `head`, `tail`,
- project test/lint/typecheck commands,
- read-only `gh pr view`, `gh pr diff`, `gh run view`.

Exact allowlists belong in Claude/Codex local settings, not in committed
secrets.

## Human Approval Required

Ask before:

- installing or upgrading packages,
- changing lockfiles,
- pushing branches,
- running migrations outside disposable local databases,
- modifying service-manager files,
- changing CI/CD, deployment, or cloud configuration,
- reading files that may contain secrets.

## Hard Deny

These should not run from an automated agent session:

- `git reset --hard`,
- `git clean -fd`,
- force-push to protected branches,
- recursive deletion outside disposable build/test directories,
- destructive database SQL against non-test data,
- cloud destructive commands,
- reading `.env` or secret stores,
- printing full process environments.

## Project Setup Note

During project initialization, define:

- protected branches,
- approved verification commands,
- safe generated-output directories,
- local-only database rules,
- production access rules,
- any extra hard-deny patterns.
