# Independent review — ag-ml2-autonomy-keepalive

reviewer: Codex reviewer lane `ag-ml2-autonomy-keepalive` (independent of coder)
independence: independent reviewer session; this reviewer did not author the implementation commit
tier: Tier A — daemon/orchestrator core and fail-closed evidence/runtime guarantee
reviewed-sha: 60a5d96624563a7dee0d7fea2fd45d95a9172853
base-sha: 62eb1717b068895fa60dc2ed918581689a587b03 (`origin/main`)
diff: `git diff origin/main...HEAD`
verdict: REJECT

## Manifest consumption check

```text
review-policy sha256:b95d6eb6d0e5 # Review Policy
verification-and-locks sha256:b13ed13070c1 # Verification and Regression Locks
roles sha256:cd4c40c4e640 # Roles
instruction-layers sha256:f9a51936be92 # Instruction Layers
tool-permissions sha256:6c7b9f57fbbd # Tool Permissions
```

## Findings

1. **BLOCKER — the event-level path silently consumes a failed delivery.**
   `daemon/server.ts:1515-1525` returns normally both when tmux is unavailable
   and when `tmuxPasteText()` returns `false`. `daemon/autonomy-keepalive.ts:67-73`
   consequently advances `previousRunning` after that unresolved delivery. On
   the next poll the stopped lane is no longer a transition, so the event nudge
   is never retried. This is a fail-open result: the checker cannot establish
   delivery, logs `deferred`/`failed`, then commits the event as handled. Make
   delivery failure reject (or return an acknowledged boolean) and retain a
   pending transition until acknowledged; add red/green coverage for both tmux
   unavailable and paste-false cases.

2. **BLOCKER — the implementation and instance claim do not restore the ML-2
   capability described by the source row.** `instance/workboard.md:104-108`
   identifies four lost push paths: hourly compact, 15-minute fleet ping,
   maintenance audit, and per-message reply chase. The diff implements only a
   fleet timer and lane-exit watcher, while `instance/params.yaml:56-58` changes
   the state from planned to an unqualified implemented/enforced value and the
   commit title claims to restore the keep-alive nudges. Either implement and
   lock the full stated ML-2 scope, or narrow the title/state and leave explicit
   open rows for the missing paths. As written, the claim overstates the diff.

3. **Evidence discrepancy — coder report is stale.** The coder terminal report
   names `968fbc8a632856818e457e21eb9c854b0c030fdb`, whereas the exact reviewed
   commit is `60a5d96624563a7dee0d7fea2fd45d95a9172853`. The implementation files are
   present after rebasing, but the report contract requires current-SHA evidence;
   therefore the coder's report cannot support a clean result for this SHA.

## Commands and observed output

### Exact commit and scope

```text
$ git log --oneline --decorate -2
60a5d966 (HEAD -> ag-ml2-autonomy-keepalive) [CODER] restore autonomy keep-alive nudges
62eb1717 (origin/main, origin/HEAD, main) [ORCH] HR-302: read operator profanity as "what is stopping you?"

$ git diff --name-status origin/main...HEAD
A daemon/autonomy-keepalive.test.ts
A daemon/autonomy-keepalive.ts
M daemon/server.ts
M instance/params.yaml

$ git diff --check origin/main...HEAD
[no output; exit 0]
```

### Targeted green run at reviewed SHA

```text
$ cd daemon && bun test autonomy-keepalive.test.ts
bun test v1.2.22 (6bafe260)

autonomy-keepalive.test.ts:
(pass) fleet config reads floor and interval with a 15-minute default
(pass) system lane census uses SYSTEM systemd unit state
(pass) REGRESSION ML-2: timer nudges with open rows and zero running lanes
(pass) dirty-dead lane with no exit event is still caught by timer level
(pass) event level nudges once when a running lane exits
(pass) closed-only workboard and a full fleet stay quiet

 6 pass
 0 fail
 10 expect() calls
Ran 6 tests across 1 file.
```

### Regression mutation: RED before, GREEN after

For the RED run only, `AutonomyKeepalive.timerTick()` was temporarily changed
to the pre-fix no-op behavior. The change was then restored byte-for-byte and
`git diff -- daemon/autonomy-keepalive.ts` was empty.

```text
$ cd daemon && bun test autonomy-keepalive.test.ts --test-name-pattern 'REGRESSION ML-2'
Expected length: 1
Received length: 0
(fail) REGRESSION ML-2: timer nudges with open rows and zero running lanes

 0 pass
 5 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [41.00ms]
[exit 1]

$ git diff --check && git diff -- daemon/autonomy-keepalive.ts && \
  bun test autonomy-keepalive.test.ts --test-name-pattern 'REGRESSION ML-2'
(pass) REGRESSION ML-2: timer nudges with open rows and zero running lanes

 1 pass
 5 filtered out
 0 fail
 2 expect() calls
Ran 1 test across 1 file. [60.00ms]
[exit 0]
```

The named timer regression is therefore a genuine lock. It does not cover the
failed-delivery blocker above.

### Typecheck and broader test execution

```text
$ cd daemon && bun run typecheck
$ bunx tsc --noEmit
[exit 0]

$ cd daemon && bun test autonomy-keepalive.test.ts control.test.ts \
  inbound-media-pipeline.test.ts mission-source.test.ts \
  model-command-wiring.test.ts vendor-login.test.ts
...
 55 pass
 0 fail
 226 expect() calls
Ran 55 tests across 6 files. [10.79s]
[exit 0]
```

`cd daemon && bun test` itself returned exit 0 but emitted no final aggregate
and stopped its visible output during `transcribe.test.ts`; it did not show the
new autonomy test. I therefore do not treat that invocation as complete suite
evidence and used explicit test-file invocations for the reviewed lock. This is
not the known excluded `dispatch-check` CI failure.

### Live census boundary

```text
$ systemctl list-units --all --type=service 'lane-*' --no-legend --plain --no-pager
lane-ag-ci-dispatch-gate.service           loaded active running ...
lane-fix-ml4-isolation.service             loaded active running ...
lane-rev-ag-ml1-alarm-classes.service      loaded active running ...
lane-rev-ag-ml10-delivery-fallback.service loaded active running ...
lane-rev-ag-ml2-autonomy-keepalive.service loaded active running ...
lane-rev-ag-w16-count-provenance.service   loaded active running ...
exit=0
```

This confirms the system-level census command matches real host units. No live
daemon delivery/acknowledgement evidence was supplied or established.

## Secret scan

Command:

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
test -n "$pat"
git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"
```

Output/result:

```text
[no matches; grep exit 1]
secret-scan: clean
```

## Rollback and landing posture

Rollback is mechanically narrow (the four changed paths), but landing is
blocked. Do not land until failed delivery remains pending/retriable, the
missing ML-2 scope is truthfully dispositioned, and the corrected exact SHA has
fresh Tier-A review evidence.
