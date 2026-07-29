| Field / behavior | Verdict | Evidence | Fix |
|---|---|---|---|
| `agents_active` / `agents` meaning | **LIES/CAN-LIE** | Counts registered worktrees under `/home/bpa-shell/.cache/infra-lanes/` with `ag-*` branches. It does not inspect role or process liveness. Review/docs/consilium lanes count as agents; dead retained worktrees also count. | Label `lane_worktrees`, or combine lane metadata plus PID/lease/heartbeat and report counts by role/state. |
| Current-host agent count | **LIES** | Real `git worktree list --porcelain` contains only main, so builder prints `agents_active: 0 (verified)` and `agents: 0 (verified, no lane worktrees)`. At the same time, `ps` showed at least four active consilium Codex agent processes plus the orchestrator—all running from the main checkout rather than lane worktrees. | Do not equate lane worktrees with running agents. Show separate `lane_worktrees` and `running_agent_processes`/lease-backed agents. |
| “verified” qualifier | **CAN-LIE** | “Verified” means only that `git worktree list` succeeded. It does not verify that counted lanes are alive or that non-worktree agents do not exist. | Say `worktree query verified`, not `agents verified`. |
| Zero versus unknown | **HONEST, narrowly** | Successful empty query produces `agents: 0 (verified, no lane worktrees)`; failed query produces `agents: unknown (git worktree list failed…)`. Tests lock this distinction. | Preserve the distinction, but rename the measured object. |
| Git failure | **HONEST** | Failed runner returns `unknown`, never fabricated zero. Unit test covers it. | Add the stderr/exit category without leaking sensitive paths. |
| Git slowdown/hang | **LIES/CAN-LIE** | `shSync` uses synchronous `Bun.spawnSync` with no timeout. A simulated 1.2-second runner blocked for 1.22 seconds. A hung Git process can hang `/status` and the daemon event loop indefinitely. Each lane adds another synchronous `rev-list`. | Use asynchronous spawning with a hard deadline; on timeout report `lane_worktrees: unknown (git timeout)`. |
| Per-lane ahead count | **HONEST** | Successful `rev-list` becomes `+N`; failure/non-numeric output becomes `ahead=n/a`. | Add timeout and use a safely parameterized spawn rather than shell interpolation. |
| `plan` | **CAN-LIE** | Reads legacy `~/.claude/orchestrator-state.json` with no freshness check. Absent on this host, so current output is honestly `n/a`; if stale, it is presented as current. | Include state timestamp/age and mark stale data explicitly. |
| `context` | **CAN-LIE** | Same stale legacy state file and no age validation. | Derive from current runtime or show timestamp and stale status. |
| `providers_active` | **LIES/CAN-LIE** | Reads the legacy state file; missing provider keys are fabricated as `0`. A stale file is presented as current. | Missing keys must be `unknown`; require fresh lease/process evidence. |
| `vendor_quota` | **CAN-LIE** | Legacy state file, no freshness validation. Missing file is honestly `n/a` on this host. | Add source timestamp and expiry or query the authoritative quota source. |
| `vendor_override` | **CAN-LIE** | Missing/invalid field is rendered `auto (no override recorded)`. Absence proves only “not recorded,” not that runtime selection is actually automatic. | Render `unknown (no override recorded)`. |
| `instance` | **LIES/CAN-LIE** | A lock containing a numeric PID is labeled `running`; there is no `kill(pid, 0)`, start-time identity, or tmux/process verification. Additionally, lock selection uses `TELEGRAM_CHAT_ID`, not the newer bound-chat setting. | Probe PID identity/start time and use the canonical bound chat ID. Mark stale locks. |
| `binding` | **CAN-LIE** | Comes from in-memory/persisted binding, with no session-liveness proof. The direct `bot.command('status')` path does not refresh it via `currentBinding()`. | Refresh and validate binding during every status request. |
| `mission` | **CAN-LIE** | Reads `~/.claude/orchestrator-missions.json` without freshness or active-session correlation. It is absent here and honestly reports `n/a`. | Validate mission age, terminal state, and matching live binding. |
| `last_relay` | **CAN-LIE** | Process-local last attempted relay outcome; it is not durable and “deliver” does not prove Human receipt. | Label it `last_relay_attempt`, include timestamp and acknowledgement state. |
| `last_progress` | **CAN-LIE** | Process-local pane/git observation timestamps reset on daemon restart and do not prove useful agent progress. | Label as observations and include restart epoch/source. |
| Daemon `daemon`, `pid` | **HONEST** | If `/status` responds, that process is running and `process.pid` is real. | No change. |
| Daemon `bot` | **CAN-LIE** | Cached username proves prior bot identity, not current Telegram connectivity. | Report Telegram API probe status and timestamp separately. |
| `claude_connected` | **CAN-LIE** | Merely tests `activeServer !== null`; nearby code explicitly handles stale/zombie SSE connections elsewhere. | Use the existing connection-liveness check and show last successful traffic. |
| `tmux_alive` | **HONEST but blocking** | Fresh `tmux has-session` probe, but synchronous and without timeout. | Apply a deadline and report timeout as unknown. |
| `buffered_msgs` | **HONEST, process-local** | Exact in-memory queue length, but disappears on daemon restart and silently drops oldest beyond 200. | Label `in_memory_buffer`; expose dropped count and durability status. |
| Status regression tests | **HONEST but incomplete** | `bun test status.test.ts inbox-mirror.test.ts`: **22 pass, 0 fail**. Tests prove fixture worktree counting and failure wording, but mock the shell and do not test real processes, non-coder lanes, stale worktrees, or timeouts. | Add integration tests for role confusion, dead worktrees, non-worktree processes, stale state, and timeout behavior. |
| Inbox append-only behavior | **HONEST** | Uses `appendFileSync`; tests prove prior content remains a strict prefix and repeated calls append rows. | Consider explicit restrictive file/directory modes and multi-writer testing. |
| JSONL injection | **HONEST** | Attack text containing newlines, CRLF, quotes, and a serialized fake row produced exactly two valid physical rows for two calls; IDs remained `[1,2]`, and attack text round-tripped only inside `text`. | No serialization fix needed. |
| Mirror failure versus delivery | **HONEST** | Caller wraps `appendInboxLine` in an isolated `try/catch`, then proceeds to typing/reaction/download/delivery logic. A write exception does not abort message delivery. | Add an integration test that forces append failure and asserts forwarding still occurs. |
| Telegram-token leakage | **HONEST with caveat** | Serializer whitelists only `msg_id`, `chat_id`, `ts`, and `text`; extra `token`/environment properties were excluded in tests and experiment. The daemon token is never passed. However, raw Human text is stored verbatim, so a token manually pasted into chat would be persisted. | Redact known credential patterns or explicitly document that inbound text must not contain secrets. |
| Mirror live status | **HONESTLY NOT PROVEN** | `capture.mode: manual`; instructions prohibit claiming live capture. No daemon systemd unit was found and `instance/decisions/inbox.jsonl` is absent on this host. Code is wired, but there is no live evidence. | Keep manual capture until an actual inbound canary proves the configured daemon writes the intended file, then deliberately flip the mode. |

Current builder output on this host includes:

```text
agents_active: 0 (verified)
agents: 0 (verified, no lane worktrees)
```

That matches the worktree registry but not the actual running consilium agents. Therefore `/status` is not trustworthy as an agent/coder status display on this host.

```text
commit: 165ab393e8f5231314324a8527862e51c7e3c108 main
verify: cd /home/bpa-shell/bpa-dev-infrastructure/daemon && bun test status.test.ts inbox-mirror.test.ts
result: NO-GO — /status reports zero verified agents while multiple agent processes are running outside ag-* worktrees
secret-scan: clean
remaining: separate registered lane worktrees from live role-aware agent counts; add nonblocking Git timeouts and freshness/liveness checks
```

Verdict: `/status` is still untrustworthy on this host; the inbox mirror resisted JSONL injection and does not automatically leak the Telegram token, but raw pasted secrets remain a content risk and the mirror is not proven live.
