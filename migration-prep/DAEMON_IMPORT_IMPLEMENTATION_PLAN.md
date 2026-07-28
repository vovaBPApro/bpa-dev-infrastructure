# Daemon import implementation plan (pinned reference)

This plan is intentionally governance-only. It does not add dependencies,
manifests, runtime code, or a production wiring path.

## Source and invariant

The compatibility source is `telegram-dev-daemon` at
`4cdf3c70c6ec9d28608d7921b4dd4dd31ce340aa`. A moving branch, partial copy, or
Python reimplementation cannot silently replace it. Any deviation requires a
new reviewed plan and explicit rationale.

## Execution sequence

1. **Inventory (landed):** verify the pinned SHA and required files using
   `REFERENCE_DAEMON_SNAPSHOT.md`; record runtime entrypoints, environment
   inputs, Telegram bridge behavior, watchdog recovery, and state files.
2. **Contract extraction:** convert the reference tests and operational docs
   into a behavior matrix: startup, health, auth, reply delivery, retries,
   restart/replay/idempotency, lane reports, cleanup, and shutdown.
3. **Import slice:** a coder imports the daemon runtime faithfully under an
   isolated path. It must preserve Bun/TypeScript semantics and add tests for
   every extracted contract. Package/lockfile edits are a gated operation and
   must be approved before they land.
4. **Independent review:** a different vendor/session executes the tests,
   checks fail-before/pass-after for each regression, compares exported
   behavior to the reference SHA, and rejects false greens or untested paths.
5. **Parallel stands:** launch at least three disposable Compose projects in
   parallel: `replay`, `watchdog`, and `telegram`; each receives a unique
   project name, network, host-port range, workspace, and evidence directory.
   A fourth `integration` project is the canonical end-to-end stand. No stand
   shares mutable worktrees, state, or ports.
6. **Differential replay:** feed the same deterministic event fixture to the
   pinned reference and imported runtime. Compare normalized event streams,
   terminal mission state, reply payloads, retry counts, and evidence hashes.
   Any difference is `NO-GO` until explained and reviewed.
7. **Soak and recovery:** run bounded resource/health checks, kill and restart
   each stand, and verify recovery, fencing, cleanup, and no duplicate replies.
   Capture logs and machine-readable evidence; never infer green from process
   exit code alone.
8. **Handoff:** push every commit immediately. Publish one concise report with
   exact SHAs, commands, test totals, Docker stand IDs, replay diff, and open
   blockers. Cutover is allowed only when all acceptance rows are green.

## Parallel stand contract

Each stand must declare: `COMPOSE_PROJECT_NAME`, isolated network, workspace,
evidence directory, host ports, resource limits, fixture seed, and cleanup
policy. A stand failing health/auth, resource, rollback, or evidence checks is
failed closed and cannot be promoted by a reviewer override.

## Completion gate

The import is complete only when the source pin, contract matrix, independent
review, differential replay, parallel Docker evidence, restart/soak results,
and pushed commits are all present. Otherwise the status is `NO-GO` with one
concrete blocker and the next artifact to land; do not switch missions.
