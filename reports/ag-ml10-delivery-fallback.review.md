# Independent review: ag-ml10-delivery-fallback

reviewer: Codex reviewer lane (independent of coder session)
independence: reviewer did not author the candidate commits
tier: A (orchestrator runtime, watchdog, and delivery evidence behavior)
reviewed-sha: b0abb71960b1aaa8662b060c331f9ca1421d5166
base-sha: f4741461c86a98b9fd9f4ad0fa8487aae2a068ba
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

- `git fetch origin && git rebase origin/main` completed before review.
- The exact reviewed diff has 736 insertions and 60 deletions across eight files.
- I reviewed the daemon health oracle, fallback `/reply` acknowledgement path,
  watchdog consumer, both submitted locks, prior verdict, and coder report.
- `/reply` waits for Telegram `sendMessage`/attachment responses and returns 502
  on rejection; it does not record `markReplied` before that evidence. This path
  does not reproduce the ML-2 unacknowledged-send fault.
- The healthy-path implementation invokes no automatic fallback, and the
  integration lock observes exactly one Telegram delivery for an explicit
  fallback call. That is useful evidence, but it does not cure the health
  false-green below.

## Blocking findings

1. `daemon/server.ts` still computes `/health.connected` with
   `activeServer !== null && isConnectionAlive()`. `isConnectionAlive()` returns
   `true` when the SDK transport has no inspectable `_res`, while the existing
   `isConnectionAliveForStatus()` is explicitly fail-closed. An unknown
   transport can therefore be published as connected and suppress the detach
   alarm. The submitted integration lock covers `activeServer === null`, not an
   active transport with unknown response state.
2. `orchestrator/health-checks/telegram-daemon-mcp.sh` still treats
   `mcp_detached:false` as sufficient proof of connectivity and never parses
   `connected`. With the contradictory payload
   `{"mcp_detached":false,"connected":false}`, it prints
   `OK telegram-daemon-mcp: MCP connected` and exits 0. The shell lock enshrines
   this false green by using a `{"mcp_detached":false}` success fixture. Thus a
   path can conclude healthy/delivered routing readiness without positive MCP
   delivery evidence.
3. The rebased coder report claims `verify-count: 164/0`; the independently
   rerun current suite reports `182 pass`, `0 fail`, and `577 expect()` calls.
   The required count claim does not equal the current reviewed state.

## Commands and real output

```text
$ git fetch origin && git rebase origin/main
Successfully rebased and updated refs/heads/ag-ml10-delivery-fallback.

$ git rev-parse HEAD
b0abb71960b1aaa8662b060c331f9ca1421d5166

$ orchestrator/telegram-daemon-mcp.test.sh
telegram daemon MCP health/wiring regression: PASS

$ cd daemon && timeout 40s bun test ./mcp-rebind.integration.test.ts
1 pass
0 fail
9 expect() calls
Ran 1 test across 1 file.

$ printf '{"mcp_detached":false,"connected":false}\n' > "$probe_file"
$ TELEGRAM_DAEMON_HEALTH_URL="file://$probe_file" orchestrator/health-checks/telegram-daemon-mcp.sh
OK telegram-daemon-mcp: MCP connected
contradictory_probe_rc=0

$ timeout 600s bash -lc 'cd daemon && bun test && bun run typecheck'
182 pass
0 fail
577 expect() calls
Ran 182 tests across 18 files. [62.48s]
$ bunx tsc --noEmit
aggregate_rc=0
```

The submitted locks are green, but the direct contradictory probe proves that
their success boundary is weaker than the required fail-closed behavior.

## Secret scan

Command:

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"
```

Result: no output; grep exit 1 means no signature hit. `secret-scan: clean`.

## Disposition required

- Use the fail-closed connectivity oracle for `/health`; unknown transport state
  must produce `connected:false`.
- Require explicit `connected:true` in the watchdog MCP probe and add
  fail-before/pass-after fixtures for contradictory and missing connectivity.
- Refresh the aggregate count and rerun independent Tier A review on the
  replacement SHA.
