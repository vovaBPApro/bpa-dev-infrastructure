# Independent review: ag-ml10-delivery-fallback

reviewer: Codex reviewer lane (independent of coder session)
independence: reviewer did not author the candidate commits
tier: A (orchestrator runtime, watchdog, and delivery evidence behavior)
reviewed-sha: a92e6b2eeb99661a4fd90a87a4b0e1fc89275861
base-sha: 78d51e4e5bed437d2fff83242437557402b77843
verdict: ACCEPT
deferred-independent-review: not required; this is the independent Tier-A review

## Manifest consumption

- review-policy sha256:b95d6eb6d0e5 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Decision

ACCEPT. The blockers from the prior verdict are closed on the exact reviewed
SHA. Detached Claude MCP state is fail-closed, produces a nonzero health verdict,
and the installed watchdog routes that verdict to its durable alarm outbox. The
direct `/reply` fallback waits for Telegram acknowledgement and returns the
acknowledged message ids; the detached integration lock observes exactly one
Telegram delivery.

The healthy probe requires both `mcp_detached:false` and `connected:true`. It
returns success without invoking the fallback endpoint, so the fallback does not
double-send on the healthy path. Contradictory and connectivity-omitting payloads
both fail instead of manufacturing readiness.

The ML-2-shaped fail-open hunt found no delivered-without-evidence path in the
new fallback: `sendTelegramReply()` awaits each Telegram API call and collects
its returned `message_id`; `/reply` calls `markReplied(chat)` only after that
promise resolves. A rejection takes the catch path, returns HTTP 502, and leaves
the pending reply unacknowledged.

## Evidence rerun by reviewer

```text
$ git fetch origin && git rebase origin/main
Current branch ag-ml10-delivery-fallback is up to date.

$ git rev-parse HEAD
a92e6b2eeb99661a4fd90a87a4b0e1fc89275861

$ orchestrator/telegram-daemon-mcp.test.sh
telegram daemon MCP health/wiring regression: PASS

$ cd daemon && timeout 40s bun test ./mcp-rebind.integration.test.ts
1 pass
0 fail
9 expect() calls
Ran 1 test across 1 file.

$ timeout 600s bash -lc 'cd daemon && bun test && bun run typecheck'
182 pass
0 fail
577 expect() calls
Ran 182 tests across 18 files.
$ bunx tsc --noEmit
aggregate_rc=0

$ TELEGRAM_DAEMON_HEALTH_URL=file://<contradictory.json> orchestrator/health-checks/telegram-daemon-mcp.sh
WARN telegram-daemon-mcp: MCP connectivity not proven
contradictory_rc=1

$ TELEGRAM_DAEMON_HEALTH_URL=file://<missing-connected.json> orchestrator/health-checks/telegram-daemon-mcp.sh
WARN telegram-daemon-mcp: MCP connectivity not proven
missing_rc=1

$ git diff --check origin/main...HEAD
diff_check_rc=0

$ bash -n orchestrator/health-checks/telegram-daemon-mcp.sh orchestrator/telegram-daemon-mcp.test.sh orchestrator/watchdog.sh
bash_n_rc=0
```

The independently rerun merged-tree count is therefore exactly `182 pass`,
`0 fail`, and `577 expect()` calls across 18 daemon test files.

## Regression and rollback posture

The submitted TypeScript lock fails when materialized against `origin/main`
because the base health response lacks detach/fallback fields. The watchdog lock
also fails against the base because the durable detach alarm is absent. Both pass
at the reviewed SHA. The later contradictory and missing-connectivity fixtures
were separately demonstrated red before the fail-closed probe fix and pass now.

In a disposable worktree at the reviewed SHA, this aggregate rollback completed:

```sh
git diff --binary origin/main...HEAD | git apply --reverse --index
git diff --cached --quiet origin/main
```

Both commands exited 0, proving the aggregate change reverses exactly to the
current base. The disposable worktree was then removed.

## Secret scan

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"
```

Result: no output; grep exit 1 means no signature hit.
secret-scan: clean

## Findings and disposition

No blocking finding remains. Scope is limited to the daemon MCP health and
acknowledged fallback surface, its watchdog consumer, regression locks, and
mission evidence. Landing may proceed through the Tier-A gate.
