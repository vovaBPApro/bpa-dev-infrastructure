The control-plane loop works end-to-end. The successful lane landed and pushed only to the fake bare origin; all five requested failure paths aborted before changing `main`.

Throwaway environment: `/tmp/e2e-j8FJ4k`  
Real repository remained read-only and clean at `165ab393e8f5231314324a8527862e51c7e3c108`.

### Execution ledger

| Step | Command | Result | Real evidence |
|---|---|---:|---|
| Isolation | `git clone … /tmp/e2e-j8FJ4k/work`; `git clone --bare … fake-origin.git`; `remote set-url` | PASS | Both `origin` URLs became `/tmp/e2e-j8FJ4k/fake-origin.git`; initial local/remote SHA matched. |
| Compose files | `bun tools/instructions/compose.ts --role coder --out …/pack` | PASS, rc 0 | Created `manifest.json`, `preamble.md`, and `context/*.md`. |
| Compose marker/facts | `bun … compose.ts --role coder --assert-budget 600` | PASS, rc 0 | Marker: `<!-- compose.ts pack v1 role=coder l1=165ab393 -->`; `## INSTANCE FACTS` present; 411 lines. |
| Dispatch valid | `bun tools/instructions/dispatch-check.ts coder-pack.md` | PASS, rc 0 | `dispatch-check: OK (compose marker present)`. |
| Dispatch markerless | `bun … dispatch-check.ts markerless.md` | PASS, expected rc 3 | `dispatch-check: REFUSED — prompt lacks the compose.ts pack marker`. |
| Synthetic coder lane | Commit on `ag-e2e-success` | PASS | Coder SHA `0e6a3da73b1c80e2c227ddd46044132ae94f4e48`; canonical scan had zero hits. |
| Terminal report | Required five-field report | PASS | Exact SHA, runnable verifier, `result: clean`, `secret-scan: clean`, `remaining: none`. |
| Review artifact | Exact-SHA independent `ACCEPT` | PASS | Included reviewer, `reviewed-sha`, independence, tier, commands, findings, and verdict. |
| Pre-merge verifier negative check | First landing with a worktree-only verifier | PASS, expected abort | `FAIL verify-run … No such file or directory`; `LAND verdict=aborted`. This correctly proved verification occurs on checked-out `main` before merge. |
| Successful landing | `gate/land.sh … --run-verify` | PASS, rc 0 | Every gate stage passed; fake-origin push shown as `165ab393..08fe9e4f main -> main`. |
| Landing result | Post-merge/reap checks | PASS | `LAND verdict=landed sha=08fe9e4f… review=accepted`; lane branch deleted; merged file check green; local/fake-remote `main` equal. |
| Stale review SHA | Landing with mismatched `reviewed-sha` | PASS, expected abort rc 2 | `ERROR review-required stale-artifact reviewed-sha-mismatch`; `sha=none`; branch retained. |
| Missing review | Review-required change with no artifact | PASS, expected abort rc 2 | `ERROR review-required missing-artifact`; `LAND verdict=aborted sha=none`. |
| Declared NO-GO | Report containing `result: NO-GO` | PASS, expected abort rc 2 | `GUARD verdict=no-go`; `LAND verdict=aborted sha=none`. |
| Bad report SHA | Report with all-zero SHA | PASS, expected abort rc 2 | `FAIL commit-exists 000…000`; `GUARD verdict=violation`. |
| Secret in diff | Synthetic GitHub-PAT-shaped detector token (`gh`+`p_`…, sanitized for archive) | PASS, expected abort rc 2 | `LAND secret-scan match file=e2e-secret.txt lines=1`; secret-scan stage failed. |
| Failure isolation | Check after every abort | PASS | Each rejected branch remained available; `main` continued to equal fake `origin/main`. |
| Session load, no handoff | `bun tools/instructions/session-load.ts` | PASS, rc 0 | Handoff section emitted `WARNING: no handoff found — degraded start`. |
| Handoff write | `bun tools/instructions/handoff.ts write …` | PASS, rc 0 | Wrote `orchestrator/runtime/handoffs/2026-07-29T09-03-23Z-auditor-a-to-auditor-b.json`. |
| Fresh handoff | `handoff.ts validate … --now-ms <fresh>` | PASS, rc 0 | `schema valid, fresh (age 22902ms)`. |
| Stale handoff | Same file at +31 minutes | PASS, expected rc 1 | `handoff is stale: age 1882902ms exceeds 1800000ms`. |
| Session load, handoff present | `bun tools/instructions/session-load.ts` | PASS | Latest-handoff section named and embedded the generated JSON. |
| SessionStart hook | `bash .claude/hooks/session-load.sh` | PASS, rc 0 | Emitted 8,506-byte JSON payload beginning with `hookEventName":"SessionStart"`. |

### Five documentation command checks

1. `git rev-parse HEAD` — PASS, rc 0; returned fake-landed SHA `08fe9e4f…`.
2. `git status --short` — PASS, rc 0; zero lines.
3. Canonical `pat=…; git diff origin/main...HEAD | grep …` scan — PASS; no output, grep rc 1 as expected for no matches.
4. `bun tools/instructions/session-load.ts` — PASS, rc 0; emitted `# SessionStart Load (orchestrator)`.
5. `bun tools/instructions/handoff.ts validate …` — PASS, rc 0; reported schema-valid and fresh.

Steps contradicting documentation or prior claims: **none**.

One shell portability observation: this host’s `date +%s%3N` produced seconds concatenated with nine nanosecond digits, not epoch milliseconds. Using `bun -e 'process.stdout.write(String(Date.now()))'` supplied the documented epoch-ms value correctly. The repository documentation does not prescribe the problematic `date` command.

Verdict: **YES — the loop actually works end-to-end, fake-origin push and cleanup succeed, and every requested failure path aborts without advancing `main`.**

```text
commit: 165ab393e8f5231314324a8527862e51c7e3c108 [real repository audited read-only]
verify: test "$(git -C /tmp/e2e-j8FJ4k/work rev-parse main)" = "$(git -C /tmp/e2e-j8FJ4k/work rev-parse origin/main)" && grep -q 'LAND verdict=landed' /tmp/e2e-j8FJ4k/land-success-2.out && grep -q 'LAND verdict=aborted' /tmp/e2e-j8FJ4k/fail-{stale,no-review,no-go,bad-sha,secret}.out
result: clean
secret-scan: clean
remaining: none
```
