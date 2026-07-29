| Attack | Actual result | Severity | Concrete fix |
|---|---|---:|---|
| Different existing `reviewed-sha` | Refused at review gate | none | Retain test. |
| Two verdicts: `ACCEPT` then `REJECT` | Refused at review gate | none | Retain test. |
| CRLF artifact fields | Landed; CRLF was accepted | low | If strict artifact canonicalization is required, reject CRLF; otherwise document it as accepted normalization. |
| Unicode look-alike reviewer | Landed | high | Authenticate/reconcile reviewer identity against an independent review record; do not treat arbitrary free text as provenance. |
| `reviewer: Author <author@example.test>` while branch is `ag-self` | Landed, including via `land-batch.sh` | critical | Compare against commit author identity and require an independently authenticated reviewer/session, not merely `reviewer != branch`. |
| `--skip-review '   '` | Landed with `review=skipped` | high | Require `[[ -n "${reason//[[:space:]]/}" ]]` before recording/accepting a skip. |
| Review artifact symlink | Landed | high | Reject symlinks (`test ! -L`) and require a regular file located beneath a controlled report directory. |
| `./gate/x` and `gate//x` | Refused: Git canonicalized to `gate/x`, which matched policy | none | Retain tests. |
| `Gate/x` and `x/gate/x` | Landed without review | low / policy gap | On Linux these are distinct paths, not a literal prefix bypass. If the intent is semantic/case-insensitive coverage, canonicalize and enforce explicit path policy. |
| Forged marker `<!-- compose.ts pack v1 forged -->` | `dispatch-check` exited 0 | critical | Validate the complete marker grammar and bind it to a signed/verified manifest or generated artifact. A predictable comment cannot prove composition. |
| Marker only quoted/deeper in prompt | Refused, exit 3 | none | Retain tests. |
| `DISPATCH_OVERRIDE='   '` | Refused, exit 2 | none | Retain test. |
| `DISPATCH_OVERRIDE=reason ORCH_OPS_JOURNAL=/dev/null` | Exit 0; claimed journal at `/dev/null`, no durable journal entry | high | Do not allow journal path override in production; require a regular file under repo/runtime and verify durable append. |
| `ORCH_DISPATCH_CHECK=/tmp/always-ok.ts` | `dispatch-lane.sh` dispatched unmarked prompt, exit 0 | critical | Remove or tightly allowlist this environment override outside tests. |
| Raw secret in binary blob | Refused | none | Retain test. |
| Raw secret in forced-add gitignored file | Refused | none | Retain test. |
| Secret-shaped filename | Landed | high | Scan changed path names as well as blobs. |
| Base64-encoded secret | Landed | medium | Use a real secret scanner with decoding/entropy detectors; document residual limits. |
| Secret split as `gh\np_...` | Landed | medium | Use multiline/decoded secret detection; signature grep alone is insufficient. |

Reproduction pattern used throughout: `T=$(mktemp -d /tmp/bpa-redteam.XXXXXX); git clone /home/bpa-shell/bpa-dev-infrastructure "$T/repo"`; all landing attempts used `--no-push` inside disposable clones. The real checkout was not modified.

commit: `165ab393e8f5231314324a8527862e51c7e3c108` `[ORCH] land lane ag-workboard`  
verify: `bash gate/land.test.sh && bash gate/land-batch.test.sh && bun test tools/instructions/dispatch-check.test.ts`  
result: **NO-GO** — review provenance, dispatch marker, override journaling, and secret scanning have exploitable holes.  
secret-scan: clean (no repository changes made)  
remaining: fix critical/high findings, then repeat the listed reproductions.

Verdict: today’s mechanisms are **not fail-closed**; forged dispatch markers/checker overrides and self-authored or whitespace-skipped reviews can land safety-sensitive changes.
