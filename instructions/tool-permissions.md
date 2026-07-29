---
id: tool-permissions
layer: L1
status: binding
audience: all
tags: [permissions, security, fail-closed]
summary: Maintain a versioned, fail-closed permission surface; committed policy stays portable and free of secrets.
---

# Tool Permissions

Maintain a versioned, fail-closed permission surface. Local enforcement may be
implemented through settings and hooks, but committed policy must remain
portable and must never contain credentials, tokens, or host-specific secrets.

## Portable baseline

- **Allow:** read-only repository inspection, scoped diffs, approved project
  verification commands, and other reversible checks.
- **Approval:** dependency or lockfile changes, pushes, non-disposable
  migrations, service-manager changes, CI/CD or deployment configuration,
  cloud operations, and access to material that may contain secrets.
- **Deny:** force-pushes to protected refs, destructive reset/clean operations,
  broad recursive deletion, destructive non-test data operations, secret-store
  reads, full environment dumps, and attempts to bypass lane Git boundaries.

Hooks enforce the floor: validate lane ownership and path scope, block denied
commands, require explicit approval where configured, and emit auditable
evidence. Hooks are defense in depth, not a reason to relax the role contract.

Each lane works in its assigned worktree and branch. It may not mutate a
canonical checkout, another lane's branch, or protected history. If a command
does not clearly fit the versioned allow/approval/deny policy, fail closed and
route an asynchronous decision request.
