---
id: lane-capabilities
layer: L1
status: binding
audience: all
tags: [lane, permissions, capabilities, portability]
summary: Declare fail-closed capabilities for sandboxed lanes and trusted executors.
---

# Lane Capabilities

A lane declares one mode before work begins:

- `sandboxed-lane` may inspect, test, commit, and push locally.
- `trusted-executor` may exercise every declared capability and owns network,
  Docker, worktree reaping, service operations, and landing.

| Capability | `sandboxed-lane` | `trusted-executor` |
| --- | --- | --- |
| `inspect` | allow | allow |
| `test` | allow | allow |
| `commit` | allow | allow |
| `push` | allow | allow |
| `network` | deny | allow |
| `docker` | deny | allow |
| `worktree-reap` | deny | allow |
| `service-ops` | deny | allow |
| `land` | deny | allow |

Before an operation, check its capability against the declared mode. A denied
or unknown mode or capability emits exactly `NO-GO capability=<name>` and stops
cleanly. It must never stall waiting for interactive recovery.

This contract specializes the fail-closed policy in
`instructions/tool-permissions.md`. Its emitted evidence follows
`instructions/verification-and-locks.md`.
