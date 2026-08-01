# Live stand incident log — 2026-08-01

This log records the six distinct occasions on which the live stand stopped or
refused to start. Claims below were checked against the infrastructure and
product Git histories; where the actor or cause is not proven, the record says
so.

## 1. Orphan Gmail tables blocked every restart (W-21)

**Operator-visible effect.** The stand looked healthy only while the old process
kept running. Every attempted restart failed for roughly six hours.

**Cause.** Production `schema_migrations` recorded
`002_gmail_import_storage.sql`, although that migration exists in no commit, and
the database contained `gmail_import_runs` plus an incompatible
`gmail_imported_messages`. Those objects collided with the tracked Gmail
migration. The responsible actor was not established; a lane reaching the
shared production database is the strongest recorded hypothesis, not a fact.

**Recovery.** The orphan tables were preserved as `*_orphan_20260801`, the
phantom migration-ledger row was removed, and the tracked Gmail migration was
applied.

**Lock now.** Infrastructure commits `9800c54` and `4cdcd70` deny lane access to
the loopback production database and provide per-lane disposable PostgreSQL.
The deploy migration preflight in `6c21c8d` also applies candidate migrations to
a disposable copy of the live schema before restart. These checks prevent the
known paths; no check can identify who created the already-preserved orphans.

## 2. Unscoped sales tables poisoned startup and rollback

**Operator-visible effect.** The startup tenant-isolation check refused the new
release. The rollback target refused too, so changing the release symlink could
not restore service after the schema change had applied.

**Cause.** The sales tables were created with `realm_id`, without
`organization_id`, then had row-level security forced. The database migration
had already changed shared production state, which made the older code an
invalid rollback target.

**Recovery.** Production was repaired with hand SQL adding the organization
scope and policy. Product commit `c556d38` then put the missing change into
`013_sales_invoice_organization_rls.sql`.

**Lock now.** Product test `REGRESSION sales-invoice-startup-rls` applies fresh
migrations to real PostgreSQL and checks all three sales tables. Infrastructure
commit `6c21c8d` adds a disposable-live-schema deploy preflight whose regression
fixture is exactly a forced-RLS `realm_id` table missing `organization_id`; it
refuses before activation or restart and explicitly reports that code rollback
is unsafe after a migration.

## 3. The tracked repair migration was not idempotent

**Operator-visible effect.** The next deploy failed with `column
organization_id of relation sales_invoices already exists`. This time rollback
worked and the prior release stayed available.

**Cause.** The new sales repair migration used unconditional `ADD COLUMN`, but
the emergency hand repair from incident 2 had already added that column to
production. The repository described a clean database, not the state the deploy
would actually encounter.

**Recovery.** Product commit `f2736f3` changed the migration to `ADD COLUMN IF
NOT EXISTS` and made policy recreation idempotent with `DROP POLICY IF EXISTS`.

**Lock now.** The infrastructure deploy preflight from `6c21c8d` runs candidate
migrations against a disposable schema derived from live state, so the same
already-existing-column collision fails before restart. The product real-
PostgreSQL sales migration test proves the final schema, but by itself does not
exercise this hand-patched starting state.

## 4. Application role lost `CREATE` on `public` (W-27)

**Operator-visible effect.** The live endpoint returned 502 and startup logged
`Database startup check failed: permission denied for schema public`. Rollback
also failed because both releases used the same damaged database role.

**Cause.** Role `agentic` retained `USAGE` but had lost `CREATE` on schema
`public`. Git history contains no matching `GRANT` or `REVOKE`, so the cause and
actor remain unestablished.

**Recovery.** `GRANT USAGE, CREATE ON SCHEMA public TO agentic` was applied by
hand.

**Lock now.** Infrastructure commit `04473bf` declares the required role,
ownership, and grants in `database/access.declaration.json`; its scheduled
checker fails specifically when `CREATE` is revoked. The regression in
`database/check-access.test.sh` performs that revoke and requires the drift
alarm.

## 5. `DATA_ORGANIZATION_ID` was absent from the host

**Operator-visible effect.** Deploy crash-looped with `Cannot backfill
app_settings.organization_id: DATA_ORGANIZATION_ID migration context is
missing`, then restored the previous release.

**Cause.** The variable was required by the backfill and referenced by three
source files, but `/etc/agentic-bpa/app.env` lacked it and no tracked environment
example documented it. Product commit `29ddc72` records both facts in its commit
message and adds the missing example.

**Recovery.** The host value was set to the organization identifier already
used by `gmail_imported_documents`, and `deploy/app.env.example` was committed.

**Lock now.** Product commit `431fd09` adds deploy configuration preflight. Its
tests refuse a required variable that is missing from the host file, absent
from the tracked example, or invalid; install runs that preflight before
migration.

## 6. The configured identifier failed an over-strict UUID validator

**Operator-visible effect.** With the missing variable supplied, the service
still refused to start and crash-looped with the UUID validation error.

**Cause.** The installation's existing identifier is canonical UUID-shaped and
accepted by PostgreSQL, but its version and variant nibbles do not match the
validator's RFC-4122 version 1–5 restriction. Reissuing it would have orphaned
rows already keyed by that value.

**Recovery.** Product commit `20080b7` relaxed validation to canonical UUID
shape while retaining malformed-value rejection.

**Lock now.** `scripts/config-preflight.test.mjs` explicitly accepts the live
all-zero version/variant form, and `scripts/database.mjs` documents why the
validator must not be tightened back to versions 1–5.

## Night finding — Hard Floor 5

All six outages had the same underlying pattern: production state diverged from
what Git described. The schema contained untracked objects, tracked migrations
did not match the live starting state, a required grant and configuration value
existed only as host concerns, and validation rejected the identifier already
present in production data. A repository that cannot reproduce the state needed
to start the service fails the meteorite test, even when every individual hand
repair is technically correct.
