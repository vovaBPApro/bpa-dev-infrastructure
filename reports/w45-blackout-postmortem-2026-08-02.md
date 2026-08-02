# W-45 blackout postmortem — commit-history side

Reviewer: Codex session `ag-w45-blackout-postmortem`, independent of the incident-era coder lanes. Tier A because this reviews orchestrator, watchdog, recovery, and evidence-gate behavior. Times below are UTC; host log times were CEST (UTC+2) and are converted explicitly.

## Consumption check

- `review-policy` `sha256:6537ef28ad14` — Review Policy
- `verification-and-locks` `sha256:b6f8862a801d` — Verification and Regression Locks
- `roles` `sha256:cd4c40c4e640` — Roles
- `instruction-layers` `sha256:cd21f4ce0990` — Instruction Layers
- `tool-permissions` `sha256:955630cc416e` — Tool Permissions
- `reproducible-from-git` `sha256:822d9efe694b` — Reproducible From Git

## Verdict and initiating boundary

The first process-level loss that the retained evidence can distinguish is the **top-level orchestrator/dispatcher communication loop**, at about 23:28Z, not the whole host and not all lane processes. Telegram's last delivered bot event is 23:28:42Z. The fleet nudge then observed `running=0 open_rows=1` at 23:29:11Z, but already-dispatched lanes remained capable of work: branches were created at 23:28:38Z and 23:30:09Z and review commits landed at 23:31:14Z (`7ed1356`) and 23:35:56Z (`c3028ab`). No commit, branch creation, or lane-log mtime follows until 07:11Z. This ordering rules out “all processes died at 23:28Z” and shows that the head stopped dispatching before the tail lanes completed.

The exact death cause is **UNMEASURED**. The current boot has no retained journal entries for the incident units, and tracked configuration records timer intent, not historical execution or an exit cause. It would be a false claim to choose crash, provider exit, daemon restart, cgroup cascade, or clean turn-end from these sources. The defensible causal chain is: top-level progress/dispatch stopped; two in-flight reviewers drained; the only recorded nudge neither obtained acknowledgement nor produced a successor wave; then the nudge timer itself left a 7h47m record gap.

## Four safeguards by firing window

| Safeguard | Expected window after 23:28Z | Retained observation | Truthful disposition |
|---|---:|---|---|
| Dispatcher | continuously / when the two remaining reviews terminated | No new lane branch after 23:30:09Z, no commit after 23:35:56Z, and no lane-log mtime until 07:11Z. It did not collect the terminal reviews or dispatch a next wave. | **FAILED:** head stopped first; exact exit cause unmeasured. |
| Fleet nudge | roughly every 10 minutes | It fired once at 23:29:11Z with `running=0 floor=10 open_rows=1`. Its implementation posts a warning, injects text into the same tmux session, has no acknowledgement/progress deadline, and turns tmux set/paste failure into exit 0. No work resulted. The next log record is 07:17:08Z, still `running=0 open_rows=1`; all intervening expected ticks are absent. | **LIED once, then SILENT:** a successful process/heartbeat was not proof of dispatch; timer/liveness execution after that is unmeasured. |
| Keepalive / watchdog | tracked watchdog timer every minute; fleet-liveness timer every minute with a 720s age threshold | No retained incident watchdog/keepalive log and no journal record exists. The fleet-liveness unit was not installed according to the companion process report. The tracked fleet liveness only measures the nudge heartbeat, not semantic progress; the main watchdog's process heartbeat likewise cannot account for finished work. | **UNMEASURED and therefore FAILED:** no durable firing/alarm evidence, and the installed-boundary evidence says the fleet-liveness timer was absent. |
| External hourly ping | approximately 00:28Z, 01:28Z, …, 06:28Z | No independent firing ledger, health inputs, delivery acknowledgement, or alarm record exists. Telegram has no delivery event until recovery. HR-1363 says the old path stopped watching after a false all-clear. | **LIED, then SILENT:** the all-clear lacked semantic-progress evidence; every hourly window is otherwise unmeasured. |

Git and mtime evidence also bounds what the timer logs cannot: the machine and Git storage were alive at least through 23:35:56Z, so the 23:29 nudge did not fail because the entire host had already disappeared. Conversely, a commit proves only that an already-running lane finished; it does not prove that the dispatcher, watchdog, or hourly observer was healthy.

## Minimal mechanism changes

