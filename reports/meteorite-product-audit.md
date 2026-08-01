# Product meteorite audit — 2026-08-01

## Mission-pack consumption

- lane-lifecycle sha256:84d3db25d785 — Lane Lifecycle
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- tool-permissions sha256:955630cc416e — Tool Permissions
- repository-hygiene sha256:02acdffe2a56 — Repository Hygiene
- isolated-test-environments sha256:6ffd35d7c9f1 — Isolated Test Environments
- operator-feedback sha256:fc36fafe4623 — Operator Feedback
- instruction-layers sha256:cd21f4ce0990 — Instruction Layers
- branching-policy sha256:98cd92116325 — Branching Policy
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

The earlier `reports/meteorite-test.md` measured whether a clean Ubuntu host
could reconstruct the control plane. Since then, bootstrap activation, system
units, fleet launch, provider preflight, host-input inventory, runtime drift
checks, and Docker/database isolation have been added. That audit did not test
the product database or its configuration, so it could not detect any of the
five divergences found tonight.

## Measured finding

The infrastructure repository does not contain the product and therefore cannot
itself migrate or start it. The tracked product repository now contains a
clean-container install proof (`deploy/test-install-container.sh`) and a tracked
`DATA_ORGANIZATION_ID` example. This repository now invokes that proof only from
a fresh clone, on a nightly timer, and records the exact tested product SHA.

The check deliberately reports these non-repository requirements instead of
hiding them: a working Docker engine and Git read access to the private product
repository. Product credentials, production database state, and production
files are neither read nor mounted.

The five incident facts become one acceptance boundary: the fresh clone must
create a fresh PostgreSQL database, apply only tracked migrations (including
organization scoping/backfill), create the declared application role/grants,
derive configuration from the tracked example, start the tracked service, and
return healthy. Any absent migration, grant, required config key, invalid NULL
backfill, startup failure, or health failure makes the product-owned rebuild
command non-zero and this scheduled check `NO-GO`.

## Executed result

The first run cloned product SHA
`20080b7172ba904770f2b74d68331291bfb60606` and built a new privileged Debian
container. The installer created a new PostgreSQL 15 cluster, application role,
database credentials, and database, then applied the migrations from that clone.
Startup correctly refused to continue: **29 organization-owned tables lacked
complete RLS coverage**. No health endpoint was opened. Result: **NO-GO**.

This is new evidence, not a restatement of the earlier audit: the control-plane
rebuild gaps have moved materially, while the newly measured product boundary
still fails before health. The next bounded action belongs in the product repo:
complete the tracked RLS migration/coverage assertion until its own clean
container proof passes; this infrastructure check will then turn green without
any host-side patch.
