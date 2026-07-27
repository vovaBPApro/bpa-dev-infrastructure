# Self-bootstrap test environment (staged, not installed)

This is a dry-run checklist for a clean Ubuntu host. No installer or service is
implemented yet, and no host packages, users, secrets or Telegram leases were
changed.

## Required inputs

- A disposable Ubuntu VM with a pinned image and network egress policy.
- At least 4 CPU, 8 GB RAM and 20 GB free disk for the first smoke run.
- A reviewed commit SHA and package checksum manifest.
- Operator-provided test credentials only; never copy existing daemon secrets.

## Test sequence

1. Verify OS, time sync, disk/RAM and TLS; emit a redacted host manifest.
2. Run bootstrap in dry-run and confirm the planned service user/state paths.
3. Create an isolated local state store and replay one synthetic mission.
4. Kill/restart the process and verify deterministic replay and no duplicate work.
5. Exercise lease expiry, reconnect and message deduplication without Telegram.
6. Export diagnostics and destroy the VM after the run.

## Blockers

- The correct standalone Git remote for `bpa-dev-infrastructure` is not yet
  supplied; current origin is the source `bpa-shell` repository.
- Bootstrap implementation, test harness and signed release artifacts do not
  exist yet.
- Telegram/MCP credentials and any production integration remain intentionally
  unconfigured.