1. **One authoritative durable progress ledger.** Dispatcher intent, worker identity, acknowledgement, fenced lease/generation, semantic artifact, terminal SHA/report, and next-dispatch deadline must be one reconstructible state boundary. A drained wave with open work is immediately RED until a new acknowledged generation exists.
2. **A separately installed and continuously scheduled supervisor.** It reads that authoritative ledger, not tmux text or a self-written heartbeat; retries dispatch boundedly, verifies acknowledgement and a newer semantic generation, and persists every tick/decision. Missing timer, missed tick, unreadable state, and stale progress are `NO-GO`.
3. **A genuinely independent loud alarm path.** After the bounded deadline, enqueue a deduplicated incident outside the watched pane and target cgroup, require delivery acknowledgement, repeat hourly until recovery, and emit recovery closure. “Timer ran”, “HTTP accepted”, and “Telegram delivered” remain separate from progress.
4. **Deployment and incident evidence parity.** Install all tracked units from Git, compare installed copies, retain persistent journal/exit/cgroup identity across reboot, and rehearse killed dispatcher, drained wave, missed timer, daemon restart, delivery failure, and seven-hour accelerated stall from a clean clone.

## v3 coverage and explicit gaps

The `v3` tip `99db22d` materially covers two incident classes. `core/schema.ts` stores fenced owner/token/deadline plus semantic evidence, and the dispatcher consumes fenced transitions. `orchestrator/supervisor.ts` marks a live-PID lane with missing/stale semantic progress `NO-GO`, advances an expired generation, rejects the old owner, and appends an escalation record. Those are real improvements over lane-count and process-heartbeat green.

They do **not** close the blackout:

- **V3-GAP-1 — supervisor wiring/admission:** no tracked v3 unit/timer installs or continuously runs `supervisor.ts`; no clean-clone/deployed proof shows it survives the dispatcher/daemon failure domain. A library test is not an overnight safeguard.
- **V3-GAP-2 — authoritative-state integration:** `runSupervisor()` reads and rewrites a standalone JSON `RecoveryState`, while authoritative mission/lane ownership lives in SQLite `core/schema.ts`. No lock proves the running supervisor consumes the canonical DB without split-brain or lost concurrent updates.
- **V3-GAP-3 — recovery produces work:** stale supervision changes ownership/generation and writes an escalation, but does not invoke a bounded dispatcher/restart broker, require worker acknowledgement, or prove a successor semantic generation. RED is truthful but recovery is absent.
- **V3-GAP-4 — loud independent delivery:** the “independent escalation” test proves only append to a local outbox file. It does not prove an independently powered/credentialed route, delivery acknowledgement, retry-until-recovery, hourly repetition, or recovery notice; same-host total loss remains invisible.
- **V3-GAP-5 — durable cause and missed-tick evidence:** no persistent journal/cause bundle distinguishes provider exit, signal sender, OOM/cgroup, daemon cascade, clean exit, or missed service-manager ticks. The next postmortem would still have to label the initiating cause UNMEASURED.
- **V3-GAP-6 — integrated exact-tip qualification:** v3 reviews accepted narrow recovery behavior, but later reviews rejected container/meteorite claims for unmeasured gates; therefore the integrated unattended chain has no clean meteorite/admission evidence at `99db22d`.

## Review record

Reviewed SHA: `f866b0ef96168ff887a7992fd82fcb46b8b237e7` plus all refs/reflogs for the incident window and v3 tip `99db22d`. Inspected the two supplied reports, tracked nudge/watchdog scripts and unit templates, `/root/.cache/infra-lanes/fleet-nudge.log`, lane-log mtimes, Git graph/reflogs, current journal availability, and v3 state/dispatcher/supervisor sources and review records. Rollback posture: report-only; no runtime state or mechanism changed. Verdict: **NO-GO** for claiming an exact initiating exit cause or an unattended-safe v3; the ordering and uncovered gaps above are supported and rerunnable.

commit: f7ca2177cb89e28cd53d6d2cb4c787bd6bb91d73 [REVIEW] record W-45 blackout commit-side postmortem
verify: git rev-parse HEAD && git diff HEAD^ --check && test "$(git diff-tree --no-commit-id --name-only -r HEAD)" = orchestrator/runtime/reports/w45-blackout-postmortem.report.md && git log --all --since='2026-08-01T23:20:00Z' --until='2026-08-02T07:20:00Z' --date=iso-strict --pretty=format:'%H %ad %D %s' && git reflog --all --date=iso-strict | rg '2026-08-02T0(1|9):' && tail -40 /root/.cache/infra-lanes/fleet-nudge.log && find /root/.cache/infra-lanes -maxdepth 1 -name 'lane-*.log' -type f -newermt '2026-08-01 23:20:00 UTC' ! -newermt '2026-08-02 07:20:00 UTC' -printf '%TY-%Tm-%TdT%TH:%TM:%TS %f\n' | sort && git grep -n -E 'stale-semantic-progress|fencingToken|semanticProgress' v3 -- core orchestrator
result: NO-GO
secret-scan: clean
remaining: V3-GAP-1 through V3-GAP-6 require implementation, Tier-A review, deployed clean-clone rehearsal, and an acknowledged independent alarm
