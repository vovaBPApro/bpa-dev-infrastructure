# Test and go/no-go plan

## Shadow tests

- Replay three recorded missions and compare old/new projections.
- Kill and restart the shadow process during each mission.
- Deliver duplicate dispatches, heartbeats, and Telegram messages.
- Expire a lease and prove the fenced worker cannot dispatch.
- Verify terminal beats disappear from active status.

## Canary tests

- One disposable stand, one manager, at most three workers.
- Login, Bill health plus one authenticated CRUD route, and Mila stub render.
- Capture source/image manifest and route evidence.
- Run a bounded four-hour soak with memory, PostgreSQL, and disk limits.

## Go

Two consecutive clean end-to-end runs; deterministic replay; no duplicate
dispatch/reply; truthful active/blocked/terminal status; correct health paths;
manifest present; no unexplained OOM or leak during soak; rollback to old daemon
verified.

## No-go

Any unexplained projection diff, duplicate side effect, stale lease dispatch,
missing manifest, failed rollback, or resource breach. Remain in shadow mode and
repair the contract before another canary.

