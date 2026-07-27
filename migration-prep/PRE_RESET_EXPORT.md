# Pre-reset export (read-only inventory)

Captured 2026-07-27 UTC before any reset. No repositories, branches, worktrees,
secrets, or runtime state were modified.

## Repository state

- Repository: `bpa-master` (`/home/bpa-shell`)
- Branch: `dev`, tracking `origin/dev`
- Divergence: ahead 6, behind 14
- HEAD: `ef2fe5340ea23153ece4094ecb1e6004acde91fb`
- HEAD subject: `[CODER] quarantine disk cleanup with lock and metrics`
- Tracked working-tree diff: 3 files, 17 insertions; binary diff size 6740 bytes
- Tracked diff SHA-256: `bb7e4e60e6d83e2813dccc29568b92228b6f9a5eff539bd04f78f63e0571cb28`
- Untracked files: 32,491; most are runtime reports, worktrees, and daemon
  state. They are intentionally excluded from this export.

Regenerate the tracked patch outside this Markdown package with:

```sh
git diff --binary > /safe/external/location/bpa-master-tracked.patch
```

## Migration-prep checksums

```text
b5ffd73f684f6538c0e891e193251b3957d582542661f920e1a4e6b00d020447  README.md
9a5439be88ccc1dea13d44883d2311a2209c20706ca60cf1bacc85a088ed22a9  contracts.md
48c4f81de30325bbf411bab9edf75fd04f76b9ed8b7dd290c36386895c7b8d05  problem-matrix.md
932985b5f5396799fe8afb6a7346de2ae31f1c3624d1067fffb38d127bbc8cb9  test-plan.md
404f47b96982d27a28e4f5694eaba6ffb0611f0decee94af85ca0c737b6534dd  timeline.md
```

## Secrets and safe carry-over

Secret-bearing paths (including `.env*`, session files, tokens, private keys,
and daemon runtime state) are explicitly excluded. Carry over only the five
Markdown documents above and the reviewed contracts they describe. Recreate
runtime state from a clean checkout; do not copy untracked worktrees or
heartbeat/report archives into a new repository.

