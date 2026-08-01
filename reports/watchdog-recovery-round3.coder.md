# Watchdog recovery round 3 — coder report

## Instruction-pack consumption

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

`NO-GO`.

The singleton launcher race is fixed at the production boundary: the caller
reserves the singleton before tmux creation, proves terminal-alert readiness,
then hands ownership to the pane. The second launch now deterministically emits
`ERROR orchestrator-singleton-held` and leaves no refused tmux session.

The rejected direct `drainOutbox` callback was replaced with an executable lock
that starts `daemon/server.ts`, uses isolated state and a loopback Telegram HTTP
endpoint, and requires success acknowledgement plus retained/bounded retry on a
rejected response.

That new lock is red on a deeper deployed-boundary failure: the real daemon
starts its HTTP listener but makes no Telegram request (`getMe`, `getUpdates`,
or `sendMessage`). The pre-existing `daemon/watchdog-turnend-a1.test.ts` also
times out at its daemon transport boundary on this candidate. Therefore Human
reachability is not proven and this candidate must not land.

## Evidence

- PASS: `ORCH_SKIP_TRUST_CHECK=1 bash orchestrator/singleton-failclosed.test.sh`
- FAIL: `bun orchestrator/watchdog-transport-boundary.test.ts`
  (`timeout waiting for successful send; methods=`)
- FAIL: `cd daemon && bun test watchdog-turnend-a1.test.ts`
  (`timed out waiting for watchdog placeholder suppression log`)

The simultaneous orchestrator+daemon failure boundary remains explicit: the
durable outbox survives, but Human notification waits for daemon recovery; no
separately credentialed off-host channel exists in this change.

blocker: diagnose and repair why the installed daemon entrypoint never starts
Telegram polling in the isolated executable boundary, then rerun all round-3
locks and dual Tier-A rereview.
