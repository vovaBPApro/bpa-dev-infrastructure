# Instruction/governance artifact audit

Audit source: `telegram-dev-daemon` main at
`4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa`. Imported files below are exact
reference artifacts under `migration-prep/reference-daemon/`; they are not
runtime wiring.

## Imported exact artifacts

- `GEMINI.md`
- `docs/ops/auto_approve.example.json`
- `docs/ops/permissions_policy.md`
- `scripts/orchestrator-turnend-relay.sh`
- `templates/daemon/orchestrator-turnend-relay.sh`
- `templates/daemon/test/orchestrator-turnend-relay.test.sh`
- `tools/claude-telegram-daemon/com.bpa.orchestrator-watchdog.plist`
- `tools/claude-telegram-daemon/install-watchdog.sh`
- `tools/claude-telegram-daemon/orchestrator-turnend-relay.sh`
- `tools/claude-telegram-daemon/test/orchestrator-turnend-relay.test.sh`

Previously imported and covered by `REFERENCE_DAEMON_SNAPSHOT.md`: `AGENTS.md`,
`CLAUDE.md`, core role/review/orchestrator policies, daemon server/relay/
reliability tests, and watchdog source.

## Deliberate omissions

- `templates/project/**` is a downstream project template, not daemon runtime;
  it remains inventory-only until the project bootstrap plan requires it.
- Product application files and unrelated UI/e2e assets are not part of this
  infrastructure import.
- No manifest is installed, regenerated, or edited; imported manifests remain
  byte-for-byte reference inputs.

## Verification

Run `migration-prep/verify_reference_daemon.sh` for pinned source/path checks.
Any divergence from the pinned SHA is `NO-GO` and requires a new review.
