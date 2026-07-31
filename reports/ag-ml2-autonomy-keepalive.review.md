# Independent review — ag-ml2-autonomy-keepalive

reviewer: Codex reviewer lane `ag-ml2-autonomy-keepalive`
independence: independent reviewer session; reviewer did not author the implementation
tier: Tier A — orchestrator core and fail-closed delivery
reviewed-sha: a6ed8eeeadd258e176213c6d2e089aee4a40cbba
base-sha: 62eb1717b068895fa60dc2ed918581689a587b03 (`origin/main`)
diff: `git diff origin/main...a6ed8eeeadd258e176213c6d2e089aee4a40cbba`
verdict: ACCEPT

## Manifest consumption check

```text
review-policy sha256:b95d6eb6d0e5 # Review Policy
verification-and-locks sha256:b13ed13070c1 # Verification and Regression Locks
roles sha256:cd4c40c4e640 # Roles
instruction-layers sha256:f9a51936be92 # Instruction Layers
tool-permissions sha256:6c7b9f57fbbd # Tool Permissions
reproducible-from-git sha256:822d9efe694b # Reproducible From Git
```

## Findings and prior-blocker disposition

1. **Fail-open delivery: closed.** `deliverAutonomyNudge()` rejects both when
   tmux is unavailable and when paste returns false. `eventTick()` advances
   `previousRunning` only after the awaited delivery succeeds, so either reject
   retains the prior running census and retries the pending exit on the next
   tick. Both cases have independent red/green locks below.
2. **Overclaiming: closed by accurate narrowing.** The implementation provides
   the configured 15-minute fleet-floor nudge and an acknowledged lane-exit
   nudge. `instance/workboard.md` says exactly that and explicitly leaves hourly
   `/compact`, maintenance audit, and per-message reply chase open. The coder
   commit title is correspondingly narrow. `instance/params.yaml` configures
   only the implemented timer interval.
3. **Boundary checks: acceptable.** The added path pastes only into the
   orchestrator tmux session. It has no restart/kill action and adds no Telegram
   or Human notification. Census and workboard errors reject/log rather than
   manufacturing success. Delivery success is acknowledged by the existing
   boolean `tmuxPasteText` boundary.
4. **Scope/rollback:** the diff is limited to the keepalive runtime/test,
   daemon wiring, truthful instance configuration/workboard state, and this
   review record. Rollback is the narrow revert of the implementation commit.

## Reproduced commands and output

Exact commit and changed paths:

```text
$ git rev-parse HEAD
a6ed8eeeadd258e176213c6d2e089aee4a40cbba

$ git diff --name-status origin/main...HEAD
A daemon/autonomy-keepalive.test.ts
A daemon/autonomy-keepalive.ts
M daemon/server.ts
M instance/params.yaml
M instance/workboard.md
A reports/ag-ml2-autonomy-keepalive.review.md

$ git diff --check origin/main...HEAD
[no output; exit 0]
```

Green lock and nearby control tests:

```text
$ cd daemon && bun test autonomy-keepalive.test.ts control.test.ts
12 pass
0 fail
24 expect() calls
Ran 12 tests across 2 files. [39.00ms]

$ cd daemon && bun run typecheck
$ bunx tsc --noEmit
[exit 0]
```

System census count, reproduced rather than copied:

```text
$ systemctl list-units --all --type=service 'lane-*' --no-legend --plain --no-pager | wc -l
5
```

## Required fail-before / pass-after evidence

For the RED runs only, the awaited event nudge was temporarily changed to
swallow its rejection (`.catch(() => {})`), reproducing the pre-fix fail-open
behavior. The two locks were run separately:

```text
$ bun test autonomy-keepalive.test.ts --test-name-pattern 'tmux unavailable'
Expected promise that rejects
Received promise that resolved
0 pass
7 filtered out
1 fail
1 expect() calls
[exit 1]

$ bun test autonomy-keepalive.test.ts --test-name-pattern 'paste false'
Expected promise that rejects
Received promise that resolved
0 pass
7 filtered out
1 fail
1 expect() calls
[exit 1]
```

The exact implementation was restored (`git diff --exit-code --
daemon/autonomy-keepalive.ts` exited 0), then both locks passed:

```text
$ bun test autonomy-keepalive.test.ts --test-name-pattern 'tmux unavailable'
1 pass
7 filtered out
0 fail
3 expect() calls
[exit 0]

$ bun test autonomy-keepalive.test.ts --test-name-pattern 'paste false'
1 pass
7 filtered out
0 fail
2 expect() calls
[exit 0]
```

## Secret scan

```sh
pat=$(eval "$(sed -n 's/^[[:space:]]*secret_pattern=/REPLY=/p' gate/land-lib.sh)"; printf '%s' "$REPLY")
test -n "$pat"
git diff origin/main...HEAD | LC_ALL=C grep -aE "$pat"
```

Observed: no matches; grep exit 1. `secret-scan: clean`.

## Verdict

`ACCEPT`. Both prior blockers are closed at the reviewed SHA. Landing remains
the orchestrator's responsibility through the fail-closed gate.
