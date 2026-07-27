# Problem matrix and evidence

| Problem | Evidence | Required invariant |
|---|---|---|
| Stale/false-active status | terminal heartbeat files and old reports remain visible | status is derived only from a live lease, TTL heartbeat, and running report |
| Unknown deployed version | current dirty `dev` is ahead 6/behind 14; HEAD `ef2fe5340e…` is a cleanup commit | every stand has immutable source SHA, remote, image and timestamp manifest |
| Branch/worktree churn | bpa-master has 193 local branches; reaper retains protected/unmerged refs | lifecycle closes only merged/terminal refs without a worktree; evidence is archived |
| Manager/worker fragility | prior lanes stall, restart, or leave incomplete reports | idempotent dispatch, bounded retries, fenced leases, terminal archival |
| Telegram/MCP reconnect risk | single-lease and reconnect behavior is not a durable contract | one poll lease, sequence offsets, message-ID deduplication, stale-lease fencing |
| Resource pressure | host repeatedly reaches ~94% disk; Bill dev has recurring HMR OOM evidence | bounded concurrency, memory/PG caps, and a 4-hour soak gate |

Docker inventory currently shows 0 bytes reclaimable; no image deletion is part
of this migration package.

