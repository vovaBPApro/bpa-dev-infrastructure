---
id: repository-hygiene
layer: L1
status: binding
audience: all
tags: [hygiene, git, secrets]
summary: Git holds reviewed source, tests, docs, and retained governance evidence — not host state, caches, logs, or secrets.
---

# Repository Hygiene

## Binding rules

- Git contains reviewed source, tests, documentation, and deliberately retained governance evidence—not host state, generated caches, temporary workspaces, logs, or credentials.
- Ignore generated state narrowly by subsystem path. Do not use broad patterns that can hide source, tests, evidence, or a newly created security-sensitive file.
- Do not add chat exports, session histories, prompts, raw tool transcripts, or browser captures to Git. Keep durable reports only under a deliberate retention policy and redact them before storage.
- Preserve visible candidate source files until their owner decides to commit, move, or delete them. Do not solve repository noise by ignoring unknown source-like files.
- Run a secret scan on every commit range before landing, including historical import surfaces. Any hit blocks the commit or landing until removed and reassessed.
- Review `git status --short` before commit and keep commits narrow. Do not mix unrelated generated output, formatting churn, or cleanup with a functional change.
- Reap worktrees, merged branches, temporary trees, caches, and old raw evidence through a documented mechanism and bounded retention policy. Never rely on an operator remembering cleanup.
- Never automatically delete tracked files; destructive cleanup requires an exact target, dry-run evidence, and explicit authority.

Why: a clean, inspectable repository protects secrets and makes evidence, provenance, and real source changes visible.
