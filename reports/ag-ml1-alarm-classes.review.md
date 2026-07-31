# Independent review: ag-ml1-alarm-classes

verdict: ACCEPT
reviewed-sha: 46c0f491617ddbcb40794812f9c17fb7709221e7
independence: Independent Codex reviewer session; I did not author the coder commits.
tier: Tier A — orchestrator core, terminal alarm routing, and fail-closed readiness
diff: `git diff origin/main...46c0f491617ddbcb40794812f9c17fb7709221e7`

## Consumption check

- review-policy sha256:b95d6eb6d0e5 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions
- reproducible-from-git sha256:822d9efe694b — Reproducible From Git

## Findings and disposition

No blocking finding remains. The two prior blockers are closed at the reviewed
SHA: failure-looking lines outside the eight declared patterns route as
`unknown`, while ordinary output remains ignored; and the external `/notify`
path has a live HTTP-boundary lock proving that it invokes only the Human
sender.

Fail-open review found affirmative failure handling at the relevant boundaries:
non-2xx `/notify` responses throw and are not entered into the delivered dedup
set; unavailable internal delivery returns HTTP 502; and launch requires both a
live tmux pipe and classifier readiness file, otherwise it kills the new session
and returns failure. Scope matches the claim. No dependency, schema, migration,
persistent-data, or production deployment change is present. Rollback is a Git
revert of the coder chain; there is no data rollback.

## Exact counts reproduced

Command:

```sh
sed -n '/export type TerminalFailureClass =/,/;/p' daemon/terminal-alert.ts | rg -o "'[^']+'" | rg -v "'unknown'"
sed -n '/const FAILURE_PATTERNS/,/^];/p' daemon/terminal-alert.ts | rg -o "kind: '[^']+'"
sed -n '/test.each(\[/,/^] as const)/p' daemon/terminal-alert.test.ts | rg "^[[:space:]]+\["
rg "test\('REGRESSION ML-1" daemon/*.test.ts
```

Real output and counts:

```text
'usage-limit'
'429/overload'
'auth'
'stalled'
'failed'
'exited'
'network'
'fatal'
declared_count=8

kind: 'usage-limit'
kind: '429/overload'
kind: 'auth'
kind: 'stalled'
kind: 'failed'
kind: 'exited'
kind: 'network'
kind: 'fatal'
pattern_count=8

["You've hit your limit · resets 3pm", 'usage-limit']
['API request failed: 429 Too Many Requests', '429/overload']
['Authentication failed: invalid session', 'auth']
['agent stalled: no progress for 600s', 'stalled']
['Agent "worker-2" failed: command returned 1', 'failed']
['[watchdog] Claude exited (code 1)', 'exited']
['network error: ECONNRESET', 'network']
['fatal error: uncaught exception', 'fatal']
fixture_count=8

REGRESSION ML-1: quota exhaustion is quota and never a stall
REGRESSION ML-1: an unclassified terminal failure remains actionable
REGRESSION ML-1: a rejected notify response is a delivery failure
REGRESSION ML-1: classifier proves process readiness to its launcher
REGRESSION ML-1: external /notify invokes the Human sender
lock_count=5
```

## Green at reviewed SHA

Command:

```sh
(cd daemon && bun test notify-handler.test.ts terminal-alert.test.ts && bun run typecheck) && (cd orchestrator && ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh) && git diff --check origin/main...HEAD
```

Real output summary, exit 0:

```text
(pass) REGRESSION ML-1: external /notify invokes the Human sender
(pass) REGRESSION ML-1: quota exhaustion is quota and never a stall
(pass) REGRESSION ML-1: an unclassified terminal failure remains actionable
(pass) REGRESSION ML-1: a rejected notify response is a delivery failure
(pass) REGRESSION ML-1: classifier proves process readiness to its launcher
18 pass
0 fail
29 expect() calls
Ran 18 tests across 2 files.
$ bunx tsc --noEmit
ERROR terminal-alert-not-ready session=test-orch
ERROR terminal-alert-not-ready session=test-orch
runtime tests: PASS
```

The two error lines are asserted negative fixtures: one detached pipe and one
classifier that never creates its readiness file. Both leave no running session.

## Red-before / green-after regression evidence

Each reviewed test was retained unchanged in a disposable detached worktree
while its implementation fix was reverted (or, for the initial feature commit,
the unchanged test was run against its pre-fix parent). Actual red results:

```text
quota/classes, pre-fix parent 26b7f6d:
error: Cannot find module './terminal-alert'
0 pass
1 fail
1 error
exit=1

rejected response, reverted a7da06e:
SyntaxError: Export named 'relayTerminalAlert' not found
0 pass
1 fail
1 error
exit=1

readiness, reverted 0b003e8:
Expected: true
Received: false
(fail) REGRESSION ML-1: classifier proves process readiness to its launcher
0 pass
1 fail
daemon_exit=1
FAIL: terminal alert pipe did not carry its readiness handshake path
runtime_exit=1

unknown failure, reverted 0c73aa6:
Expected: "unknown"
Received: null
0 pass
1 fail
unknown_exit=1

external routing, reverted 0c73aa6:
SyntaxError: Export named 'classifyNotifyAudience' not found
0 pass
1 fail
1 error
external_exit=1
```

Restoring the reviewed implementation produced the `18 pass / 0 fail` green
run above. The locks therefore fail before and pass after; none passes both ways.

## Secret scan

The canonical pattern extracted from `gate/land-lib.sh` was run against
`git diff origin/main...HEAD`; it produced no matches.

secret-scan: clean

blockers: none
