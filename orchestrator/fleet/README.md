# Fleet lane launcher

This directory exists because these files were running the entire parallel lane
fleet from a **temporary directory** and would have been lost on a re-clone. That
violates Hard Floor 5 (`instructions/reproducible-from-git.md`): a mechanism that
lives only on the host is already a regression.

`launch-lane.sh` is the supported, parameterized entry point. The `as-run-*.sh`
files are retained only as historical evidence of the 2026-07-31 fleet waves;
they are host-bound transcripts and are superseded by this mechanism.

## Launch one lane

Write the mission body to a file, then run:

    orchestrator/fleet/launch-lane.sh \
      --name my-mission --role coder --task-file /path/to/task.md

The default source repository is derived from the script location, the default
worktree branch is `ag-<name>` at `origin/main`, and artifacts go below
`${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes`. Use `--repo`, `--lanes-dir`,
`--base`, or `--branch` to override those inputs. Run `--help` for the complete
interface.

The launcher resolves Bun through `BUN_BIN`, then `$HOME/.bun/bin/bun`, then
`PATH`, using `orchestrator/lib.sh`. A fresh host therefore gets Bun from the
documented `bootstrap/install.sh` step; no interactive shell profile is needed.
Codex is resolved through `--codex-bin`, `CODEX_BIN`, or `PATH` and fails closed
when absent.

## What the entry point does

Four steps, in order:

1. **Compose the role context pack** — never hand-assemble a prompt:

       "$BUN_BIN" tools/instructions/compose.ts --role <coder|reviewer|orchestrator|manager> \
         --repo <repo> --out <packdir>

2. **Build the prompt** as the pack preamble followed by the task body. The
   preamble carries the `<!-- compose.ts pack v1 role=... l1=<sha> -->` marker.

3. **Pass the marker gate** — fail-closed; refuses any prompt without the marker:

       bash orchestrator/dispatch-lane.sh <prompt-file>

4. **Create a branch and isolated worktree**, then run Codex as a transient
   SYSTEM unit. Unit output is appended to the reported `lane-<name>.log` path.

       systemd-run --collect --unit lane-<name> ...

## Host facts that are easy to get wrong

- **`systemd-run --user` DOES NOT WORK here** — root has no user bus on this
  host (`Failed to connect to bus: No medium found`), and it fails *silently*
  inside a script that redirects stderr. Lanes must be SYSTEM transient units.
  A system unit also sits outside the telegram-daemon cgroup, so lanes survive
  both an orchestrator relaunch and a daemon restart. This contradicts
  `bootstrap/install.sh`, which still renders `systemd --user` units —
  `ag-onboarding-truth` owns reconciling that.
- **Worktrees**, one per lane, live under `/root/.cache/infra-lanes/`. Reviews
  use `--detach` so a reviewer cannot move the branch.
- **`local a="$1" b="$X/$a"` is a trap**: bash expands `$a` before it exists, so
  under `set -u` the function dies and, with output redirected, takes the rest of
  the wave with it silently. Split the declarations.
- **Never pipe a `git` command into `tail` inside an `&&` chain** — the pipeline
  exit status becomes `tail`'s, so a failed merge or push reports success.
- **Never run `git merge` from inside a lane worktree.** Git merges the branch
  into itself, reports success, and main never moves — work then gets reported as
  landed when it is not. This happened THREE times on 2026-07-31 and was caught
  each time only by re-reading the resulting SHA. `land-branch.sh` now makes it
  impossible: it refuses to run outside the canonical checkout, and fails if HEAD
  did not move or origin/main does not match after the push.

## Files

| file | what it is |
| --- | --- |
| `launch-lane.sh` | supported portable one-lane dispatch entry point |
| `land-branch.sh` | landing guard — refuses worktree merges, silent no-ops, and unpushed "landed" claims |
| `launch-lane.test.sh` | real compose/gate/worktree dispatch proof with a mocked system manager boundary |
| `as-run-*.sh` | superseded, host-bound historical wave evidence |
| `fleet-nudge.sh` | STOPGAP watchdog — wakes the orchestrator when lanes fall below floor while the workboard has open rows; asks the Human when the board is empty or the orchestrator is down |
| `orch-fleet-nudge.service` / `.timer` | systemd units for the above (installed to `/etc/systemd/system/`, 10-minute interval) |

`fleet-nudge.sh` is explicitly temporary: ML-2 (`ag-ml2-autonomy-keepalive`)
moves this inside the daemon, event-driven plus timer-backed. Remove the units
once ML-2 is deployed.

## Installing the nudge watchdog on a fresh host

    install -m 755 orchestrator/fleet/fleet-nudge.sh /root/.local/bin/orch-fleet-nudge.sh
    install -m 644 orchestrator/fleet/orch-fleet-nudge.service /etc/systemd/system/
    install -m 644 orchestrator/fleet/orch-fleet-nudge.timer   /etc/systemd/system/
    systemctl daemon-reload && systemctl enable --now orch-fleet-nudge.timer
    systemctl list-timers orch-fleet-nudge.timer   # verify
