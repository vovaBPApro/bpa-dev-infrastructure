# Canary contract gaps

The current Compose service exposes only its declared port; it does not declare
a healthcheck, authenticated route, resource limits, or rollback image/commit.
The acceptance harness therefore fails closed on those checks and records the
gap in `canary_contract_gap.json`.

Safe parallel-test design (harness-only): use a unique Compose project name,
the existing localhost port when free, derive CPU/RAM observations from
`docker stats`, and capture the current git SHA/image digest before teardown.
No production endpoint or runtime limit is added by this note.
