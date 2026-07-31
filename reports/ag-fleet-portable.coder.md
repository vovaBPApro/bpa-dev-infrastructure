# Fleet portable coder report

commit: 6f98b01e26ef4d64f044c08e0dfffa6d6e3e5240 [CODER] Lock fleet launcher marker refusal
verify: bash orchestrator/fleet/launch-lane.test.sh && git diff --check origin/main...HEAD
result: NO-GO
blocker: Tier A fleet/evidence-gate change requires independent re-review of replacement SHA 6f98b01e26ef4d64f044c08e0dfffa6d6e3e5240
secret-scan: clean
remaining: independent re-review and landing

## Regression lock

FAIL-BEFORE used the replacement test with only the production marker-gate call
removed from `launch-lane.sh` in a disposable clone. Real output:

```text
compose: wrote 9 docs + 0 interim to /root/.cache/lane-tmp/tmp.ARzVJfIhML/lanes/pack-proof
marker-gate refusal incorrectly dispatched the lane
FAIL_BEFORE_EXIT=1
```

PASS-AFTER at the implementation SHA used the quoted `verify:` command. Real
test output:

```text
compose: wrote 9 docs + 0 interim to /root/.cache/lane-tmp/tmp.hmyW1KOcyk/lanes/pack-proof
launch-lane dispatch proof: PASS
PASS_AFTER_EXIT=0
```

The refusal scenario injects a real `dispatch-check.ts` rejection and asserts
that no worktree, mocked SYSTEM manager call, or Codex payload exists. The
success scenario's mocked SYSTEM manager executes the submitted shell payload;
the fake Codex executable records its arguments and creates an observable file.

## Manifest consumption

```text
lane-lifecycle 84d3db25d785 — Lane Lifecycle
verification-and-locks b13ed13070c1 — Verification and Regression Locks
tool-permissions 6c7b9f57fbbd — Tool Permissions
repository-hygiene 8b21c6129e5c — Repository Hygiene
isolated-test-environments d0c2162eeba5 — Isolated Test Environments
operator-feedback 82d309b667eb — Operator Feedback
instruction-layers f9a51936be92 — Instruction Layers
branching-policy dbe7ace1193b — Branching Policy
reproducible-from-git 822d9efe694b — Reproducible From Git
```
