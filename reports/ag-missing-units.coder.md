# Missing system units investigation

Date: 2026-07-31
Host observation: all six named units were absent from `/etc/systemd/system` before this mission.

## Judgement before installation

| Unit | Purpose | Host judgement | Evidence |
| --- | --- | --- | --- |
| `bpa-orchestrator-watchdog.service` | Runs one fenced liveness/supervision tick. | Keep installed state deliberately absent and do not arm without the operator present. | `e415cdd` added guarded re-acquire and no-kill ambiguous-state locks; `ab1ea66` made arming explicit; the mission records the operator-presence boundary. |
| `bpa-orchestrator-watchdog.timer` | Schedules the watchdog tick every `ORCH_WATCHDOG_INTERVAL`. | Deliberately absent for this mission. | Same evidence as the service; arming is explicitly outside this lane's authority. |
| `bpa-full-suite.service` | Runs every discovered shell and Bun test suite with a bounded timeout and durable summary. | Safe and wanted; install and enable. | Bootstrap's standing activation contract enables it; independent Tier-A review `fd8ac29` ran the suite with live `ORCH_*` pointers and proved live lock, lease, and heartbeat bytes unchanged. |
| `bpa-full-suite.timer` | Schedules the full suite at 03:30 daily. | Safe and wanted; install and enable. | `bootstrap/install.sh` activation contract and the same isolation review. |
| `orch-morning-report.service` | Produces the morning readiness report. | Safe and wanted; install and enable. | `operator-feedback` requires the morning readiness rhythm; `89c4963` landed the timer and `1587501` made publication recovery idempotent. |
| `orch-morning-report.timer` | Schedules the report at 07:40 Europe/Warsaw. | Safe and wanted; install and enable. | Same standing instruction and history as the service. |

## Watchdog prerequisite

The kill-on-self-expiry defect is fixed in tracked code: `e415cdd` re-acquires an expired, uncontested lease with a newer fencing token, kills only for displacement by a verifiably live different owner, and fails closed without killing for dead-holder or unreadable-state ambiguity. `orchestrator/watchdog-lease-guard.test.sh` is the regression lock. The work therefore already landed, but the timer must still remain unarmed until the operator is present for an observed arm/smoke cycle and confirms the live session, lease renewal across consecutive ticks, and no-kill behavior.

## Mailbox and workboard evidence

`/root/orch-mailbox/live-daemon-src/orchestrator-watchdog.sh` documents the prior conservative live-session restart guards. `instance/workboard.md` records ML-3's stale-heartbeat kill hazard and the watchdog restore lane. No mailbox record authorizes unattended arming. The full-suite isolation review is retained in `reports/ag-ml4-health-honest.review.md`.

## Host action and residual drift

After this report existed, the full-suite and morning-report pairs were rendered from the tracked templates, installed in `/etc/systemd/system`, enabled, and observed `active (waiting)`. The watchdog pair was not installed or enabled. The drift check now reports four `MATCH` rows and two explicit watchdog `EXEMPT` rows.

The merged-tree total is still not green: the two pre-existing content divergences remain on `bpa-orchestrator.service` and `bpa-telegram-daemon.service`. They change environment-file and hardening boundaries on live operator services, so this lane did not overwrite them without a separate reconciliation and restart proof. This is a concrete `NO-GO` for the all-unit drift gate, not an undocumented exemption.

## Manifest consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:f2af762572ae — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git
