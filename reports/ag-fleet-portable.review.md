# Independent review: ag-fleet-portable

reviewed-sha: 379d2d3904e0ffbebe47b98f67bae2384e6d7c18
reviewer: Codex reviewer lane `/root`
independence: reviewer did not author the reviewed implementation commits
tier: Tier A — fleet/orchestrator dispatch and evidence-gate behavior
verdict: ACCEPT

## Manifest consumption check

- review-policy sha256:b95d6eb6d0e5 (baseline) # Review Policy
- verification-and-locks sha256:b13ed13070c1 (baseline) # Verification and Regression Locks
- roles sha256:cd4c40c4e640 (baseline) # Roles
- instruction-layers sha256:f9a51936be92 (baseline) # Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd (baseline) # Tool Permissions
- reproducible-from-git sha256:822d9efe694b (baseline) # Reproducible From Git

## Rebase, scope, and reproduced counts

The branch was rebased onto the fetched `origin/main` before review. Rebase
output:

```text
Rebasing (1/5)
Rebasing (2/5)
Rebasing (3/5)
Rebasing (4/5)
Rebasing (5/5)
Successfully rebased and updated refs/heads/ag-fleet-portable.
```

Commands:

```sh
git rev-parse HEAD
git diff --name-status origin/main...HEAD
git diff --numstat origin/main...HEAD
git diff --name-only origin/main...HEAD | wc -l
git rev-list --count origin/main..HEAD
```

Output:

```text
379d2d3904e0ffbebe47b98f67bae2384e6d7c18
M	orchestrator/fleet/README.md
A	orchestrator/fleet/launch-lane.sh
A	orchestrator/fleet/launch-lane.test.sh
A	reports/ag-fleet-portable.coder.md
A	reports/ag-fleet-portable.review.md
31	14	orchestrator/fleet/README.md
97	0	orchestrator/fleet/launch-lane.sh
96	0	orchestrator/fleet/launch-lane.test.sh
47	0	reports/ag-fleet-portable.coder.md
125	0	reports/ag-fleet-portable.review.md
5
5
```

Thus the candidate has exactly 5 changed paths, 5 commits ahead, 396 added
lines, and 14 deleted lines. The implementation itself remains the claimed
portable one-lane launcher plus its executable lock and documentation; the two
report paths are review-chain evidence. No added launcher line contains a
literal `/root` or `/home` path (`LITERAL_ROOT_HOME_COUNT=0`).

## Positive verification

Command:

```sh
bash orchestrator/fleet/launch-lane.test.sh
```

Output:

```text
compose: wrote 9 docs + 0 interim to /root/.cache/lane-tmp/tmp.KmfL62BVPh/lanes/pack-proof
launch-lane dispatch proof: PASS
TEST_EXIT=0
```

The success path passed through the mocked SYSTEM-manager boundary, executed
the submitted shell payload, and produced an observable Codex marker and argv.
The assertions also confirm `--unit lane-proof`, no `--user`, the isolated
worktree branch, composed pack marker, mission body, working directory, and
append-log properties.

A fresh shared clone with an otherwise empty environment also passed:

```sh
env -i HOME="$scratch/home" PATH="/usr/local/bin:/usr/bin:/bin" \
  BUN_BIN=/usr/local/bin/bun \
  bash "$scratch/repo/orchestrator/fleet/launch-lane.test.sh"
```

Output:

```text
compose: wrote 9 docs + 0 interim to /tmp/tmp.Y4KTbCWTt8/lanes/pack-proof
launch-lane dispatch proof: PASS
FRESH_ENV_EXIT=0
```

`bash -n` and `shellcheck` both exited 0 for `launch-lane.sh` and
`launch-lane.test.sh`. `git diff --check origin/main...HEAD` exited 0.

## Red-before / green-after regression evidence

In a disposable clone at the candidate SHA, I removed only this production
line from `launch-lane.sh`:

```sh
BUN_BIN="$BUN_BIN" bash "$repo/orchestrator/dispatch-lane.sh" "$prompt" >/dev/null
```

I then ran the replacement lock unchanged:

```sh
bash orchestrator/fleet/launch-lane.test.sh
```

Real output:

```text
compose: wrote 9 docs + 0 interim to /root/.cache/lane-tmp/tmp.jO9VPcdXOz/lanes/pack-proof
marker-gate refusal incorrectly dispatched the lane
FAIL_BEFORE_EXIT=1
```

Restoring the candidate implementation and running the same test produced the
positive output above with exit 0. The lock therefore fails without the marker
gate and passes with it; it does not pass both ways.

## Fail-open, rollback, and verdict

The launcher validates prerequisites, composes and checks the materialized pack,
and only then creates the worktree and submits the SYSTEM unit. Injected gate
refusal exits non-zero and leaves no worktree, system-manager call, or Codex
execution. Submission failure exits non-zero and retains the isolated worktree
for diagnosis rather than claiming launch completion. Existing lane artifacts
are refused. I found no path in the reviewed diff that converts unknown or
failed dispatch state into success.

Rollback is a revert/removal of the launcher, test, and documentation changes;
there is no migration, production data mutation, or persistent service install
in this diff. The prior false-green finding is resolved by an independently
reproduced biting lock. Verdict: **ACCEPT**.
