# AI Development Rules

This repository is a template for Telegram-driven Claude/Codex development
infrastructure. Keep it generic. Do not add product-specific rules from a
downstream project into this root file.

`AGENTS.md` is a symlink to this file so Claude and Codex read the same local
instructions.

## Hard Rules

### CLI-only auth

The orchestrator and all local provider sessions use subscription/OAuth CLI auth
only:

- `claude` uses the local Claude subscription session.
- `codex` uses ChatGPT login via `codex login`.
- `gemini` uses Google OAuth / Code Assist.

These environment variables must not be set for normal orchestration:

```text
ANTHROPIC_API_KEY
ANTHROPIC_AUTH_TOKEN
OPENAI_API_KEY
GEMINI_API_KEY
GOOGLE_API_KEY
GOOGLE_APPLICATION_CREDENTIALS
CLAUDE_CODE_USE_BEDROCK
CLAUDE_CODE_USE_VERTEX
AWS_BEARER_TOKEN_BEDROCK
```

If API-key based testing is genuinely needed, document the exception and keep it
out of the default daemon/provider environment.

## Project Purpose

This template provisions:

- a per-project Telegram bot daemon,
- a project-scoped Claude MCP entry,
- a tmux provider session,
- starter `.claude/`, `docs/`, and review-script files for a target project.

Do not hardcode downstream project names, credentials, ports, domains, package
names, business rules, or architecture decisions in template files.

## Documentation Canon

The root `docs/` directory documents this template. The generated project also
receives starter docs that must be filled for that project.

Start here:

- `docs/README.md`
- `docs/QUICKSTART.md`
- `docs/SETUP_CHECKLIST.md`
- `docs/PROJECT_KICKOFF.md`

Project-specific placeholders:

- `docs/definition.md`
- `docs/architektur.md`
- `docs/limitations.md`
- `docs/backlog.md`
- `docs/bugreport.md`
- `docs/STATUS.md`

Stable project-doc structure:

- `docs/development_workflow.md` for planning, implementation, verification,
  doc update, archive, and hard rules.
- `docs/plans/PLAN_*.md` for active plans; `docs/plans/archive/` for shipped
  plans.
- `docs/concepts/CONCEPT_*.md` for active concepts;
  `docs/concepts/archive/` for retired concepts.
- `docs/ops/` for operational runbooks and local config examples.
- `docs/review_packets/` for local reviewer-script output only. The durable
  review outcome belongs in the plan's Reviewer Section.

When adding new docs, keep them universal unless the file is explicitly a
placeholder instructing the target project what to fill in. Do not add new
top-level `docs/` folders unless the starter map in `docs/README.md` is updated
in the same change.

## Roles

- **Human:** owns product direction, credentials, production access, and final
  decisions.
- **Orchestrator:** routes work, starts/reconnects provider sessions, prepares
  prompts, summarizes status, and asks the Human when needed.
- **Coder:** implements scoped changes, updates tests/docs, and verifies.
- **Reviewer:** reviews plans or diffs from a separate session/vendor.

Coder and Reviewer should be different sessions. Prefer different vendors when
available.

## Workflow

For template maintenance:

1. Inspect existing files before changing behavior.
2. Keep changes scoped to template infrastructure or template docs.
3. Update `README.md` / `docs/` when setup behavior changes.
4. Run syntax checks for changed shell scripts.
5. Run focused tests when code changes are touched.
6. Do not include unrelated worktree changes in commits.

For generated projects, use the project kickoff flow in
`docs/PROJECT_KICKOFF.md` before relying on agents for implementation work.

## Verification

Use focused checks based on the files changed.

Shell scripts:

```bash
bash -n scripts/setup.sh scripts/teardown.sh templates/project/scripts/*.sh templates/daemon/*.sh templates/daemon/hooks/*.sh
```

JSON config examples:

```bash
jq empty docs/ops/*.json templates/project/docs/ops/*.json
```

Template residue check:

```bash
rg -n -i "<old-project-name>|<old-domain>|<old-hardcoded-project-id>" . --glob '!.git/**'
```

Daemon TypeScript tests depend on the local template runtime files. Run them
when daemon code changes and the local test harness is present.

## Editing Rules

- Preserve user changes. Do not revert unrelated files.
- Do not read `.env` files or print full environments.
- Do not run destructive git commands unless the Human explicitly asks.
- Do not install packages or mutate lockfiles without Human approval.
- Keep template docs free of old project names and domain-specific behavior.
- Prefer placeholders and setup prompts over invented product decisions.

## Commit Scope

Before committing:

```bash
git status --short
git diff --cached --stat
```

Stage only files related to the requested change. If unrelated deletions or
untracked files exist, leave them out and mention them in the final note.
