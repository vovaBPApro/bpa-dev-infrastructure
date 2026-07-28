# Multi-Project Isolation

## Binding rules

- Give each project an independent state root, secrets location, service identity, process/session namespace, lease namespace, ports, workspaces, logs, and durable mission store.
- Bind adapters and routing to the intended project explicitly. A fallback to a host-global project path, state file, or default port is a cross-project incident risk and must be removed or fail closed.
- Keep credentials project-scoped with restrictive filesystem permissions. Never share a token, `.env`, access list, or operator offset across projects.
- Allocate ports from a collision-checked namespace and verify the actual owning process after startup. A successful HTTP response on a requested port is insufficient evidence of isolation.
- Record every deliberately shared resource—such as a host Docker daemon, package cache, network, or disk budget—and define its contention, ownership, and cleanup rules. Shared mutable state requires serialization or a durable lease.
- Scope daemon imports and generated runtime assets with their project. Every runtime import must be present in the deployed artifact; test boot from the isolated deployment, not only from a source checkout.

Why: isolation has to cover every singleton, not only the visible service port, or one project can resume, notify, or mutate another.
