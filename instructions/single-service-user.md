---
id: single-service-user
layer: L1
status: binding
audience: all
tags: [lane, permissions]
summary: The control plane and its lanes share one lingering non-root service identity.
---

# Single Service User

The orchestrator, daemon, repository, linked worktrees, and lane processes use
one dedicated, lingering, non-root service identity. Installation-specific
names and paths belong in `instance/`; implementations must not hard-code them.

This model provides ownership consistency, not inter-lane security isolation.
Lanes sharing the identity can access sibling worktrees and are confined by the
one-writer-per-worktree convention. Kernel-enforced per-lane confinement would
require a separate hardening design and is not a property of this model.
