# ML-12 watchdog escalation ladder — coder terminal report

## Instruction consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- repository-hygiene sha256:5af8b90e93df — Repository Hygiene
- isolated-test-environments sha256:d0c2162eeba5 — Isolated Test Environments
- operator-feedback sha256:82d309b667eb — Operator Feedback
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- branching-policy sha256:dbe7ace1193b — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Scope and result

The daemon watchdog now stays passive without an active task, derives a stable
progress signature from pane, Git, and task state, resets on any changed signal,
nudges on the first two frozen ticks, and escalates on the third. Alert identity
is the alert class plus frozen signature, so an unchanged incident is suppressed
while a new failure signature re-arms delivery. The six watchdog alert classes
are explicit and the existing ML-1 terminal failure classifier remains unchanged.

## Regression evidence

RED baseline (`origin/main`): `evaluateStall` alerts immediately on the first
stale tick, has no explicit `HAS_TASK` input, and exports neither
`buildProgressSignature` nor `WATCHDOG_ALERT_CLASSES`.

GREEN merged-tree command:

```sh
cd daemon && bun install --frozen-lockfile && ORCH_WHISPER_PREFIX=/nonexistent bun test && bunx tsc --noEmit
```

Result: exit 0. MERGED-tree daemon totals: 182 pass, 0 fail, 1 named skip
(real Whisper engine unavailable under the deliberately nonexistent test prefix).

Secret scan:

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
git diff origin/main | LC_ALL=C grep -aE "$pat"
```

Result: no matches (`secret-scan: clean`).
