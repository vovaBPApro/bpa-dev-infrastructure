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

## The verify's own capability: `host-state`

A lane's `verify:` command carries a capability too — what it needs from the
machine it runs on. A verify that reads the running installation's files,
configured paths, ambient environment or permissive umask is green where it was
written and red everywhere else, and the cost lands on whoever runs it next.

- **The default is hermetic**, and it is enforced rather than requested: the
  lane-exit gate re-runs the declared `verify:` in a clean clone with the
  environment scrubbed, `umask 077`, and the host's home and config directories
  masked. A verify that only passes outside that world has an undeclared
  dependency on this host.
- **Declare it in the terminal report** when the dependency is legitimate:
  `bare-world: capability=<name> reason=<why>`, one line, both parts required.
  `host-state` covers reading the installation's own files and configuration;
  `network`, `docker` and `service-ops` keep the meanings the table above gives
  them. A reason is mandatory because the declaration is a claim someone will
  have to re-read when the verify breaks on another machine.
- **A declaration accepts the failure; it never hides it.** The delta is still
  reported, so a lane that declared out of habit is visible as one whose verify
  is doing something it need not do.
- **Absence of a declaration is a named refusal**, not a silent red: the lane
  exit reports `NO-GO capability=host-state` together with the environmental
  delta it could diagnose — the host path that was read, the scrubbed variable,
  the permission or mode. An unknown capability name is refused the same way,
  per the fail-closed rule above.

### A check that could not run has not passed

The environment can be missing what the check itself needs. The masking step
requires an unprivileged mount namespace and a maskable home directory, and
without them an absolute path into the installation's config dirs stays
readable — the exact class the step exists to catch.

- **A degraded run may not clear the step.** It reports the missing capability
  by name (`NO-GO capability=mount-namespace`, `NO-GO capability=maskable-home`)
  and blocks exactly as a failed check does. "It ran at reduced fidelity and
  passed" is a partial result reported as clean, which
  `verification-and-locks` forbids without qualification. Announcing the
  reduction in a log nobody consumes is not a mitigation: the announcement has
  to reach the thing that decides.
- **The exception is declared, in the same field, and it is the environment
  that is being declared** — not a preference: `bare-world: capability=mount-namespace
  reason=<why>`. It buys a clearance at reduced fidelity and nothing else; it
  accepts no failure, and a capability declared for one gap never covers
  another. Declare several at once as `capability=<name>,<name>`.
- **A test affordance may never grant what the environment lacks.** Where a
  suite forces a capability missing to exercise the degraded path, that may only
  make the gate stricter: on a host that really has the capability, forcing it
  missing is refused outright and no declaration is honoured.

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
