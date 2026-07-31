# Independent review: ag-ml10-delivery-fallback

reviewer: Codex reviewer lane (independent of coder session)
independence: reviewer did not author commits dc679c7b or a85e4e0e
tier: A (orchestrator runtime and health/evidence gate)
reviewed-sha: a85e4e0e0d9c78bbfd02105056f572dae834bab5
base-sha: 62eb1717
verdict: REJECT
deferred-independent-review: not applicable; this is the independent review

## Manifest consumption

- review-policy sha256:b95d6eb6d0e5 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions

## Scope and evidence inspected

- Commit titles: `[CODER] restore MCP detach fallback delivery` and `[CODER] make MCP detach alarm executable`.
- Exact diff: `git diff origin/main...HEAD` (388 insertions, 53 deletions across four files).
- Coder terminal report: absent; there was no `reports/` directory at the reviewed SHA.
- Rollback posture: the two production commits are separable, but no supplied rollback evidence or terminal report was available.

## Blocking findings

1. `daemon/mcp-rebind.integration.test.ts:65` is a false-green regression lock. In a disposable worktree at `origin/main`, with only this test file checked out from the reviewed commit, it still reported `1 pass`, `0 fail`, and `red_before_rc=0`. It therefore does not demonstrate red-before/pass-after and cannot gate the claimed production fix.
2. `orchestrator/health-checks/telegram-daemon-mcp.sh:8-12` explicitly returns success when the health endpoint is unavailable. Lines 17-27 also return success for detached MCP and invalid health data. Direct probes confirmed both unavailable and invalid responses exit 0. This manufactures a green executable health check when truth is unavailable or the fault is present.
3. `orchestrator/health-checks/telegram-daemon-mcp.sh:1` is not wired into any runtime, scheduler, or existing health-check runner. `rg -n "telegram-daemon-mcp" .` found only the script and its integration test. The title `make MCP detach alarm executable` overclaims operational alarm delivery: executable mode alone does not execute or route the warning.
4. The full declared daemon suite did not terminate. It printed 96 visible passes, then remained open without a summary or exit until interrupted; the resulting exit was 130. The narrow new test and typecheck pass, but partial output cannot establish a green suite.

## Commands and real output

### Reviewed SHA and diff

```text
$ git rev-parse HEAD
a85e4e0e0d9c78bbfd02105056f572dae834bab5

$ git diff --stat origin/main...HEAD
 daemon/mcp-rebind.integration.test.ts             | 174 ++++++++++++++++
 daemon/reliability.ts                             |  10 +
 daemon/server.ts                                  | 230 +++++++++++++++++-----
 orchestrator/health-checks/telegram-daemon-mcp.sh |  27 +++
 4 files changed, 388 insertions(+), 53 deletions(-)
```

### Full daemon suite and typecheck command

```text
$ cd daemon && bun test && bun run typecheck
bun test v1.2.22 (6bafe260)
...
96 visible `(pass)` rows; no terminal test summary; command remained running.
Reviewer sent SIGINT.
exit_code=130
```

Because `bun test` did not exit zero, the chained typecheck did not run in this command.

### Narrow reviewed lock

```text
$ cd daemon && timeout 30s bun test mcp-rebind.integration.test.ts
bun test v1.2.22 (6bafe260)

mcp-rebind.integration.test.ts:
(pass) detached Claude MCP raises an alarm and /reply still delivers through Telegram [552.03ms]

 1 pass
 0 fail
 9 expect() calls
Ran 1 test across 1 file. [651.00ms]
test_rc=0
```

### Typecheck

```text
$ cd daemon && timeout 30s bun run typecheck
$ bunx tsc --noEmit
typecheck_rc=0
```

### Required red-before regression proof

```text
$ review_tmp=$(mktemp -d /tmp/ag-ml10-red.XXXXXX)
$ git worktree add --detach "$review_tmp" origin/main
Preparing worktree (detached HEAD 62eb1717)
$ git -C "$review_tmp" checkout a85e4e0e -- daemon/mcp-rebind.integration.test.ts
$ ln -s "$PWD/daemon/node_modules" "$review_tmp/daemon/node_modules"
$ timeout 30s bun test mcp-rebind.integration.test.ts   # run in disposable worktree
bun test v1.2.22 (6bafe260)

daemon/mcp-rebind.integration.test.ts:
(pass) detached Claude MCP raises an alarm and /reply still delivers through Telegram [580.03ms]

 1 pass
 0 fail
 9 expect() calls
Ran 1 test across 1 file. [688.00ms]
red_before_rc=0
```

The disposable worktree was removed after the run.

### Fail-open probes

```text
$ TELEGRAM_DAEMON_HEALTH_URL=file://<valid-temp-file-with-no-mcp-fields> bash orchestrator/health-checks/telegram-daemon-mcp.sh
WARN telegram-daemon-mcp: invalid health response
invalid_json_rc=0

$ TELEGRAM_DAEMON_HEALTH_URL=http://127.0.0.1:1 TELEGRAM_DAEMON_HEALTH_TIMEOUT_SECONDS=1 bash orchestrator/health-checks/telegram-daemon-mcp.sh
WARN telegram-daemon-mcp: health endpoint unavailable: curl: (7) Failed to connect to 127.0.0.1 port 1 after 0 ms: Couldn't connect to server
unavailable_rc=0
```

### Static checks

```text
$ git diff origin/main...HEAD --check
<no output; exit 0>

$ bash -n orchestrator/health-checks/telegram-daemon-mcp.sh
<no output; exit 0>
```

## Secret scan

Command:

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"
```

Result: no output / no hit. `secret-scan: clean`.

## Disposition required

- Make the regression lock demonstrably fail on `origin/main` and pass only with the fix.
- Make failure/detachment machine-detectable with nonzero status, or document and test a separate consumer that turns WARN into a failing alarm signal.
- Wire the check into the actual runtime monitoring path and test that boundary.
- Diagnose the non-terminating full daemon suite and provide a fresh exit-0 run.
- Supply the coder terminal report and rollback evidence on the replacement SHA.
