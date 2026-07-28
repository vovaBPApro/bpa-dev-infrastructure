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
