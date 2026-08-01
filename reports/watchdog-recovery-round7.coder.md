# Watchdog recovery round 7 — coder terminal report

## Mission pack consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:6dc6f5d4768f — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Result

The tracked bootstrap arm and deployed verification now share one bounded
Telegram `POST /bot<token>/getMe` precondition. curl receives the secret URL on
stdin, responses stay in a mode-0600 temporary file, and only an acknowledged
bot identity matching the token's bot id passes. Timer enable and immediate
watchdog service execution remain downstream of this proof.

The EnvironmentFile parser accepts exactly one unquoted column-zero assignment,
with a documented 6..15 digit id and 20..128 character secret. Fixtures cover
the exact boundaries, adjacent and very-long values, leading whitespace,
duplicates, comments, empty/quoted/exported assignments, auth rejection,
timeout, malformed/wrong identity, and a success response without an observed
request. Failure output is checked for token disclosure.

The restart-state lock now names `9999999999` as accepted and
`10000000000` as rejected. An executable production-parser mutant widens both
the grammar and cap and demonstrably suppresses required recovery.

No live service, session, timer, unit, credential, or runtime file was touched.

## Evidence

- `bun bootstrap/telegram-transport-preflight.test.ts` — PASS.
- `bash bootstrap/bootstrap.test.sh` — PASS.
- `bash orchestrator/watchdog.test.sh` — PASS.
- `bash orchestrator/watchdog-lease-guard.test.sh` — PASS.
- `bash orchestrator/cadence-knob.test.sh` — PASS.
- `bash orchestrator/knob-bounds.test.sh` — PASS.
- `bash -n ...` over affected shell files — PASS.
- `bash orchestrator/watchdog-supervision.test.sh` — NO-GO: its final existing
  real-daemon boundary times out waiting for a successful send; the spawned
  daemon makes no request to the loopback Telegram fixture. The new restart
  mutation-red row passes before that boundary.
- `cd daemon && bun test watchdog-turnend-a1.test.ts` — NO-GO: 5 pass, 5 fail;
  existing async watchdog/relay waits time out.
- `cd daemon && bunx tsc --noEmit` — NO-GO: installed type definitions
  `bun-types` and `node` are absent.

Independent fresh dual Tier-A review is still mandatory and has not been
performed by this coder lane.

commit: 13cf795e85180519ffef2f637e77b294e3e859a4 [CODER] prove watchdog alert transport before arming
verify: bun bootstrap/telegram-transport-preflight.test.ts && bash bootstrap/bootstrap.test.sh && bash orchestrator/watchdog-supervision.test.sh && (cd daemon && bun test watchdog-turnend-a1.test.ts)
result: NO-GO
blocker: existing real-daemon transport and turn-end suites time out; TypeScript dependencies are absent
secret-scan: clean
remaining: repair the daemon loopback transport/turn-end timeout, restore type dependencies, then obtain fresh dual Tier-A review
