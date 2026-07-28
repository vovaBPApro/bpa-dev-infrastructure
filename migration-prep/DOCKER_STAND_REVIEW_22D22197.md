# Docker stand review — 22d22197

Verdict: **REJECT for migration acceptance; smoke stand is useful**.

## Reproduced

`SHORT=1 SOAK_SECONDS=1 COMPOSE_PROJECT_NAME=review-stand HOST_PORT=18082
contour/run_stand.sh /tmp/review-stand.json` completed with `fail_closed=true`.
Build, compose config, health, authenticated route, resource-limit inspection,
stats, and teardown all returned success.

## Remaining false-green/scope gaps

- This evidence is one-second short mode, not the required four-hour soak.
- `resource_metrics` checks only non-empty `docker stats` output; it never
  parses CPU/memory usage against thresholds.
- “Rollback” stops the stand and confirms the same image ID still exists; it
  does not restore a prior image/commit or prove runtime rollback.
- Manifest remains only SHA-256 of the compose file, omitting source, image,
  lockfile, and runtime configuration provenance.
- `run_parallel_stands.sh` runs two short stands only; no third canonical
  integration stand or collision/replay comparison is produced.

Thus authenticated routing and encoded limits are improved, but HR-05/07/10
and the migration test-plan Go gates remain unmet.
