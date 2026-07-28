# Operating Lessons

- **Require live daemon evidence.** Source-shape tests are false-green for daemons; changes need parse/boot and live-health locks.
- **Verify on the canonical tree at landing.** A worktree's test result cannot prove the integrated result.
- **Commit a lane's first durable slice promptly.** A lane that exits without a commit loses all its work; publish to its lane branch when transport policy allows.
- **Give each tree exactly one writer.** Shared writers create races, unreviewable provenance, and corrupted test state.
- **Write verdicts and reports to durable files.** Dispatched-agent stdout is not a reliable delivery channel and cannot be the sole terminal record.
- **Rehearse recovery with an ungraceful kill.** Restart logic that has not survived `kill -9` is an assumption, not evidence.
- **Assert serving-process identity.** Port collisions can make smoke tests false-green even when HTTP returns 200.
- **Prove fail-closed preflights at scale before landing.** An untested gate can block the whole fleet or create an unsafe bypass.
- **Bound heavy-test parallelism and serialize real-database lanes when needed.** Unbounded concurrency can exhaust host memory and invalidate results.
- **Reap disk consumers mechanically.** Temporary trees, caches, worktrees, and raw artifacts consume a first-class resource and cannot depend on memory for cleanup.
