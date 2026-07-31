# Independent review — ag-fleet-idle-check

consumed:
- review-policy sha256:b95d6eb6d0e5 # Review Policy
- verification-and-locks sha256:b13ed13070c1 # Verification and Regression Locks
- roles sha256:cd4c40c4e640 # Roles
- instruction-layers sha256:f9a51936be92 # Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd # Tool Permissions

reviewer: Codex reviewer lane `lane-rev-ag-fleet-idle-check`
independence: independent session; did not author the coder commits
tier: Tier A — evidence-gate logic
reviewed-sha: 70d862c0a77defed3cb3b3873ce7b4272f64aa20
reviewed-diff: `origin/main...70d862c0a77defed3cb3b3873ce7b4272f64aa20`
verdict: ACCEPT

## Scope and claims

The two coder titles are accurate: `12198baf` adds the open-work/zero-lane
failure and `70d862c0` closes the empty-readable-workboard bypass. The intervening
review commit records the earlier rejection; this report supersedes that verdict
for the corrected SHA. Changed implementation scope is limited to the fleet
instance fact, its binding Human decision, and the state-contract checker/tests.

No blocking finding remains. The checker fails closed when the workboard cannot
be read or parsed, when system lane state cannot be queried or parsed, and when
open rows coexist with zero running lanes. `instance/params.yaml` and
`instance/decisions/HR-281.md` now consistently name the active enforcement.

## Commands and actual output

```sh
git rev-parse HEAD
git log --oneline origin/main..HEAD
git diff --name-status origin/main...HEAD
```

Output identified reviewed HEAD
`70d862c0a77defed3cb3b3873ce7b4272f64aa20`, the two coder commits and prior
review commit, and these paths: `instance/decisions/HR-281.md`,
`instance/params.yaml`, `reports/ag-fleet-idle-check.review.md`,
`tools/state-contract/check.test.ts`, and `tools/state-contract/check.ts`.

```sh
bun test tools/state-contract/check.test.ts
```

Output (exit 0):

```text
(pass) FLEET-IDLE locks open work against the measured system lane fleet
(pass) CLI fails closed when the readable workboard is empty
...
17 pass
0 fail
48 expect() calls
Ran 17 tests across 1 file. [157.00ms]
```

```sh
bun tools/state-contract/check.ts .
```

Output (exit 0) contained the three declared `GAP` records and ended:

```text
29 artifacts declared, 0 FAIL, 3 known gap(s)
```

```sh
(cd daemon && bunx tsc --noEmit)
git diff --check origin/main...HEAD
```

Both commands exited 0 with no output.

```sh
systemctl list-units 'lane-*.service' --type=service --state=running \
  --no-legend --no-pager --plain
```

Output (exit 0): seven running `lane-*.service` units, including
`lane-rev-ag-fleet-idle-check.service`. This confirms the checker is exercising
the system service manager used by the live lane fleet.

## Regression red-before / green-after

I created a disposable detached worktree at reviewed HEAD, restored only
`tools/state-contract/check.ts` from pre-fix commit `4f6058f5`, retained the new
test, and ran:

```sh
bun test "$review_tmp/tools/state-contract/check.test.ts" \
  --test-name-pattern 'CLI fails closed when the readable workboard is empty'
```

Pre-fix output (exit 1):

```text
Expected to contain: "FAIL FLEET-IDLE: open workboard row count unknown/degraded: instance/workboard.md has no ## Open section"
Received: "FAIL state.db: declared in the registry but referenced by no source file\n...\n29 artifacts declared, 32 FAIL, 0 known gap(s)\n"
(fail) CLI fails closed when the readable workboard is empty
0 pass
16 filtered out
1 fail
FAIL_BEFORE_EXIT=1
```

The received output lacks `FLEET-IDLE`, reproducing the silent bypass. At the
reviewed SHA the full test command above passes the same lock. The disposable
worktree was then removed.

## Secrets, rollback, and disposition

The canonical diff signature scan reported no hit. No credential material or
out-of-scope runtime mutation was found. Rollback is the ordinary revert of the
two coder commits; no persistent service, data, dependency, or schema mutation
was performed. The known unrelated `dispatch-check` CI failure was excluded as
directed and was not used as positive evidence.

blockers: none
