# GAP-5 r6 coder terminal evidence

candidate: `6874f9572895b288d42b307ebc827d7ea22e7e62`

## Consumption check

- lane-lifecycle `sha256:84d3db25d785` — Lane Lifecycle
- verification-and-locks `sha256:b6f8862a801d` — Verification and Regression Locks
- tool-permissions `sha256:955630cc416e` — Tool Permissions
- repository-hygiene `sha256:02acdffe2a56` — Repository Hygiene
- isolated-test-environments `sha256:6ffd35d7c9f1` — Isolated Test Environments
- operator-feedback `sha256:6dc6f5d4768f` — Operator Feedback
- instruction-layers `sha256:cd21f4ce0990` — Instruction Layers
- branching-policy `sha256:98cd92116325` — Branching Policy
- reproducible-from-git `sha256:822d9efe694b` — Reproducible From Git

## Evidence

- Focused: 28 pass, 0 fail; provenance, journal runtime, and state locks.
- Real systemd: PASS; unique unit/state names covered start, measured tick,
  restart/new InvocationID, stale replay refusal, partial/corrupt rows,
  rollback, cleanup, and zero residuals without touching the live watchdog.
- Mutation red-before: replacing the current InvocationID with the stored value
  made the real-systemd stale-replay lock fail as required.
- Clean-clone reconstruction: 18 pass, 0 fail.
- `orchestrator/morning.test.sh`: PASS and explicitly fails closed without an
  externally measurable active producer epoch.
- `orchestrator/watchdog-supervision.test.sh`: NO-GO; its child daemon could not
  reach the loopback Telegram fixture (`methods=` remained empty), and the same
  host boundary also timed out `daemon/mcp-rebind.integration.test.ts`.
- Typecheck: NO-GO; this isolated checkout lacks `bun-types` and `node` type
  definitions. No dependency installation or lockfile mutation was authorized.
- Highest full suite: NO-GO at the same transport boundary; no pass inferred.

No deploy, live watchdog mutation, landing, or push occurred.

commit: 6874f9572895b288d42b307ebc827d7ea22e7e62 [CODER] reject stale watchdog epochs with systemd evidence
verify: bash core/tick-journal-reconstruction.test.sh && bash core/watchdog-systemd.test.sh && bash orchestrator/morning.test.sh && bash orchestrator/watchdog-supervision.test.sh
result: NO-GO — watchdog supervision/full-suite transport subject and typecheck dependencies are unavailable
secret-scan: clean
remaining: restore isolated loopback transport and declared type dependencies, rerun supervision/typecheck/full suite, then obtain fresh Tier-A review
