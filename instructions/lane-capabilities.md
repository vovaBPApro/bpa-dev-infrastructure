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

## Declared command bounds

A lane's harness may kill a foreground command at a bound the lane did not
choose, cannot see, and is not told about when it fires. That bound is a
capability like any other, and the same fail-closed rule applies to it.

- **Declare the bound in tracked configuration**, where the lane's invocation is
  already defined. A reader must be able to see what bound a lane runs under
  *without launching one*. An inherited default is not a declaration: it is a
  number nobody chose, which changes when the harness changes.
- **The declared bound must exceed the longest bound any mechanism the lane
  invokes enforces on itself.** A harness bound tighter than an inner
  mechanism's own timeout replaces that mechanism's honest timeout report with a
  truncated kill, and the inner bound then never fires at all.
- **A bound that falls inside the measured range of a routine command is the
  worst case**, not a near miss. It makes the same command pass or die run to
  run, so every result becomes unreproducible and the failure looks like
  flakiness in whatever the command was testing.
- **Prove a declared bound by executing against it**, in both directions: a
  command the old bound would have killed now completes, and a command
  exceeding the new bound is still killed. A plausible variable name is not
  evidence that anything reads the variable.
- **Run a command whose runtime may approach the bound in the background and
  poll for its result.** "Measure it in the foreground" is advice that produces
  exactly the truncated kill it was meant to measure.

This contract specializes the fail-closed policy in
`instructions/tool-permissions.md`. Its emitted evidence follows
`instructions/verification-and-locks.md`, which owns why a kill may never be
read as a pass.
