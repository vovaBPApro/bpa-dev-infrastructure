# Independent review: watchdog A1 startup-wait bound

reviewer: Codex reviewer lane `ag-review-turnend-a1` (independent session; no authorship of reviewed diff)
independence: Independent reviewer worktree and session; reviewed only coder commit `7ab1d525707bb77bf1d3e39207a2d605cb4e0e00`.
tier: Tier A — daemon/orchestrator core and evidence-gate behavior
reviewed-sha: 7ab1d525707bb77bf1d3e39207a2d605cb4e0e00
reviewed-diff: `git diff 7ab1d525707bb77bf1d3e39207a2d605cb4e0e00^ 7ab1d525707bb77bf1d3e39207a2d605cb4e0e00 -- daemon/autonomy-keepalive.ts daemon/autonomy-keepalive.test.ts daemon/server.ts daemon/watchdog-turnend-a1.test.ts`
verdict: ACCEPT

## Manifest consumption check

- review-policy sha256:6537ef28ad14 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- tool-permissions sha256:955630cc416e — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Scope and correctness

- The reviewed commit changes exactly the four assigned daemon paths: `daemon/autonomy-keepalive.ts`, `daemon/autonomy-keepalive.test.ts`, `daemon/server.ts`, and `daemon/watchdog-turnend-a1.test.ts`.
- Startup lane census no longer uses synchronous `Bun.spawnSync`, which blocked the event loop and prevented the stderr readiness reader from progressing. `listSystemLaneUnits()` now awaits an asynchronous child and schedules a 10-second kill. A killed or otherwise non-zero child throws `system lane census failed`; it is not converted to an empty/successful census. Both initial callers retain explicit rejection logging.
- `AutonomyKeepalive` now accepts and awaits an asynchronous census in both event and timer paths. The added unit lock proves the tick remains pending until the census resolves, then completes; existing failure-propagation tests remain intact.
- The harness no longer performs an unbounded health-check fetch inside `waitFor`. Its readiness predicate is synchronous and bounded by the existing 15-second `waitFor`, and the matched `Health:` line is emitted only from the HTTP server listen callback.
- The remaining harness HTTP fetch (`turnEnd`) has `AbortSignal.timeout(5_000)`. Abort rejects the test loudly; it is not caught or treated as success.
- No acceptance assertion was weakened. Under this lane's loopback-denying sandbox, the integration cases failed explicitly at their named 15-second waits rather than hanging or passing. This exercises the relevant failure posture: dropped loopback traffic cannot trap the readiness predicate or the `turnEnd` fetch indefinitely.
- Rollback is a single-commit revert, but would restore the known unbounded startup-health wait and is therefore not recommended.

## Commands and evidence

1. `git rev-parse HEAD` → exit 0, `7ab1d525707bb77bf1d3e39207a2d605cb4e0e00` before review-report authorship.
2. `git diff --name-only HEAD^ HEAD` → exit 0, exactly the four assigned daemon files.
3. `cd daemon && bunx tsc --noEmit` → exit 1 before type analysis: TS2688, local type definitions `bun-types` and `node` are absent. No typecheck success is claimed; dependency installation was outside reviewer authority.
4. `cd daemon && bun test autonomy-keepalive.test.ts` → exit 0: 9 pass, 0 fail, 17 `expect()` calls.
5. `cd daemon && bun test watchdog-turnend-a1.test.ts` → exit 1 in 79.35 seconds: 5 pass / 5 fail. Each loopback-dependent integration test failed loudly at a named 15-second `waitFor` timeout (`watchdog placeholder suppression log`, `watchdog auto-relay`, or `codex watchdog fallback`). The process terminated; there was no unbounded health-fetch hang and no false green. This is consistent with the declared `IPAddressDeny=localhost` constraint. Host evidence supplied for this exact reviewed SHA is 10 pass / 0 fail, 22 expectations, 11.24 seconds.
6. `git diff --check HEAD^ HEAD` → exit 0.
7. Canonical scan: `pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY"); git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"` → grep exit 1, no matches.

## Findings and disposition

No blocking findings. Landing remains fail-closed on the orchestrator's full-suite rerun and normal Tier-A landing evidence. The sandbox integration failure is recorded, not waived or relabeled as green.
