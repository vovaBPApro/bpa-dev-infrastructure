# Watchdog recovery round 8 — coder terminal report

## Mission pack consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:6dc6f5d4768f — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Result

Bootstrap arm and deployed verification still use the same production parser.
That parser now accepts only a provably identical subset of systemd
`EnvironmentFile=` syntax: backslashes, quotes, CR, DEL, and unsupported control
bytes are rejected before physical-line parsing. An ordinary unrelated
assignment before the token remains accepted.

Isolated arm and verify fixtures lock backslash continuation, single- and
double-quoted multiline values, escaped backslashes, leading/embedded CR, CRLF,
space/tab/CR duplicate combinations, and later-value precedence. A production
mutation restores the round-7 physical-line behavior and proves the continuation
fixture goes red before the fix.

The real production token parser now has accepted 6- and 15-digit bot-id locks,
rejected adjacent 5- and 16-digit locks, and independent executable mutations
that widen each bound. Existing secret-part 20/128, adjacent/very-long, masking,
non-disclosure, arm ordering, and restart/singleton/fencing/retry locks remain.

No live service, session, timer, unit, credential, or runtime file was touched.

## Evidence

Passed:

- `bun bootstrap/telegram-transport-preflight.test.ts`
- `bash bootstrap/bootstrap.test.sh`
- `bash orchestrator/watchdog.test.sh`
- `bash orchestrator/watchdog-lease-guard.test.sh`
- `ORCH_SKIP_TRUST_CHECK=1 bash orchestrator/singleton-failclosed.test.sh`
- `bash orchestrator/knob-bounds.test.sh`
- `bash orchestrator/cadence-knob.test.sh`
- `bash orchestrator/heartbeat-liveness.test.sh`
- `bash bootstrap/deployed-drift.test.sh`
- `bash orchestrator/telegram-daemon-mcp.test.sh`
- shell syntax and `git diff --check`

Required fail-closed blockers:

- `bash orchestrator/watchdog-supervision.test.sh` and
  `bun orchestrator/watchdog-transport-boundary.test.ts` time out with no
  loopback request under installed Bun 1.2.22.
- `cd daemon && bun test watchdog-turnend-a1.test.ts`: 5 pass, 5 timeout.
- `cd daemon && bun test`: multiple daemon integration timeouts; the run was
  stopped after it ceased producing progress, so full-suite evidence is partial.
- `cd daemon && bunx tsc --noEmit`: missing `bun-types` and `node` type
  definitions.
- Fresh dual Tier-A review is not present and is mandatory only after the
  required checks are green.

commit: 3188347fbd04ff80bbe17a94376335c16f201544 [CODER] reject ambiguous watchdog environment files
verify: bun bootstrap/telegram-transport-preflight.test.ts && bash bootstrap/bootstrap.test.sh && bash orchestrator/watchdog-supervision.test.sh && bun orchestrator/watchdog-transport-boundary.test.ts && (cd daemon && bun test watchdog-turnend-a1.test.ts)
result: NO-GO
blocker: installed Bun 1.2.22 real-daemon/turn-end/full-daemon checks time out; TypeScript definitions are absent
secret-scan: clean
remaining: run required daemon checks on declared Bun 1.3.14, then obtain fresh dual Tier-A review
