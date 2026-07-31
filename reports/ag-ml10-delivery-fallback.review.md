# Independent review: ag-ml10-delivery-fallback

reviewer: Codex reviewer lane (independent of coder session)
independence: reviewer did not author the candidate commits
tier: A (orchestrator runtime, watchdog, and evidence-gate behavior)
reviewed-sha: e644f565a59ab7ad071a8c973f1c5fd70b19b826
base-sha: 26b7f6d4c58ae9736ca8cc1297c816f33f7dc725
verdict: REJECT
deferred-independent-review: not applicable; this is the independent review

## Manifest consumption

- review-policy sha256:b95d6eb6d0e5 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Scope and evidence inspected

- Rebasing onto `origin/main` completed before review. The candidate became
  `e644f565a59ab7ad071a8c973f1c5fd70b19b826` on base
  `26b7f6d4c58ae9736ca8cc1297c816f33f7dc725`.
- Exact diff: 719 insertions and 60 deletions across eight files.
- The current coder report, production diff, both new locks, watchdog wiring,
  fail-open behavior, aggregate test count, secret scan, and rollback were
  independently checked.
- Rollback of the aggregate candidate diff applies cleanly and matches
  `origin/main`, but rollback safety does not cure the blocking runtime finding.

## Blocking findings

1. `daemon/server.ts:2769-2773` regresses `/health.connected` from the existing
   fail-closed `isConnectionAliveForStatus()` oracle to
   `activeServer !== null && isConnectionAlive()`. `isConnectionAlive()` at
   `daemon/server.ts:2723-2728` explicitly returns `true` when the SDK transport
   has no inspectable `_res`. Therefore an unknown transport state is published
   as connected. This violates the standing fail-open bar and is not covered by
   the new integration lock, whose detached fixture only covers the simple
   `activeServer === null` state.
2. `orchestrator/health-checks/telegram-daemon-mcp.sh:23-25` treats
   `mcp_detached:false` as sufficient proof that MCP is connected and exits 0;
   it never reads the health response's `connected` field. A direct probe with
   `{\"mcp_detached\":false,\"connected\":false}` printed
   `OK telegram-daemon-mcp: MCP connected` and returned 0. The green shell lock
   itself uses the weaker `{\"mcp_detached\":false}` fixture, so it enshrines
   this false green. States such as a dead/missing tmux session or non-Claude/no
   binding produce `mcp_detached:false` without proving a live MCP channel.

## Commands and real output

### Rebase, reviewed SHA, and diff count

```text
$ git fetch origin && git rebase origin/main
Successfully rebased and updated refs/heads/ag-ml10-delivery-fallback.

$ git rev-parse HEAD
e644f565a59ab7ad071a8c973f1c5fd70b19b826

$ git merge-base origin/main HEAD
26b7f6d4c58ae9736ca8cc1297c816f33f7dc725

$ git diff --stat origin/main...HEAD
 daemon/mcp-rebind.integration.test.ts             | 176 +++++++++++++++++
 daemon/reliability.ts                             |  10 +
 daemon/server.ts                                  | 230 +++++++++++++++++-----
 orchestrator/health-checks/telegram-daemon-mcp.sh |  29 +++
 orchestrator/telegram-daemon-mcp.test.sh          |  58 ++++++
 orchestrator/watchdog.sh                          |  15 +-
 reports/ag-ml10-delivery-fallback.coder.md        | 113 +++++++++++
 reports/ag-ml10-delivery-fallback.review.md       | 148 ++++++++++++++
 8 files changed, 719 insertions(+), 60 deletions(-)
```

### PASS-AFTER and independently rerun aggregate count

```text
$ orchestrator/telegram-daemon-mcp.test.sh
telegram daemon MCP health/wiring regression: PASS

$ cd daemon && timeout 40s bun test ./mcp-rebind.integration.test.ts
(pass) detached Claude MCP raises an alarm and /reply still delivers through Telegram [264.01ms]
1 pass
0 fail
9 expect() calls
Ran 1 test across 1 file. [307.00ms]

$ timeout 600s bash -lc 'bun test && bun run typecheck'
164 pass
0 fail
548 expect() calls
Ran 164 tests across 16 files. [64.18s]
$ bunx tsc --noEmit
shell_rc=0 narrow_rc=0 full_rc=0
```

### FAIL-BEFORE: locks materialized on `origin/main`

```text
$ cd "$review_tree/daemon" && timeout 40s bun test ./mcp-rebind.integration.test.ts
error: expect(received).toMatchObject(expected)
-   "direct_reply_endpoint": "/reply",
-   "mcp_detached": true,
(fail) detached Claude MCP raises an alarm and /reply still delivers through Telegram
0 pass
1 fail
1 expect() calls
Ran 1 test across 1 file. [259.00ms]

$ cd "$review_tree" && timeout 40s bash orchestrator/telegram-daemon-mcp.test.sh
grep: .../runtime/nudges.outbox: No such file or directory
FAIL: watchdog did not route failed MCP health into durable nudge outbox

candidate_sha=e644f565a59ab7ad071a8c973f1c5fd70b19b826 ts_red_rc=1 watchdog_red_rc=1
red_worktree_removed=yes
```

Both submitted locks bite against the base. The verdict is REJECT because their
green assertions do not cover, and one lock affirmatively accepts, the separate
fail-open state described above.

### Direct fail-open proof

```text
$ printf '{"mcp_detached":false,"connected":false}\n' > /tmp/ag-ml10-health-failopen.json
$ TELEGRAM_DAEMON_HEALTH_URL=file:///tmp/ag-ml10-health-failopen.json orchestrator/health-checks/telegram-daemon-mcp.sh
OK telegram-daemon-mcp: MCP connected
probe_false_rc=0
```

### Static checks and rollback

```text
$ git diff --check origin/main...HEAD
diff_check_rc=0

$ bash -n orchestrator/health-checks/telegram-daemon-mcp.sh orchestrator/telegram-daemon-mcp.test.sh orchestrator/watchdog.sh
bash_n_rc=0

$ git diff --binary origin/main...e644f565 | git -C "$rollback_tree" apply --reverse --index
$ git -C "$rollback_tree" diff --cached --quiet origin/main
rollback_candidate=e644f565a59ab7ad071a8c973f1c5fd70b19b826 apply_reverse_rc=0 matches_origin_main_rc=0
```

## Secret scan

Command:

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"
```

Result: no output; grep exit 1 means no signature hit. `secret-scan: clean`.

## Disposition required

- Restore a fail-closed health connectivity oracle; an uninspectable transport
  must not be reported connected.
- Make the watchdog probe require positive `connected:true` evidence before it
  returns success, and add red-before/pass-after coverage for contradictory and
  unknown connectivity states.
- Re-run independent Tier A review on the replacement SHA.
