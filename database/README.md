# Database access contract

`access.declaration.json` is the tracked source of truth for the production
database owner, runtime roles, role attributes, schema ownership, and schema
grants. It contains no password. `check-access.ts` is read-only unless an
operator explicitly supplies `--apply`.

For a new empty database, provision the role password outside Git, create the
named database, then reconcile the declaration as an administrative role:

```sh
DATABASE_URL=postgresql://... bun database/check-access.ts --apply
DATABASE_URL=postgresql://... bun database/check-access.ts
```

The installation renders and enables `agentic-bpa-db-grants.timer`. Its service
reads `DATABASE_URL` from `/etc/agentic-bpa/app.env`, checks every five minutes,
exits non-zero on drift, writes `DB-GRANT ALARM` to the journal, and attempts the
local notification route. The scheduled service never uses `--apply`.

No tracked statement or retained evidence identifies what removed `CREATE`
from `agentic`. The cause remains unknown; the checker detects recurrence
without guessing at attribution.
