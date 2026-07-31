# Independent review — ag-fleet-idle-check

consumed:
- review-policy sha256:b95d6eb6d0e5 # Review Policy
- verification-and-locks sha256:b13ed13070c1 # Verification and Regression Locks
- roles sha256:cd4c40c4e640 # Roles
- instruction-layers sha256:f9a51936be92 # Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd # Tool Permissions

reviewer: Codex reviewer lane `lane-review-fleet-idle`
independence: independent session; did not author the reviewed branch
tier: Tier A — evidence-gate logic
reviewed-sha: 8e9ccff01e14ce1671ef35dc6d4f571889ad3b5c
reviewed-diff: `origin/main...8e9ccff01e14ce1671ef35dc6d4f571889ad3b5c`
verdict: REJECT

## Scope and evidence inspected

Reviewed:

- `instance/params.yaml`
- `tools/state-contract/check.ts`
- `tools/state-contract/check.test.ts`
- `/root/.cache/infra-lanes/ag-fleet-idle-check.report.md`
- `instance/workboard.md`
- `instance/decisions/HR-281.md`

The coder's `result: NO-GO` is honest caution about the mandatory independent
review. It is not itself evidence of a functional defect.

## Commands and results

Exact reviewed SHA and diff:

```sh
git rev-parse HEAD
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- instance/params.yaml tools/state-contract/check.ts tools/state-contract/check.test.ts
```

Result: HEAD was
`8e9ccff01e14ce1671ef35dc6d4f571889ad3b5c`; the reviewed diff changed only the
three listed files.

Host lane discovery:

```sh
systemctl list-units 'lane-*.service' --type=service --state=running --no-legend --no-pager --plain
```

Result: exit 0 and five running `lane-*` system services, including this review
lane. The implementation invokes system `systemctl`; it does not use or assume
a user bus.

Idle-fleet reproduction used a PATH-scoped review fixture named `systemctl`
which exited 0 with no output:

```sh
REVIEW_PATH="$PWD/.review-bin:$PATH"
PATH="$REVIEW_PATH" REVIEW_SYSTEMCTL_MODE=idle bun tools/state-contract/check.ts .
```

Result: exit 1:

```text
FAIL FLEET-IDLE: 24 open workboard row(s), 0 running lane unit(s)
```

Unavailable lane-state reproduction used the same fixture exiting 1 with
`review fixture: system bus unavailable` on stderr:

```sh
PATH="$REVIEW_PATH" REVIEW_SYSTEMCTL_MODE=unavailable bun tools/state-contract/check.ts .
```

Result: exit 1:

```text
FAIL FLEET-IDLE: 24 open workboard row(s), running lane unit(s) unknown/degraded: system systemctl exited 1: review fixture: system bus unavailable
```

Tests and live checker:

```sh
bun test tools/state-contract/check.test.ts
bun tools/state-contract/check.ts .
```

Result: tests exited 0 with 16 pass, 0 fail, 46 expectations. The live checker
exited 0 with 29 artifacts, 0 FAIL, and 3 declared gaps while five system lane
units were running.

## Blocking finding

`tools/state-contract/check.ts` fails open for a readable but empty
`instance/workboard.md`.

The read succeeds and assigns the empty string to `workboardSource`. The CLI
then guards the fleet check with:

```ts
if (workboardSource) {
  // checkFleetIdle(...)
}
```

Therefore an empty workboard skips `checkFleetIdle` entirely and emits no
`FLEET-IDLE` finding. The helper itself would correctly treat the missing
`## Open` section as degraded, but the CLI prevents the helper from seeing this
input. This is the mission's highest-priority defect class: the checker silently
passes when it cannot determine whether work is open.

The new test exercises `checkFleetIdle` directly, so it cannot detect this CLI
fail-open branch. Add a CLI regression lock using an empty readable workboard,
prove it fails before the fix, and require non-zero exit plus a
`FLEET-IDLE ... unknown/degraded` finding after the fix.

## Additional consistency finding

`instance/params.yaml` now claims this enforcement is active, but the binding
`instance/decisions/HR-281.md` enforcement section still says “not yet landed”
and still names `planned:ag-fleet-idle-check`. Update the routed binding text
when the functional fix is ready so the repository does not carry contradictory
status claims.

## Rollback and disposition

Do not land reviewed SHA
`8e9ccff01e14ce1671ef35dc6d4f571889ad3b5c`. No production/runtime mutation was
performed during review. The PATH fixture was local to the review worktree and
removed before commit. Fix the empty-readable-workboard fail-open path, add the
CLI regression lock with red-before/green-after evidence, reconcile the binding
decision status, and request independent review of the new SHA.
