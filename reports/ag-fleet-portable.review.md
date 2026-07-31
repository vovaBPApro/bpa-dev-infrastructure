# Independent review: ag-fleet-portable

reviewed-sha: d38e440f9cc98616807907cababe9506cfcc50c3
reviewer: Codex reviewer lane `/root`
independence: reviewer did not author commit d38e440f9cc98616807907cababe9506cfcc50c3
tier: Tier A — fleet/orchestrator dispatch and evidence-gate behavior
verdict: REJECT

## Manifest consumption check

- review-policy sha256:b95d6eb6d0e5 (baseline) # Review Policy
- verification-and-locks sha256:b13ed13070c1 (baseline) # Verification and Regression Locks
- roles sha256:cd4c40c4e640 (baseline) # Roles
- instruction-layers sha256:f9a51936be92 (baseline) # Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd (baseline) # Tool Permissions
- reproducible-from-git sha256:822d9efe694b (baseline) # Reproducible From Git

## Scope and counts reproduced

Command:

```sh
git diff --name-status origin/main...d38e440f9cc98616807907cababe9506cfcc50c3
```

Output:

```text
M	orchestrator/fleet/README.md
A	orchestrator/fleet/launch-lane.sh
A	orchestrator/fleet/launch-lane.test.sh
```

The reviewed diff contains exactly 3 changed paths, all within
`orchestrator/fleet/`. `git diff --check origin/main...HEAD` exited 0.

## Commands and evidence

The positive lock passed at the reviewed SHA:

```sh
bash orchestrator/fleet/launch-lane.test.sh
```

Output:

```text
compose: wrote 9 docs + 0 interim to /root/.cache/lane-tmp/tmp.flmgSxWptG/lanes/pack-proof
launch-lane dispatch proof: PASS
```

A fresh local clone with an empty environment except explicit `HOME`, `PATH`,
and `BUN_BIN` also passed, proving Bun does not depend on an interactive shell
profile:

```sh
tmp=$(mktemp -d)
git clone --quiet --shared --branch ag-fleet-portable . "$tmp/repo"
env -i HOME="$tmp/home" PATH="/usr/local/bin:/usr/bin:/bin" \
  BUN_BIN=/usr/local/bin/bun \
  bash "$tmp/repo/orchestrator/fleet/launch-lane.test.sh"
```

Output:

```text
compose: wrote 9 docs + 0 interim to /tmp/tmp.LXRcrvqcxV/lanes/pack-proof
launch-lane dispatch proof: PASS
```

The captured `systemd-run` argv contains `--unit` and `lane-proof` and contains
no `--user`, so the implementation targets the SYSTEM manager. The new launcher
contains no literal `/root` or `/home` path. Its repository, worktree, prompt,
log, Bun, Codex, HOME, and TMPDIR inputs are derived or parameterized.

## Blocking finding: the regression lock does not bite

I repeated the fresh-clone test after deleting only the launcher's marker-gate
call in that disposable clone:

```sh
sed -i '/bash "\$repo\/orchestrator\/dispatch-lane.sh" "\$prompt"/d' \
  "$tmp/repo/orchestrator/fleet/launch-lane.sh"
env -i HOME="$tmp/home" PATH="/usr/local/bin:/usr/bin:/bin" \
  BUN_BIN=/usr/local/bin/bun \
  bash "$tmp/repo/orchestrator/fleet/launch-lane.test.sh"
```

Output:

```text
compose: wrote 9 docs + 0 interim to /tmp/tmp.EDiFL59Gq7/lanes/pack-proof
launch-lane dispatch proof: PASS
MUTATION_RESULT=PASS_WITH_MARKER_GATE_REMOVED
```

This is a false-green regression lock. The test never supplies a marker-less
prompt and never proves that `systemd-run` remains untouched when the marker
gate refuses dispatch. Therefore it does not lock requirement 2.

The test also does not actually execute a lane payload: its `systemd-run` mock
only writes its argument strings and exits 0, while the fake `codex` executable
has no observable side effect and is never invoked. Assertions on the recorded
argv do not satisfy the explicit requirement that the test actually dispatch
something.

## Fail-open and rollback posture

The production ordering is gate, worktree creation, then SYSTEM-unit submission,
which is fail-closed in the implementation itself. A failed `systemd-run` keeps
the worktree for diagnosis and exits non-zero. No secret-like material or
out-of-scope changed path was found in the reviewed diff.

However, because the executable lock passes when the decisive marker gate is
removed, future bypass of that gate would be reported green. This evidence-gate
false open is blocking. Rollback is the removal/revert of the three-path coder
commit; no persistent migration or data mutation is involved.

## Required disposition

Add a lock that (1) injects a marker-gate refusal or marker-less/tampered prompt,
(2) proves the system manager boundary and Codex payload are not invoked on
refusal, (3) executes an observable payload through the mocked SYSTEM manager on
success, and (4) demonstrates red-before/green-after against the relevant fix.
Then request a new independent review of the replacement SHA.
