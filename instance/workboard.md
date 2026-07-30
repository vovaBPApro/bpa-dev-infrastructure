---
id: workboard
layer: L1
status: informational
audience: orchestrator
tags: [instance]
summary: Open tracked work rows for this installation — every known-open item has exactly one row here until it lands or is explicitly dropped.
---

# Workboard — open tracked rows

One row per open item. A row leaves this file only by landing (record the SHA
in the row, then delete it next pass) or by an explicit dropped-with-reason
note. Derived-work items live here; Human directives stay in
`instance/decisions/` and are only referenced.

## Open

- **W-08 — memory-sweep defect triage**: live sweep + triage DONE (proposal at
  `.cache/infra-lanes/diag/ag-memory-sweep-triage.report.md`: 38 memory entries
  + 3 oversized `.mdc` rules files). APPLICATION pending — adding `home:` anchors
  / demoting rules bodies is deliberate judgment work (several entries concern
  dead bpa-master rails); to be done by the NEW orchestrator post-cutover.
  (Sweep tool landed 05689cdd; daily timer installer exists, not yet installed.)
- **W-10 — install memory-sweep daily timer** on the host once W-08 triage
  is done (orchestrator/install-memory-sweep.sh).

### New-infra queue (post-cutover, from the Human 2026-07-30)

Build on the NEW orchestrator, planned WITH the Human there. Verbatim seed:
`instance/decisions/HR-11736.md`.
- **NI-1 — team personas**: give "characters"/personas to the whole 10-agent team.
- **NI-2 — Google Drive debug access**: proper GDrive file access for debugging.
- **NI-3 — local Whisper voice transcription**: local Whisper model to transcribe
  Telegram voice messages; needs testing + RAM measurement (251 GB headroom).

## Deep consilium residuals (2026-07-29)

Source: `migration-prep/DEEP_CONSILIUM_AUDIT_2026-07-29.md` (4 Codex auditors).
The CRITICAL/HIGH findings already LANDED: /status honesty (running_agents vs
lane_worktrees, git timeout) `7fe97222`; gate provenance 7 fixes incl.
self-review reviewer!=author + partial-identity + NUL-byte `b3a42d14`; dispatch
marker/override 3 fixes `c1ad0c7e`; flaky lease-race test `d1b64754`. These rows
were the remaining MEDIUM/LOW.

This audit is now FULLY CLOSED. All residuals landed (all review=accepted,
cross-vendor Claude Sonnet): W-07 batch --skip-review test coverage `274672f`;
W-09 handoff future-ts guard `e1af73c`; W-11 gate secret-scan decoded-match
lock `e172ff6` (base64-decode detection already shipped in `77f3fa9f`; entropy
excluded as too false-positive-prone; split-string documented as the residual
boundary); W-12 gate reviewer-identity hardening `1c920ba`; W-13 /status
process-local honesty relabel `fa2a974`.

## Parked (needs Human go or a phase flip)

- **P-01 — VM migration to the 64 GB machine** (`instance/migration-day.md`)
  — parked by HR-11570 («Поки роби лише 1») until Vova's go.
- **P-02 — stack Phase-0 spike with go/no-go numbers**
  (`migration-prep/STACK_CONSILIUM_FINAL.md`) — parked by HR-11570.
- **P-03 — daemon cutover to this repo's daemon/** (flips
  `capture.mode: manual → daemon` in `instance/params.yaml`; inbox ledger
  check then fail-closes) — needs the migration/cutover moment.
