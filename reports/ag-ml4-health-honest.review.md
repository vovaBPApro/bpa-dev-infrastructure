# Independent review: ML-4 health honesty and suite isolation

verdict: ACCEPT
reviewed-sha: e9fdf879e2de8ef90b516668eee00ca4358d669c
independence: Codex reviewer session; did not author either coder commit
tier: Tier A (orchestrator liveness and live-state isolation)

## Manifest consumption

- review-policy sha256:b95d6eb6d0e5 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Scope and diff inspected

Reviewed `origin/main...e9fdf879e2de8ef90b516668eee00ca4358d669c`: nine files, 120 insertions and 59 deletions. The production change makes `/health.connected` use an inspectable response and live socket. The isolation change centralizes child environment scrubbing and replaces equivalent inline scrubbers in four test files.

`daemon/watchdog-turnend-a1.test.ts` was not skipped or behaviorally weakened. Its only functional change is replacing its inline prefix scrubber with `isolatedTestEnv`; the A1 assertions remain. The full run executed all ten tests in that file and all passed.

## ML-4 fail-before / pass-after lock

To test the pre-fix behavior without creating a false red from a missing export, I temporarily changed only `isTransportSessionConnected` to return the old `serverPresent` observation, ran the lock, and restored the reviewed implementation.

```text
cd daemon && bun test status.test.ts
old behavior: exit 1
(fail) REGRESSION ML-4: dead or half-open transport is not connected
Expected: false
Received: true

reviewed behavior: exit 0
20 pass
0 fail
```

This is a behavioral lock: the destroyed-socket assertion is red under the old `activeServer !== null` semantics and green at the reviewed SHA.

## Full suite with live ORCH pointers

The full suite was run with these live pointers explicitly present in the shell environment: `ORCH_RUNTIME_DIR`, `ORCH_STATE_DB`, `ORCH_LEASE_FILE`, `ORCH_HEARTBEAT_FILE`, `ORCH_LOCK_FILE`, `ORCH_INSTANCE_LOCK_FILE`, and `ORCH_SINGLETON_LOCK_FILE`.

```text
cd daemon && timeout 300 env \
  ORCH_RUNTIME_DIR=/root/bpa-dev-infrastructure/orchestrator/runtime \
  ORCH_STATE_DB=/root/bpa-dev-infrastructure/runtime/state.db \
  ORCH_LEASE_FILE=/root/bpa-dev-infrastructure/orchestrator/runtime/orchestrator.lease \
  ORCH_HEARTBEAT_FILE=/root/bpa-dev-infrastructure/orchestrator/runtime/orchestrator.heartbeat \
  ORCH_LOCK_FILE=/root/bpa-dev-infrastructure/orchestrator/runtime/launch.lock \
  ORCH_INSTANCE_LOCK_FILE=/root/.claude/orchestrator-chat-83769716.lock \
  ORCH_SINGLETON_LOCK_FILE=/root/bpa-dev-infrastructure/runtime/orchestrator.singleton.lock \
  bun test

155 pass
0 fail
524 expect() calls
Ran 155 tests across 14 files. [69.60s]
```

The run completed without hanging. A1 results were ten passes, including the placeholder/turn-end delivery lock, pane-scrape lock, exactly-once lock, overlap lock, Codex fallback lock, and the decision-layer suppressions.

## Live state before and after

The following SHA-256 lines were identical before and after the full suite; `cmp` exited 0.

```text
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /root/bpa-dev-infrastructure/orchestrator/runtime/launch.lock
3c7b15cd6186ee0438e787c5fb35833a0f8da660649e74d75935e505d56a3737  /root/bpa-dev-infrastructure/orchestrator/runtime/orchestrator.lease
aa6498fe8f331f6fe32e27090a0f59f761669533000100bb5f166bdf928b0c2f  /root/bpa-dev-infrastructure/orchestrator/runtime/orchestrator.heartbeat
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  /root/bpa-dev-infrastructure/runtime/orchestrator.singleton.lock
b1894903e36167d623fb3b19ec2ff06e6d1a2a22dcedb7ea45488e8ba2e80d73  /root/.claude/orchestrator-chat-83769716.lock
```

Finding: no live lock, lease, or heartbeat byte changed.

## Findings and rollback posture

No blocking findings. The health helper fails closed when the server, transport, response, or socket evidence is absent/dead. The shared isolation helper strips entire `ORCH_`, `TELEGRAM_`, and `INFRA_` prefixes before adding test-owned overrides, preventing future live pointer names from leaking by default. Rollback is a normal revert of the two coder commits; it restores the known dishonest health result and duplicated isolation helpers, so it should only be used to back out the whole change if a new regression is found.
