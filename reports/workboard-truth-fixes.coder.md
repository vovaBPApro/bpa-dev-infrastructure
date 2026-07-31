# Workboard Truth Fixes — Coder Terminal Report

## Consumption check

- lane-lifecycle sha256:84d3db25d785 (baseline) # Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 (baseline) # Verification and Regression Locks
- tool-permissions sha256:955630cc416e (baseline) # Tool Permissions
- repository-hygiene sha256:02acdffe2a56 (baseline) # Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 (baseline) # Isolated Test Environments
- operator-feedback sha256:f2af762572ae (baseline) # Operator Feedback
- instruction-layers sha256:cd21f4ce0990 (baseline) # Instruction Layers
- branching-policy sha256:98cd92116325 (baseline) # Branching Policy
- reproducible-from-git sha256:822d9efe694b (baseline) # Reproducible From Git

## Outcome

Implementation commit `9f697efb0320e54c31d00395087057fea46321fb` rejects
lowercase and otherwise malformed row-like IDs instead of silently
undercounting them. Runtime parse failures notify the operator and remain
non-zero. The HR-281 below-three-lanes notification is executable, and failed
notification delivery exits non-zero before the tmux nudge.

The enabled timer executes `/root/.local/bin/orch-fleet-nudge.sh`. Its deployed
SHA-256 and the tracked script SHA-256 both equal
`b8a41d94dab8f0adcaf72cd70aef9cf8447b14d8da18ea76a4a84d53d1951d9d`.
The timer was enabled, active, and waiting after deployment verification.

Independent review ACCEPT is retained in
`reports/workboard-truth-fixes.review.md` by review commit
`d1f32293321665af150e854eaabab2c058bc6207`.

## Regression evidence

The pre-fix implementation at `3655d61` returned count `1` and exit `0` for a
fixture containing valid `W-1` plus malformed lowercase `w-2`. The repaired
shell lock rejects that fixture, verifies parse-error notification, proves the
HR-281 notification branch executes, makes a notification failure exit `3`,
and deliberately detects a modified deployed copy.

Verification command:

```sh
bash orchestrator/fleet/fleet-nudge.test.sh && bun test && orchestrator/fleet/fleet-nudge.sh --verify-deployed /root/.local/bin/orch-fleet-nudge.sh
```

Canonical secret scan used the pattern extracted at runtime from
`/root/bpa-dev-infrastructure/gate/land-lib.sh` and found no hit.

```text
result: clean
secret-scan: clean
remaining: none
```
