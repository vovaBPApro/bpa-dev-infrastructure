# Coder terminal report: ag-ml10-delivery-fallback

delivery-head: `528bc60` (`[CODER] isolate MCP fallback regression process env`)
base: `fd8ac29` (rebased `origin/main`)

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

## Review blockers closed

- The daemon integration lock now fails on `origin/main`, where the health
  response lacks `mcp_detached` and `/reply`, and passes with the delivery fix.
- Detached, unavailable, and invalid health responses return nonzero.
- The existing runtime watchdog executes the MCP check and routes its failing
  verdict into the durable, rate-limited nudge outbox.
- The full daemon suite terminates when allowed to finish the installed real
  Whisper engine tests. The final run completed in 66.77s rather than leaking
  an open handle.
- All spawned test children use the shared `daemon/test-env.ts` isolation helper
  landed by ML-4; the lock does not inherit live control-plane state.

## FAIL-BEFORE

Command (disposable worktree at `origin/main`, with the replacement locks and
health probe materialized from `528bc60`; production files remain at base):

```sh
cd "$red_tree/daemon" && timeout 40s bun test ./mcp-rebind.integration.test.ts
cd "$red_tree" && timeout 40s bash orchestrator/telegram-daemon-mcp.test.sh
```

Real result:

```text
error: expect(received).toMatchObject(expected)
-   "direct_reply_endpoint": "/reply",
-   "mcp_detached": true,
0 pass
1 fail
ts_red_before_rc=1
grep: .../runtime/nudges.outbox: No such file or directory
FAIL: watchdog did not route failed MCP health into durable nudge outbox
watchdog_red_before_rc=1
```

## PASS-AFTER

Commands and real results:

```text
$ orchestrator/telegram-daemon-mcp.test.sh
telegram daemon MCP health/wiring regression: PASS

$ cd daemon && timeout 30s bun test mcp-rebind.integration.test.ts
1 pass
0 fail
9 expect() calls

$ timeout 600s bash -lc 'cd daemon && bun test && bun run typecheck'
156 pass
0 fail
533 expect() calls
Ran 156 tests across 15 files. [66.77s]
$ bunx tsc --noEmit
full_suite_rc=0
```

## Rollback evidence

In a disposable worktree at `528bc60`:

```text
$ git revert --no-commit 528bc60 3e3de9e f6139a2 74aa966
rollback_apply_rc=0
```

The resulting scoped rollback removes the two new locks and MCP health check,
and reverts only `daemon/reliability.ts`, `daemon/server.ts`, and
`orchestrator/watchdog.sh`; the disposable worktree was then removed.

secret-scan: clean
remaining: independent re-review and landing
