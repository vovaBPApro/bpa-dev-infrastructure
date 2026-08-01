# Watchdog recovery round 10 — coder report

base-candidate-sha: `0e3f361d7597c3b383c25ee61e153046f1aa1078`

implementation-sha: `3dcd91a4b484996d8fc2036ed230ffcddd795a8c`

review-blockers:

- `89556540b74cf054068f603fa4c874a3fcac43c9` (`OPS-R9-1`)
- `470901835c13a7ce98d62879eb5ab5b50f1fa596` (`REG-R9-1`)

scope: reject invalid UTF-8, U+FEFF, and every Unicode noncharacter forbidden
by installed systemd 255 across the whole watchdog `EnvironmentFile`, before
Bash physical-line parsing

live-mutations: none; all execution used repository fixtures, test-owned
temporary files and processes, loopback endpoints, and isolated state

## Implementation

The shared `telegram_read_bot_token` path now calls one fail-closed whole-file
Unicode validator before any Bash line parsing. The validator:

- decodes the exact byte stream with fatal UTF-8 decoding;
- preserves a leading BOM as U+FEFF for validation instead of consuming it;
- rejects U+FEFF at every placement;
- rejects U+FDD0 through U+FDEF;
- rejects every code point ending in FFFE or FFFF in planes 0 through 16;
- fails closed when the configured Bun executable cannot perform validation.

U+0000 remains covered by the prior exact-byte guard immediately after Unicode
validation. Keeping that guard separate preserves round 9's independently
executable NUL mutation lock. The parser still rejects continuations, quotes,
backslashes, CR/CRLF, other non-tab controls, duplicate/ambiguous assignments,
and out-of-bound token or bot-id forms.

Both explicit watchdog arm and `has_configured_token` verification use this
same parser. No watchdog timer, service, credential, session, or live runtime
state was read or changed.

## Regression evidence

The shared parser test uses exact `Buffer` byte fixtures for:

- six malformed UTF-8 classes at file prefix, inside an unrelated assignment,
  and after an otherwise-valid token;
- U+FEFF at all three placements;
- all 66 Unicode noncharacters at all three placements;
- valid scalar values immediately adjacent to the forbidden ranges.

The bootstrap integration test writes exact byte sequences for invalid UTF-8,
U+FEFF in two placements, both ends of U+FDD0..U+FDEF, and plane-ending
noncharacters in the BMP, plane 1, and plane 16. Every fixture proves both arm
and deployed verification reject before daemon/timer/immediate-service
activation.

The executable production mutation removes only:

```text
telegram_environment_file_unicode_valid "$env_file" || return 1
```

The real parser then accepts exact invalid UTF-8, U+FEFF, U+FDD0, U+1FFFE, and
U+10FFFF fixtures, producing:

```text
MUTATION-RED UTF-8 and Unicode noncharacter EnvironmentFile guard
```

The prior physical-line, 6/15 digit bot-id bounds, and NUL production mutations
also remain red.

## Verification

Executed at `3dcd91a4b484996d8fc2036ed230ffcddd795a8c`:

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
git diff --check \
  0e3f361d7597c3b383c25ee61e153046f1aa1078..HEAD
```

Observed:

- shared transport preflight: PASS, including exhaustive Unicode fixtures and
  Unicode/NUL/physical-line/bot-id mutation-red locks;
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

commit: `3dcd91a4b484996d8fc2036ed230ffcddd795a8c` `[CODER] reject systemd-invalid Unicode environment files`

verify: `bun bootstrap/telegram-transport-preflight.test.ts && bash bootstrap/bootstrap.test.sh && (cd daemon && bun run typecheck && bun test)`

result: `NO-GO`

blocker: fresh independent Tier-A operations/security and regression/false-green
reviews plus gated landing are still required

secret-scan: clean

remaining: dual independent review and gated landing
