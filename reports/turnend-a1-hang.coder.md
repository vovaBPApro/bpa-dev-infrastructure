# W-34: bound watchdog A1 startup waits (lane `turnend-a1-hang`)

Coder lane `turnend-a1-hang` (branch `ag-turnend-a1-hang`) fixed the
`daemon/watchdog-turnend-a1.test.ts` full-suite hang: harness health waits are
now bounded (`AbortSignal.timeout(5s)` on fetches; listener readiness read
from the daemon's stderr banner instead of an unbounded loopback fetch), so a
dropped-loopback host produces a loud bounded failure (~16s), never a hang and
never a false green.

## Provenance

- Coder terminal report (in-lane): honest NO-GO — the lane sandbox denies
  loopback TCP (`IPAddressDeny=localhost`), so the daemon suite cannot bind
  127.0.0.1 there; the coder's remaining item was "restore loopback; rerun
  both commands". Full text: lane log `lane-turnend-a1-hang.log`.
- Orchestrator host re-verification at the exact SHA (2026-08-01, loopback
  available): the isolated file and the full daemon suite both complete green
  with zero failures; the count is declared in the verify-count field below
  and re-derived by the gate.
- Independent review: ACCEPT, `reports/ag-turnend-a1-hang.review.md`
  (Codex reviewer lane `ag-review-turnend-a1`, review commit `23fc925`).
  Reviewer confirmed the loopback-dependent tests fail loudly at named 15s
  timeouts in the sandbox — bounded failure, no relabeled green.

## Final report

commit: 7ab1d525707bb77bf1d3e39207a2d605cb4e0e00 [CODER] bound watchdog A1 startup waits
verify: cd daemon && set -o pipefail && bun test 2>&1 | sed 's/^[[:space:]]*//'
verify-count: 208/0
result: clean
secret-scan: clean
remaining: none
