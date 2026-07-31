# Independent review: ag-ml1-alarm-classes

verdict: REJECT
reviewed-sha: ce836d577f2ddefd10ddf57639402808a9dd96d4
independence: Independent Codex reviewer session; I did not author either coder commit.
tier: Tier A — orchestrator core and alert/evidence delivery
diff: `git diff origin/main...ce836d577f2ddefd10ddf57639402808a9dd96d4`

## Consumption check

- review-policy sha256:b95d6eb6d0e5 — Review Policy
- verification-and-locks sha256:b13ed13070c1 — Verification and Regression Locks
- roles sha256:cd4c40c4e640 — Roles
- instruction-layers sha256:f9a51936be92 — Instruction Layers
- tool-permissions sha256:6c7b9f57fbbd — Tool Permissions

## Findings

1. **BLOCKER — the restored “internal” alert route is not restored.**
   `daemon/terminal-alert.ts:120-123` sends `X-BPA-Alarm-Audience: internal`,
   but the existing `/notify` handler at `daemon/server.ts:2670-2687` never
   reads that header and always calls `statusRelay(chat, text)`, the bound-Human
   outbound path. The historical implementation named by the workboard did
   read this header and routed internal alerts to the orchestrator. Thus the
   commit title overclaims restoration: it classifies eight classes, but sends
   them to the wrong audience. There is no integration test covering the real
   `/notify` boundary or asserting that an internal alert never invokes the
   Human sender.

2. **BLOCKER — classifier attachment fails open after `tmux pipe-pane` returns.**
   `orchestrator/launch.sh:369-376` checks only the synchronous `pipe-pane`
   return. A pipe command can start, fail immediately, and detach while launch
   remains successful. A real isolated tmux probe returned `pipe-pane exit=0`,
   then `pane_pipe=0` after 0.5 seconds for a missing executable. The test at
   `orchestrator/runtime.test.sh:96-100` uses a mock that merely records the
   command and cannot detect this failure. A missing/broken classifier can
   therefore silently disable all terminal alarms while the orchestrator is
   reported started.

3. **Missing coder evidence.** The requested coder terminal report is absent:
   the reviewed branch had no `reports/` directory before this review. This is
   independently blocking evidence under the lane lifecycle/report contract.

## Commands and actual output

Exact SHA and scope:

```sh
git status --short
git rev-parse HEAD
git log --oneline --reverse origin/main..HEAD
git diff --name-status origin/main...HEAD
```

Output before this report was authored:

```text
ce836d577f2ddefd10ddf57639402808a9dd96d4
fcefd63a [CODER] restore terminal failure alarm classes
ce836d57 [CODER] fail closed on rejected terminal alerts
A daemon/terminal-alert.test.ts
A daemon/terminal-alert.ts
M orchestrator/launch.sh
M orchestrator/runtime.test.sh
```

Narrow classifier suite:

```sh
cd daemon && bun test terminal-alert.test.ts
```

Output (exit 0):

```text
bun test v1.2.22 (6bafe260)
13 pass
0 fail
15 expect() calls
Ran 13 tests across 1 file. [38.00ms]
```

Launcher runtime suite, without and with its documented trust override:

```sh
cd orchestrator && ./runtime.test.sh
ORCH_SKIP_TRUST_CHECK=1 ./runtime.test.sh
```

Output (first exit 1, second exit 0):

```text
ERROR orchestrator-workdir-untrusted dir=/root/.cache/infra-lanes/ag-ml1-alarm-classes/orchestrator config=/root/.codex/config.toml
FAIL: /root/.cache/infra-lanes/ag-ml1-alarm-classes/orchestrator/launch.sh start

SKIP state-db-absent path=.../state/state.db
started: test-orch (codex)
session already exists: test-orch
...
runtime tests: PASS
```

The override isolates the reviewed behavior from this checkout's trust policy;
the unmodified declared command is not green on this host.

Full daemon suite:

```sh
cd daemon && bun test
```

This did not reach a terminal summary and left `bun test` running after its
test HTTP server started. Its partial passing output is not counted as green.
The mission's known `dispatch-check` CI exclusion was not investigated or used
as evidence.

## Regression red-before / green-after

I created a disposable detached worktree at pre-fix commit `fcefd63a`, restored
only the current `daemon/terminal-alert.test.ts`, and ran:

```sh
cd "$review_tmp/daemon" && bun test terminal-alert.test.ts
```

Pre-fix output (exit 1):

```text
SyntaxError: Export named 'relayTerminalAlert' not found in module '.../daemon/terminal-alert.ts'.
0 pass
1 fail
1 error
Ran 1 test across 1 file. [40.00ms]
```

At reviewed HEAD the same test file passes 13/13 as shown above. The delivery
rejection lock therefore bites across the second commit, but it tests a mocked
fetch only and does not cover either blocking real-boundary failure.

## Fail-open reproduction

```sh
tmux -L "$sock" new-session -d -s probe \
  'for i in 1 2 3; do echo tick; sleep 0.2; done; sleep 30'
tmux -L "$sock" pipe-pane -o -t probe \
  'exec /definitely/missing/terminal-alert'
# inspect #{pane_pipe} after 0.1s, 0.5s, and 1s
```

Real output:

```text
pipe-pane exit=0
after_0.1s pane_pipe=1
after_0.5s pane_pipe=0
after_1s pane_pipe=0
```

The disposable tmux server and pre-fix worktree were removed.

## Secrets, scope, rollback

Changed implementation paths are within the ML-1 feature area, and no
dependency, schema, or persistent-data migration is present. Rollback is a Git
revert of the two coder commits. The canonical signature scan over
`origin/main...HEAD` produced no matches.

secret-scan: clean

blockers: `daemon/terminal-alert.ts:120`, `daemon/server.ts:2670`,
`orchestrator/launch.sh:369`, `orchestrator/runtime.test.sh:96`, and missing coder
terminal report.
