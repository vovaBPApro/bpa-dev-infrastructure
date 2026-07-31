# Independent review: ag-ml1-alarm-classes

verdict: REJECT
reviewed-sha: 26c2b003dba3488eec10c3bdc762e9a662e86571
independence: Independent Codex reviewer session; I did not author the coder commits.
tier: Tier A — orchestrator core, terminal alarm routing, and fail-closed readiness
diff: `git diff origin/main...26c2b003dba3488eec10c3bdc762e9a662e86571`

## Consumption check

- review-policy sha256:b95d6eb6d0e5 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Findings

1. **BLOCKER — unknown terminal failures disappear silently.** The mission
   requires an unclassified line to remain visible rather than be absorbed.
   `classifyTerminalFailure()` returns `null` for an unknown failure, and the
   live loop at `daemon/terminal-alert.ts:158` executes `if (!kind) continue`
   without emitting, recording, or routing anything. Reproduction:

   ```text
   $ bun -e "import { classifyTerminalFailure } from './daemon/terminal-alert.ts'; console.log(String(classifyTerminalFailure('Provider terminal failure: strange new condition')))"
   null
   ```

   This is the fail-open class called out by the mission: when classification
   cannot determine the truth, the line is silently treated as non-actionable.
   The existing `ignores ordinary terminal output` test does not cover an
   unknown failure-looking line or its live-loop visibility.

2. **BLOCKER — one historical routing lock was not preserved.** The requested
   historical file has three behaviors: explicit internal classification,
   internal never invokes the Human sender, and external invokes the Human
   sender. The new `daemon/notify-handler.test.ts` covers internal success and
   internal delivery failure, but has no external-to-Human test. The production
   branch appears to call `relayHuman` for non-internal requests, but the
   historical executable lock was regressed, so that behavior is no longer
   protected.

## Exact counts reproduced

Declared terminal failure classes:

```text
'usage-limit'
'429/overload'
'auth'
'stalled'
'failed'
'exited'
'network'
'fatal'
count=8
```

Pattern entries reproduced independently:

```text
kind: 'usage-limit'
kind: '429/overload'
kind: 'auth'
kind: 'stalled'
kind: 'failed'
kind: 'exited'
kind: 'network'
kind: 'fatal'
count=8
```

The fixture table also has 8 rows. Its realistic Claude quota line is:

```text
(pass) classifies You've hit your limit · resets 3pm as usage-limit
```

The mixed quota/stall precedence lock also passes:

```text
(pass) REGRESSION ML-1: quota exhaustion is quota and never a stall
```

Thus quota exhaustion is not classified as `stalled`; this portion is
accepted. The class vocabulary calls Claude usage exhaustion `usage-limit` and
API quota/rate exhaustion `429/overload` rather than using a literal `QUOTA`
enum.

## Green-at-reviewed-SHA evidence

Command:

```sh
(cd daemon && bun test notify-handler.test.ts terminal-alert.test.ts && bun run typecheck) && (cd orchestrator && ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh) && git diff --check origin/main...HEAD
```

Real output summary at the reviewed SHA (exit 0):

```text
16 pass
0 fail
23 expect() calls
Ran 16 tests across 2 files. [101.00ms]
$ bunx tsc --noEmit
ERROR terminal-alert-not-ready session=test-orch
ERROR terminal-alert-not-ready session=test-orch
runtime tests: PASS
```

The two error lines are asserted negative fixtures: launch kills a session when
the pipe detaches or the classifier never creates its readiness file.

## Red-before / green-after evidence

I copied the unchanged reviewed `terminal-alert.test.ts` into disposable
detached worktrees at each relevant pre-fix SHA. All three named regression
locks failed before their fixes and pass at the reviewed SHA.

Quota/classes, pre-fix `8ff4ec3` (exit 1):

```text
error: Cannot find module './terminal-alert'
0 pass
1 fail
1 error
```

Rejected notify response, pre-fix `a6c6281` (exit 1):

```text
SyntaxError: Export named 'relayTerminalAlert' not found
0 pass
1 fail
1 error
```

Classifier readiness, pre-fix `babd436` (exit 1):

```text
Expected: true
Received: false
(fail) REGRESSION ML-1: classifier proves process readiness to its launcher
13 pass
1 fail
```

The first two are feature-boundary reds because the pre-fix revisions do not
provide the imported implementation/export; the readiness lock is a direct
behavioral red. All corresponding tests are green in the 16/0 reviewed run.

## Historical behavior check

Command:

```sh
git show ffe05409:tools/claude-telegram-daemon/alarm-router.test.ts | rg '^test\\('
rg '^test\\(' daemon/notify-handler.test.ts
```

Real output:

```text
test('classifies only an explicit internal header as an orchestrator alarm', () => {
test('internal alarm never invokes the Human outbound sender', async () => {
test('external alarm invokes the Human outbound sender', async () => {
test('internal /notify reaches the orchestrator and never the Human relay', async () => {
test('internal /notify fails closed when orchestrator delivery fails', async () => {
```

Internal routing is preserved and strengthened with a real HTTP boundary test;
the external routing lock is missing.

## Secrets, scope, and rollback

The canonical `gate/land-lib.sh` pattern scan over
`git diff origin/main...HEAD` produced no matches: `secret_scan=clean`.
No dependency, schema, migration, or persistent-data change is present. Changed
implementation paths are relevant to alarm classification/routing/readiness;
the reports are mission evidence. Rollback is a Git revert of the coder commit
chain, but landing is blocked before rollback posture becomes operative.

secret-scan: clean

blockers: `daemon/terminal-alert.ts:158` silently absorbs unclassified
failure-looking lines; `daemon/notify-handler.test.ts` omits the historical
external-to-Human routing lock.
