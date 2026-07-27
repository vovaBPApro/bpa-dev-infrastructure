# Phased timeline

| Phase | Work | Exit evidence |
|---|---|---|
| P0 | contracts, fixtures, problem matrix, resource budget | reviewed package and golden fixtures |
| P1 (1–2d) | mission store, state machine, TTL, replay | restart/replay tests green |
| P2 (1–2d) | supervisor, bounded workers, retries, archival | failure-injection tests green |
| P3 (1d) | Telegram/MCP lease, offsets, dedupe, reconnect | reconnect/duplicate tests green |
| P4 (1d) | status projection and CLI | one command lists truthful mission state |
| P5 (1–2d) | shadow, canary, four-hour soak, rollback drill | go/no-go checklist passes |

Human involvement is kickoff, review of the evidence packet, and approval of
the irreversible Telegram lease cutover only. No production cutover is included
in P0–P5.

