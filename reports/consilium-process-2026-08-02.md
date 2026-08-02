# Consilium process lens — HR-1363

## Consumption check

- `review-policy` `sha256:6537ef28ad14` — Review Policy
- `verification-and-locks` `sha256:07e760358365` — Verification and Regression Locks
- `roles` `sha256:cd4c40c4e640` — Roles
- `instruction-layers` `sha256:cd21f4ce0990` — Instruction Layers
- `tool-permissions` `sha256:955630cc416e` — Tool Permissions
- `reproducible-from-git` `sha256:822d9efe694b` — Reproducible From Git

## Verdict

1. Yes: attempt #1 failed at the process boundary; outstanding work repeatedly had zero lanes, and the second night then had a 7h47m nudge blackout.
2. Use a defined hybrid: retain donor/product evidence and independently proven mechanisms, but discard attempt #1's execution plan, mission state, and unsupported green claims.
3. Attempt #2 needs durable semantic-progress leases, an independent supervisor with bounded recovery, and a separate loud delivery path; tmux text injection is not recovery.
4. A status ping may be green only from fresh terminal evidence (new commit/evidence row or explicitly healthy long-running check), never from timer/service health or Telegram delivery.
5. Do not start the overnight run until W-37 is landed/deployed, W-31 and W-38 receive Tier-A review plus announced rehearsal, and tracked liveness units match the host.

## Evidence

### The standstill was real

`/root/.cache/infra-lanes/fleet-nudge.log` records `running=0` with work outstanding throughout both failures. On the first night, it fired every ~10 minutes with 30–33 open rows and frequently zero lanes from 00:22 through 06:44 CEST; from 04:44 through 05:54 every recorded sample was zero. Repeated nudges therefore did not cause durable recovery.

On the second night the same log records zero lanes and one open row at 21:08, 01:19, 01:21, and 01:29 CEST, followed by no record until 09:17 CEST: a 7h47m gap. The absence is not evidence of progress: at the first resumed tick the fleet was still `running=0 open_rows=1`. Lane-log mtimes likewise provide no terminal lane evidence within that blackout; work resumes only in the morning.

Telegram history `/root/.cache/infra-lanes/data-hist/messages-2026-08.jsonl` has an 7h41m communication gap from the delivered 01:28:42 CEST message to inbound messages at 09:09/09:10 CEST. Its outbound records contain only `outcome:"delivered"`, length, and content hash. That proves transport delivery, not that work advanced, and cannot justify an all-clear. The repeated 123-byte same-hash messages later in the morning demonstrate that a successfully delivered periodic ping can remain content-identical while `fleet-nudge.log` continues to say `running=0`.

### Why the safeguards did not safeguard

`orchestrator/fleet/fleet-nudge.sh` counts running `lane-*` services and open workboard rows every ten minutes, but its recovery action is only `tmux paste-buffer` plus `send-keys Enter`. It has no acknowledgement, generation/cursor, retry budget, progress deadline, or escalation when the pasted instruction is ignored. It even exits successfully when the tmux paste fails (`|| exit 0`), creating a false green. Its heartbeat records process exit status, not fleet progress.

`orchestrator/fleet/fleet-nudge-liveness.sh` supervises only the age of that heartbeat. Thus a watchdog that wakes every ten minutes while accomplishing nothing is declared live. The tracked liveness timer promises a one-minute check and a 12m05s stale-heartbeat alert, but `systemctl list-timers --all 'orch-fleet*'` on the reviewed host lists only `orch-fleet-nudge.timer`; `systemctl status orch-fleet-nudge-liveness.timer` says the unit is not found. This is tracked/runtime drift and fails the meteorite and clean-report bars.

The workboard gives the coupled failure chain. W-31 records that daemon restart killed the orchestrator and left the fleet headless, with survival rehearsal still blocked. W-33 records repeated self-echo alert storms and session deaths. W-37 records the circular topology in which alerts are injected into the pane being watched and says the watcher remains off pending a reviewed/deployed fix. W-38 says fail-closed recovery code exists only as a coder correction awaiting mandatory Tier-A review and a shared-host rehearsal. These are open prerequisites, not production evidence.

### Minimal process for attempt #2

1. **Durable semantic progress record.** Every mission has owner, generation, state, last terminal artifact SHA/evidence path, and a deadline. “Progress” means a changed durable artifact or an explicitly declared healthy long-running check; lane count, session existence, heartbeat, and message delivery never reset it.
2. **Independent supervisor.** A system unit outside the daemon/orchestrator cgroups evaluates that record at a short cadence. Below-floor work triggers dispatch/recovery and requires acknowledgement plus a newer generation by a bounded deadline. Failed launch retries on the next tick; repeated failure escalates rather than cooling down as success.
3. **LOUD independent escalation.** After bounded retries or a semantic-progress timeout, notify the Human through a path that does not traverse the watched orchestrator pane. Require delivery success, deduplicate by incident id, repeat on a bounded cadence until recovery, and send a recovery notice. Never send an all-clear without fresh evidence.
4. **Safe recovery topology.** Land and deploy W-37 first to remove alert self-injection; independently review and rehearse W-31 session isolation and W-38 recovery. Daemon restarts must not kill the orchestrator; watchdog recovery must not kill a healthy live session.
5. **Deployment parity gate.** Before an overnight run, compare every tracked unit/script/config with the installed copy, prove timers have a finite next trigger, execute failure/recovery drills, and retain the journal plus teardown evidence. Missing liveness timer or blocked rehearsal is `NO-GO`.
6. **Overnight admission and morning accounting.** Admit only bounded missions with acceptance locks and enough ready work for the lane budget; cap parallelism at useful independent work rather than blindly targeting ten. Morning report reconciles planned rows one-to-one with terminal SHAs, reviews, failures, retries, and alert deliveries.

## Review disposition

`NO-GO` for an unattended attempt #2 tonight: W-37 is not proven landed/deployed, W-31/W-38 lack the required completed Tier-A/runtime evidence, the liveness timer is absent on the host, and neither current watchdog measures semantic progress. The next bounded action is to land/deploy W-37, then independently review and conduct one announced W-31/W-38 recovery rehearsal with installed-unit parity evidence.

commit: d7ca47c301419c6643cb78c92d6475a4dce6dfe0 consilium-process consilium opinion
verify: git rev-parse HEAD; git status --short; tail -120 /root/.cache/infra-lanes/fleet-nudge.log; jq -r 'select(.ts >= "2026-08-01T20:00:00Z" and .ts < "2026-08-02T10:00:00Z") | [.ts,.direction,.outcome,(.message_id//"-"),.kind,.content_length,.content_sha256] | @tsv' /root/.cache/infra-lanes/data-hist/messages-2026-08.jsonl; find /root/.cache/infra-lanes -maxdepth 1 -type f -name 'lane-*.log' -newermt '2026-08-01 20:00:00' ! -newermt '2026-08-02 09:30:00' -printf '%TY-%Tm-%Td %TH:%TM:%TS %p\n' | sort; sed -n '1,240p' orchestrator/fleet/fleet-nudge.sh; sed -n '1,240p' orchestrator/fleet/fleet-nudge-liveness.sh; systemctl list-timers --all 'orch-fleet*' --no-pager; systemctl status orch-fleet-nudge.timer orch-fleet-nudge-liveness.timer --no-pager; rg -n 'W-(31|33|37|38)' instance/workboard.md
result: NO-GO
secret-scan: clean
remaining: none
