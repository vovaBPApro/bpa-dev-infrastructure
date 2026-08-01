# Watchdog recovery round 9 — coder report

base-candidate-sha: `389c60b8460813a72012d16f0a1ff27b47f9499e`

implementation-sha: `ae6c771e299876a03b9a3e131402feb49b8c4357`

scope: correct only independent-review blocker `REG-R8-1` by rejecting U+0000
in the shared `EnvironmentFile` parser before Bash physical-line parsing

live-mutations: none; all execution used repository tests and test-owned
temporary files, processes, loopback endpoints, and state

## Implementation

`telegram_read_bot_token` now compares the source file with a byte stream from
which NUL has been removed and rejects any difference before its Bash
line-oriented parser runs. This closes the false green where Bash silently
discarded NUL but systemd rejects U+0000 in an `EnvironmentFile`.

The production parser still retains round-8's quote, continuation, backslash,
CR, CRLF, other control-byte, duplicate-assignment, token-length, and bot-id
boundary guards. No watchdog state, retry, singleton, disarm, supervision,
cadence, heartbeat, or transport behavior was changed.

## Regression evidence

Two exact byte fixtures write the NUL with `Buffer.from([0])` or shell
`printf '\0'`; neither depends on a text representation of the byte:

- the shared parser fixture rejects
  `UNRELATED=before<NUL>after` followed by one otherwise-valid token;
- the bootstrap fixture proves both explicit watchdog arm and
  `has_configured_token` verification reject that file before any daemon,
  watchdog timer, or immediate watchdog service activation.

Red-before was executed against the round-8 production parser with the new
tests but without the new guard:

```text
preflight_rc=1
error: NUL-containing EnvironmentFile accepted
bootstrap_rc=1
ERROR: watchdog arm accepted NUL-containing EnvironmentFile
```

The committed focused test removes only the production NUL guard, then feeds
the exact binary fixture through the real parser. The mutant accepts it, so the
suite records:

```text
MUTATION-RED NUL EnvironmentFile guard
```

The pre-existing physical-line and bot-id boundary mutations remain red.

## Verification

Executed at `ae6c771e299876a03b9a3e131402feb49b8c4357`:

```sh
bun bootstrap/telegram-transport-preflight.test.ts
bash bootstrap/bootstrap.test.sh
bash orchestrator/watchdog-supervision.test.sh
bash orchestrator/watchdog.test.sh
bash orchestrator/watchdog-lease-guard.test.sh
ORCH_SKIP_TRUST_CHECK=1 bash orchestrator/singleton-failclosed.test.sh
bash orchestrator/knob-bounds.test.sh
bash orchestrator/cadence-knob.test.sh
bash orchestrator/heartbeat-liveness.test.sh
bun orchestrator/watchdog-transport-boundary.test.ts
bash bootstrap/deployed-drift.test.sh
bash orchestrator/telegram-daemon-mcp.test.sh
bun test core/state.test.ts
(cd daemon && bun install --frozen-lockfile && bun run typecheck \
  && bun test watchdog-turnend-a1.test.ts && bun test)
bash -n orchestrator/watchdog.sh orchestrator/install-watchdog.sh \
  orchestrator/launch.sh orchestrator/knobs.sh bootstrap/install.sh \
  bootstrap/bootstrap.test.sh bootstrap/telegram-transport-preflight.sh \
  orchestrator/watchdog-supervision.test.sh \
  orchestrator/watchdog-lease-guard.test.sh \
  orchestrator/cadence-knob.test.sh orchestrator/knob-bounds.test.sh
git diff --check 389c60b8460813a72012d16f0a1ff27b47f9499e..HEAD
```

Observed:

- shared transport preflight: PASS, including NUL mutation-red;
- bootstrap arm/verify and rollback fixtures: PASS;
- watchdog supervision, mission state, lease/fence, singleton, knob, cadence,
  heartbeat, transport, deployed-drift, and Telegram MCP suites: PASS;
- core state: 9 pass / 0 fail;
- daemon typecheck: PASS;
- focused daemon turn-end: 10 pass / 0 fail;
- full daemon: 247 pass / 0 fail across 22 files;
- shell syntax and diff checks: PASS;
- worktree clean after the implementation commit.

The canonical secret pattern was extracted at runtime from
`gate/land-lib.sh` and applied to `git diff origin/main...HEAD`; grep exited 1
with zero matches.

secret-scan: clean

## Terminal contract

commit: `ae6c771e299876a03b9a3e131402feb49b8c4357` `[CODER] reject NUL in watchdog environment files`

verify: `bun bootstrap/telegram-transport-preflight.test.ts && bash bootstrap/bootstrap.test.sh && (cd daemon && bun run typecheck && bun test)`

result: `NO-GO`

blocker: fresh independent Tier-A review and gated landing are still required

secret-scan: clean

remaining: independent operations/security and regression/false-green review
