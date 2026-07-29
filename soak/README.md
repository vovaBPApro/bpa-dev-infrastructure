# Rail throughput soak

`bash soak/soak.sh 10` builds a disposable local product repository and exercises
the real durable-state CLI, Git worktrees, completion guard, and landing gate.
Ten deterministic local workers run concurrently. Each owns a worktree and
branch, commits a unique file plus its own line in a shared counter file, and
emits a contract-shaped report while holding and releasing a fenced lane lease.
Landing is deliberately serialized through `gate/land.sh --no-push`.

Two lanes are adversarial: lane 1 generates a fake GitHub-style token in its
fixture-only diff and must fail the gate secret scan; lane 2 writes a malformed
report and must fail the completion guard. A run passes only when every other
lane lands and both refusals occur. Its report includes per-lane verdicts,
timings, overlap-derived maximum concurrency, durable-state row counts, and
post-cleanup worktree/branch/process counts. Reports go to `$SOAK_REPORT_FILE`,
or `soak-report.md` in the fixture directory by default.

This proves local rail throughput and isolation: it does not evaluate LLM work
quality, network/provider behavior, Codex availability, or quota limits.

Run the fast CI fixture with `bash soak/soak.test.sh`; run the acceptance soak
with `bash soak/soak.sh 10`.

## Failure-injection matrix

`bash soak/chaos.sh` builds separate disposable repositories and state databases
for nine deterministic failure modes. It invokes the real landing gates,
mission CLI, watchdog tick, and hygiene reaper as black boxes. Each scenario
prints `CHAOS scenario=<name> verdict=PASS|FAIL detail=...`; the final total is
non-zero on any failed reaction assertion. The matrix covers missing and
duplicate reports, killed landing, batch conflicts and secrets, orphaned
worktrees, disk-pressure nudge rate limiting, fenced lease restart, and a
mixed-fate ten-lane run. It never contacts an LLM or a network origin.

Run the CI-cheap subset with `bash soak/chaos.test.sh` (under 30 seconds).

## Endurance soak

`bash soak/soak-endurance.sh` sustains the real concurrent round soak for a fixed number of rounds (20 at 10 lanes by default) or a wall-clock cap, and proves that the pace holds without cross-round cleanup or resource degradation: before round 1 and after every round it snapshots disposable fixture directories, worktrees, `ag-soak-*` branches, fixture-associated Bun/Git processes and RSS, temporary-disk free space, and active leases in that round's disposable state DB. It fails on any non-PASS round, residual resource, monotonic disk decline, or a round that is drastically slower than round 1; it does not prove LLM quality, network behavior, or real Codex quota. For an overnight run, use `bash soak/soak-endurance.sh --minutes 600 --lanes 10`.
