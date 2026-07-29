| Test file | Verdict | Evidence | Concrete strengthening |
|---|---|---|---|
| `daemon/status.test.ts` | SOLID | `/tmp` mutation `count: lanes.length → 0` was caught (9 tests: 5 fail). However the “Telegram reaches message” test only reconstructs a string; it does not invoke `server.ts`. | Add a handler-level test calling `/status` through the server boundary. |
| `dispatch-check.test.ts` | SOLID | `/tmp` mutation `hasComposeMarker(contents) → true` was caught (18 tests: 4 fail), including CLI refusal and wrapper behavior. | Add malformed-marker cases (wrong role/SHA syntax) if the marker contract intends to validate those. |
| `session-load.test.ts` | WEAK | Good synthetic composition and threshold tests, but every repository is a fixture; no test asserts the actual repo’s SessionStart load and budget. | Add a real-repo budget/check test, with stable expected inclusion/exclusion assertions. |
| `memory-sweep.test.ts` | SOLID | Uses real temporary filesystem trees and imports the daemon serializer for compatibility; no tautologies found. Deliberately avoids real `~/.claude`, appropriately. | Add a symlink/unreadable-file test if those paths are supported. |
| `ledger.test.ts` | SOLID | Boundary conditions (24h/72h, routed, parked, malformed JSONL) exercise computed findings, not mocks. Synthetic state is appropriate for this pure checker. | Add one CLI-level ledger test with real fixture timestamps. |
| `handoff.test.ts` | WEAK | `validateHandoff` rejects a future timestamp, but `writeHandoff` does not. Direct `/tmp` CLI experiment with `--ts 2099-01-01T00:00:00.000Z` exited 0 and wrote a file. | Decide policy, then test it: reject future timestamps on `write`, or explicitly document/cover deferred validation. |
| `check.test.ts` | WEAK | `[cmd-exists]`, `[session-load]`, and `[ledger]` mostly run against synthetic repos; they can drift from real instruction paths/config. A real-repo strict check exists indirectly in `compose.test.ts`, which helps. | Add direct real-repo `check.ts --strict` coverage and assert all command references are checked. |
| `compose.test.ts` | SOLID | Includes real-repo rendering for every role and a real-repo strict check. Missing-fact fail-closed behavior is tested. | Parameterize missing-key coverage for all four required facts and missing `params.yaml`, not only `phase.active_scope`. |
| `gate/land.test.sh` | SOLID | Runs the real gate against disposable Git remotes. `/tmp` mutation disabling reviewed-SHA comparison was caught. `--skip-review` is covered, including missing-reason refusal and journal output. | Add an assertion that the skip record has the exact branch SHA. |
| `gate/land-batch.test.sh` | MISSING-COVERAGE | It exercises real batch landing, conflicts, secrets, freshness, payloads, and rollback—but contains no `--skip-review` invocation despite the implementation supporting it. | Add missing-reason refusal plus successful batch skip asserting per-branch review-skip journal records and `BATCH review=SKIPPED`. |

No `expect(true).toBe(true)`-class tautologies found. Some count assertions are paired with behavioral assertions; the notable count-only concern is handoff’s single-worktree expectation, which does not validate future-write policy.

commit: `165ab393e8f5` `[ORCH] land lane ag-workboard`  
verify: `bun test daemon/status.test.ts tools/instructions/{dispatch-check,session-load,memory-sweep,ledger,handoff,check,compose}.test.ts && bash gate/land.test.sh && bash gate/land-batch.test.sh`  
result: `NO-GO` — future handoff writes are accepted and batch `--skip-review` is untested.  
secret-scan: clean  
remaining: add the three strengthening tests: batch skip-review, handoff future-write policy, complete compose instance-fact omissions.

Verdict: today’s green suite is moderately trustworthy for its core locks, but fix batch `--skip-review`, handoff future-write handling, and real-repo/complete instance-facts coverage before treating it as a release gate.
