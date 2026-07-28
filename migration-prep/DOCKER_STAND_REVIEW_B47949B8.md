# Docker stand review — b47949b8

Verdict: **REJECT for migration acceptance; ACCEPT as disposable smoke stand**.

## Reproduced evidence

- `docker compose -f contour/compose.stand.yaml config --quiet`: pass.
- `SOAK_SECONDS=1 contour/run_stand.sh /tmp/stand.json`: completed with all
  checks `ok` and `fail_closed=true`.

## False-green / scope findings

- `run_stand.sh` deliberately forces `--short` and defaults to 5 seconds; this
  is not the required bounded four-hour soak.
- `authenticated_live_route=true` is derived from unauthenticated `curl
  /health`; no auth token or protected relay route is exercised.
- `rollback_verified=true` means `docker compose down` succeeded, not that a
  prior image/commit was restored and verified.
- Manifest is only a SHA-256 of the compose file, not source/image/config
  provenance; resource metrics check `docker stats` return code only and no
  threshold breach.

Therefore this is useful smoke evidence, but cannot satisfy HR-07/10 or the
migration test-plan Go gates. Differential replay, parallel stands, and clean
VM evidence are also absent.
