# Bounded parallel execution plan (5–8 working days)

Parallel work is limited to isolated disposable environments. No track may
touch production, secrets, or another track's state. A merge gate accepts only
documents/tests with a correlation ID, owner, evidence path and rollback note.

## Tracks and dependencies

| Track | Days | Depends on | Evidence |
|---|---:|---|---|
| A. Contracts/store | 1–3 | P0 contracts | schema/version, replay fixture, restart test |
| B. Lease/status | 1–3 | P0 contracts | expiry/fencing tests; active/terminal projection table |
| C. Manager/worker harness | 2–4 | A+B interfaces | duplicate dispatch, retry, terminal rollup logs |
| D. Telegram/MCP adapter | 3–5 | A+B interfaces | offset/reconnect/dedupe test; redacted transport log |
| E. Ubuntu/Docker bootstrap | 1–4 | P0 bootstrap checklist | disposable container recreate, redacted manifest |
| F. Security/review | 4–6 | A–E artifacts | secret scan, least-privilege review, independent ACCEPT/REJECT |
| G. Shadow/canary | 6–8 | F ACCEPT | three-mission projection diff, canary rollback, soak report |

Tracks A, B and E may start in parallel. C and D consume their interfaces.
F is independent review, not self-approval. G is serialized and is the only
track allowed to observe a canary dispatch.

## Daily merge gates

1. **Day 1:** contracts frozen; disposable environment and resource budget
   recorded.
2. **Day 3:** persistence, TTL and bootstrap tests green; no secrets in logs.
3. **Day 5:** manager/worker and reconnect tests green; review packet complete.
4. **Day 6:** security reviewer ACCEPT; otherwise remain in shadow.
5. **Days 7–8:** three shadow missions, one canary, rollback and bounded soak.

Any duplicate side effect, stale-lease dispatch, unexplained projection diff,
missing manifest, secret exposure or resource breach is an immediate no-go and
parks only the affected track while independent work continues.

## Human attention

Kickoff and end-of-day evidence review are sufficient. Human approval is needed
only for a Telegram lease cutover or any irreversible external integration.

