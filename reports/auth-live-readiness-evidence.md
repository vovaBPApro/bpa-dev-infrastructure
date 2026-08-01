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
