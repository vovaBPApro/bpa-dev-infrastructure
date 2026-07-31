# Coder terminal report: ag-ml10-delivery-fallback

commit: 0e8557397fc48f7104bc1b7c8612d25122ea63a9 [CODER] fail closed MCP connectivity health
verify: orchestrator/telegram-daemon-mcp.test.sh >/dev/null && cd daemon && bun test && bun run typecheck
verify-count: 182/0
result: NO-GO
blocker: Tier A orchestrator runtime and health/evidence-gate change requires independent re-review of the replacement SHA.
secret-scan: clean
remaining: independent re-review and landing

## Approach assessment

The rejected approach was wrong in three material ways: its daemon health oracle
treated an uninspectable SDK transport as alive, its shell probe accepted
`mcp_detached:false` without positive connectivity evidence, and executable mode
was mistaken for runtime wiring. The replacement uses the fail-closed status
oracle for `/health`, requires both `mcp_detached:false` and `connected:true`,
and keeps the existing watchdog as the consumer of the durable alarm path.

## Review blockers closed

- The daemon integration lock fails on current `origin/main`, whose health
  response lacks the detach fields and direct fallback endpoint.
- Detached, unavailable, invalid, contradictory, and connectivity-omitting
  health responses return nonzero.
- The installed watchdog executes the MCP probe and puts its exact failing
  verdict in the durable nudge outbox.
- The complete daemon suite reached its terminal summary and typecheck exited
  successfully; no partial-output verdict is used.
- Spawned children use the shared `daemon/test-env.ts` isolation helper from
  ML-4, so the lock does not inherit live control-plane state.

## FAIL-BEFORE

The new contradictory/missing-connectivity fixtures were run before the shell
probe fix in this lane:

```sh
orchestrator/telegram-daemon-mcp.test.sh
```

Real output:

```text
FAIL: contradictory returned success
fail_before_rc=1
```

## PASS-AFTER

Commands:

```sh
orchestrator/telegram-daemon-mcp.test.sh
cd daemon && timeout 40s bun test ./mcp-rebind.integration.test.ts
timeout 600s bash -lc 'cd daemon && bun test && bun run typecheck'
```

Real output:

```text
telegram daemon MCP health/wiring regression: PASS
(pass) detached Claude MCP raises an alarm and /reply still delivers through Telegram [251.01ms]
1 pass
0 fail
9 expect() calls
Ran 1 test across 1 file. [299.00ms]
Ran 182 tests across 18 files. [62.71s]
577 expect() calls
$ bunx tsc --noEmit
pass_after_rc=0
```

The machine-checkable reproduced aggregate is recorded only in `verify-count`.

## Rollback evidence

In a disposable worktree at the reported implementation SHA:

```sh
git diff --binary origin/main...HEAD | git apply --reverse --index
```

Real result:

```text
rollback_rc=0
git diff --cached --quiet origin/main
matches_base_rc=0
```

The disposable worktree was removed after the aggregate mission rollback matched
`origin/main` exactly. Commit-by-commit revert is intentionally not claimed:
post-review changes on `main` overlap the oldest lane commit, while reversing the
landed aggregate diff is conflict-free and restores the current base.

## Manifest consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- repository-hygiene sha256:8b21c6129e5c — Repository Hygiene
- isolated-test-environments sha256:d0c2162eeba5 — Isolated Test Environments
- operator-feedback sha256:82d309b667eb — Operator Feedback
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- branching-policy sha256:dbe7ace1193b — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git
