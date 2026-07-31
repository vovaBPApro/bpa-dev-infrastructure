# Unit drift reconciliation

Date: 2026-07-31

## Eight divergences and disposition

| Unit | Initial divergence | Disposition |
| --- | --- | --- |
| `bpa-full-suite.service` | Missing | Installed from its tracked template; now byte-matches and its executable exists. |
| `bpa-full-suite.timer` | Missing | Installed from its tracked template; now byte-matches. |
| `bpa-orchestrator-watchdog.service` | Missing | Deliberately remains uninstalled because unattended lease-loss handling is not approved. The installer skips it. |
| `bpa-orchestrator-watchdog.timer` | Missing | Deliberately remains uninstalled for the same hazard. Legacy `--arm-watchdog` now fails instead of reviving it. |
| `orch-morning-report.service` | Missing | Installed from its tracked template; now byte-matches and its executable exists. |
| `orch-morning-report.timer` | Missing | Installed from its tracked template; now byte-matches. |
| `bpa-orchestrator.service` | Content drift | Template reconciled to the deployed config path, PATH, and hardening boundary; deployed file refreshed without restarting the inactive service. |
| `bpa-telegram-daemon.service` | Content drift | Template reconciled to the deployed Bun, config, state-directory, PATH, and hardening boundary; deployed file refreshed without restarting the active daemon. |

The retired `/root/bpa-dev-infrastructure/.env` and `/root/.bun/bin/bun` defaults
were replaced with the verified live paths `/root/.config/bpa/orchestrator.env`
and `/usr/local/bin/bun`. Every rendered absolute environment, working-directory,
and executable path was checked on the host. The deployed drift result is six
`MATCH` rows and two evidence-bearing watchdog `EXEMPT` rows.

## Fail-before / pass-after lock

`bootstrap/bootstrap.test.sh` removes a tracked daemon restart boundary and
proves drift detection fails. It also points the checker at an empty template
directory and records `FAIL-BEFORE empty unit template inventory`; the checker
now exits 2 with `ERROR: no unit templates found` instead of returning a false
green. The same suite proves undocumented missing units fail, while only a
well-formed evidence-bearing deliberate-absence row is exempt.

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
