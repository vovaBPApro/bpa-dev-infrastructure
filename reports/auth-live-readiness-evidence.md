# Live-database evidence for enabling AUTH_ENFORCEMENT

Gathered by the orchestrator on the LIVE database on 2026-08-01, because the
independent auth review correctly returned NOT SAFE for lack of exactly this:
it is forbidden from touching the live stand, so it could not produce it.

Read-only queries. No schema, data or permission was modified.

## 1. No NULL organization_id remains on org-scoped tables

    imported_transactions      0 / 16452
    imported_postings          0 / 32959
    imported_accounts          0 / 107
    import_runs                0 / 80
    gmail_imported_documents   0 / 137
    sales_invoices             0 / 0

This was the blocker that mattered: hours earlier every one of those 16,452
transactions had `organization_id = NULL`, and the RLS policy
`(enforcement='off') OR (organization_id = current_data_organization_id())`
evaluates `NULL = <uuid>` to NULL, not true. Enabling enforcement would have
hidden the entire ledger while the data sat intact underneath.

## 2. Parity: identical counts with enforcement OFF and ON

Executed as the application role `agentic`:

    mode | txns  | postings | accounts | docs
    off  | 16452 |    32959 |      107 |  137
    on   | 16452 |    32959 |      107 |  137

Same role, same session, only `app.organization_enforcement` changed. The books
are fully visible under enforcement.

## What this evidence does NOT cover

It is a database-level proof. It does not by itself demonstrate the PRODUCT
behaves correctly under enforcement — that was covered separately on a disposable
stand: browser login reaching `/bill`, 401 without a session, 10/10 organization
isolation checks, and only login/register/reset assets made public with the Bill
and Mila application chunks still protected.

Both halves together are what a "safe to enable" verdict requires.

## 3. Catalog enumeration, not a sample (added after review round two)

The first version of this artifact sampled six tables. The reviewer rejected it
for exactly that: a sample is not an inventory. Enumerated from the catalog —
every `public` table carrying an `organization_id` column:

    66 org-scoped tables
    tables with any NULL organization_id: NONE

    tables lacking ENABLE + FORCE ROW LEVEL SECURITY:
      auth_organization_memberships   (the documented auth_* exemption:
                                       it identifies the actor before an
                                       organization scope exists)

Note two retained artifacts appear in that inventory and are correctly scoped:
`gmail_imported_messages_orphan_20260801` and `gmail_import_runs_orphan_20260801`,
kept as evidence from W-21 and never dropped.

## 4. Query path, not only row counts (added after review round two)

The reviewer's second objection was that counting rows does not prove the
application's real queries return data — rows can be visible while a scoped JOIN
returns nothing. Executed as the app role, changing only
`app.organization_enforcement`:

    postings JOIN transactions JOIN accounts
    mode | joined_rows | sum(amount)
    off  |       32959 | 0.0000
    on   |       32959 | 0.0000

A three-way join across the tables the ledger surfaces depend on returns identical
rows and identical totals under enforcement. `sum(amount) = 0.0000` is the
expected double-entry result, not an empty read.

## 5. Alternative scope paths and views (added after review round three)

The third review asked whether a table could be organization-scoped by a DIFFERENT
column and therefore be missed by a catalog query keyed on `organization_id`, and
whether any view bypasses row-level security.

Every `public` table WITHOUT an `organization_id` column, enumerated:

    auth_rate_limits      auth_sessions      auth_tokens
    auth_users            schema_migrations

None carries `realm_id`, `tenant_id` or `company_id` either — checked explicitly.
Four are `auth_*` infrastructure that exists to identify an actor before any
organization is known; the fifth is the migration ledger. No business data table
sits outside `organization_id` scoping.

    views in schema public: NONE

So there is no view path around RLS, because there are no views.

## 6. Grants on the exempt table (added after review round three)

`auth_organization_memberships` is the single org-scoped table without forced RLS.
Its exemption is deliberate — membership is what RESOLVES an actor's organization,
so it cannot itself be filtered by that organization without a circular dependency.

    grants: agentic -> INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    columns: user_id, organization_id, role, created_at, payroll_read, payroll_write
    rows: 0

Two observations, stated rather than glossed:

- the table is EMPTY. With enforcement on and no memberships, no actor resolves to
  an organization, so the operator must have a user and a membership created
  before enabling — otherwise he will authenticate and be denied. This is a
  prerequisite, not a defect, and it is the single most likely way enabling could
  still go wrong for him.
- the application role holds full DML on it, which is required to create members.
  It carries no accounting data; its exposure is the membership graph itself.
