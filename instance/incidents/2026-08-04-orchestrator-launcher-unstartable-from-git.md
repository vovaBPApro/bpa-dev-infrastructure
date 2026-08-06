# The orchestrator could not start from the repository, 2026-08-04

Recorded because this is the first measured, live failure of the meteorite test on the
mechanism the whole control plane depends on: **the launcher itself**. It was found by
recovery, not by any gate, and it is currently worked around by a file that is not in git.

## What happened

The orchestrator session died and did not come back. Every `/start_claude` and
`/start_codex` failed. Recovery (the previous orchestrator, operating under the
operator's direct order, Telegram 11986) found two independent blockers on `HEAD`
`eba098f` and unblocked the start **without changing any code**, by adding two lines to
`orchestrator/runtime.env`.

Both blockers were re-verified independently by the restarted orchestrator before this
record was written. Neither is a hypothesis.

### Blocker 1 — the launcher calls actions that were never implemented

`orchestrator/launch.sh` calls `mission_cli reap` (line 466) and
`mission_cli lease acquire|release` (lines 143, 173, 602). `core/mission-cli.ts`
implements none of them: its dispatch vocabulary is `mission | manager | lane | outbox |
status` (the usage string at `core/mission-cli.ts:111` is the whole contract). The call
therefore dies on `unknown action: reap`.

This did not fire on a fresh box, which is why it was never seen. The block is guarded by
`state_available()`, i.e. it runs only once the default `runtime/state.db` exists. A fresh
host has no such file, so the orchestrator started fine; **lane activity created it**, and
from that moment every start died. The regression was armed by ordinary successful work.

### Blocker 2 — the launcher requires a file that is not in the repository

`orchestrator/launch.sh` requires `$SCRIPT_DIR/preflight-cli-auth.sh`, the
subscription-only auth gate, and returns 2 when it is absent. **It is absent from the
tree and from `HEAD`.** It exists in history — last alive at `75411d9` (2026-08-02,
`[CODER] allow Claude CLI OAuth auto-refresh`) — and survives only inside `.cache` CI
clones on this host.

`git cat-file -e HEAD:orchestrator/preflight-cli-auth.sh` → `does not exist in 'HEAD'`.

## The part that matters most, and that recovery did not name

`orchestrator/runtime.env` is **gitignored** (`.gitignore:15`).

Both workarounds live in it:

- `ORCH_STATE_DB` → a deliberately absent path, so `state_available()` is false and the
  unimplemented `reap`/`lease` block is skipped, restoring the pre-regression start path.
- `ORCH_AUTH_PREFLIGHT` → `/root/oldorch-breakglass/preflight-cli-auth.sh`, a stable copy
  of the *same* subscription gate. Recovery deliberately did **not** point this at
  `/bin/true`; the no-API-keys protection is intact. That judgement was correct and is
  recorded here so a later cleanup does not undo it by accident.

So the orchestrator is running **only** because of two lines in an untracked file, which
point at a script in an untracked directory (`/root/oldorch-breakglass/`), standing in for
a file that is missing from git.

This is a Hard Floor 5 breach with a live blast radius, and it is not academic: it is
exactly the failure that would end the operator's cutover. Rebuilding this system on the
new server from the repository alone **cannot work today** — the launcher's required
auth gate is not in the repo, the `reap`/`lease` regression is still armed and will fire
as soon as lane activity creates a state DB, and the workaround that hides both does not
travel with the repository.

The meteorite proof did not catch this, because it proves the repository rebuilds a host;
it does not start the orchestrator and watch it come up. That gap is the reason a
green meteorite coexisted with an unstartable launcher.

## Disposition

Not fixed here. This record exists so the state is written down rather than absent, which
is the standing obligation in `instructions/reproducible-from-git.md` ("not in git is
never allowed to mean not written down"). The break-glass is left **in place and
untouched** — removing it stops the orchestrator.

The real fixes are three, and they are lane work, not orchestrator work:

1. Implement `reap` and `lease acquire|renew|release` in `core/mission-cli.ts` against
   `DurableStore`, with tests that fail when the launcher's vocabulary and the CLI's
   diverge. A test that locks *the caller and the callee agreeing* is the one that would
   have caught this; neither side alone is wrong-looking.
2. Restore `orchestrator/preflight-cli-auth.sh` as a tracked file, with a test asserting
   every path the launcher requires exists in the tree.
3. Make the meteorite proof start the orchestrator and assert it reaches a live state, so
   "the repository rebuilds the host" stops meaning "the files copy across".

Item 3 is the one that turns this from a bug into a class. Until it exists, the meteorite
proof can stay green through exactly this failure again.

## Addendum, same evening — the watchdog timer was stopped, and must be restored

`orch-fleet-nudge.timer` was **stopped** at ~19:15 CEST:

```sh
systemctl stop orch-fleet-nudge.timer   # -> inactive; `systemctl list-timers 'orch-fleet*'` lists none
```

Why: the watchdog had been failing every ten minutes since ~17:53 and, on each failure,
correctly notifying the operator that it could not read the workboard. The notification
path works — he received every one of them. So a broken watchdog was paging him every ten
minutes, at night, while he was trying to sleep, and he said so.

This was the orchestrator's fault twice over. It knew the watchdog was dead, and it left
the timer armed anyway while dispatching a lane to repair it — so the orchestrator was the
thing keeping him awake. A failing unit that alerts on every failure is not harmless just
because its alerts are accurate.

**It is stopped, not disabled**, so a reboot re-arms it — which would resume the paging.
That is a deliberate trade: leaving it enabled keeps the recovery path honest, and the fix
is expected within hours. If the fix does not land, the next orchestrator must either
finish it or disable the unit properly rather than rediscover this at 03:00.

**Restore condition:** once `ag-v3-fleet-nudge-restore` lands the tracked units and the
adapted parser, deploy from the tracked copy and `systemctl start orch-fleet-nudge.timer`
again — with `fleet-nudge-liveness` alongside it, which is the watchdog-for-the-watchdog
that v2 already had and v3 dropped.

Until then **autonomy is off**: nothing wakes the orchestrator when the fleet goes idle,
and nothing tells the operator if it stops. That is a known, accepted, time-boxed gap and
not a silent one.

### Closed the same night, 22:21 CEST

V3-2.11 landed (`1fd31cc`) and the watchdog is armed again. Autonomy was off for roughly
four and a half hours, deliberately.

What was deployed, and the one deliberate deviation:

- `bootstrap/install.sh` was **not** run. Its `hygiene` step installs an hourly
  `hygiene/reap.sh worktrees --apply` cron, and lane worktrees live under
  `/root/.cache/infra-lanes`, which the operator has ruled off-limits (Telegram 2132/2134;
  message 1839: *"не треба прибирати, ми все одно все вичистимо і почнемо з нуля коли в3
  буде готова"*). Arming automatic worktree reaping was doubly wrong on the night this
  row proved lane `failed` statuses are unreliable — the reaper would have been deleting
  evidence that is mislabelled.
- Only the installer's `render_units` behaviour was mirrored: the four templates rendered
  with `envsubst` over `INSTALL_ROOT` and `ENV_FILE`, installed `0600` into
  `/etc/systemd/system`, then `daemon-reload`.
- The hand-edited 120-line `/root/.local/bin/orch-fleet-nudge.sh` and the two previous unit
  files were backed up to `/root/oldorch-breakglass/pre-v3-2.11-backup/` before anything
  was written. They are the rollback artifact and are not in git.
- **Step 2 of the reviewer's sequence was dropped entirely**, correctly: the units now run
  from `${INSTALL_ROOT}`, so there is no second copy to install and no drift to detect.
  `git pull` is the deploy.
- The abort gate ran before anything was armed: `fleet-nudge.sh --count-open` against the
  real workboard, which is side-effect free — exit 0, 59 open rows, identical under gawk
  and mawk. Had it exited 2, arming would have restarted the storm.
- Watchdog armed first, verified (`Result=success`, heartbeat `status=0` and current, no
  alert-state file, nobody paged), then the liveness alarm armed second. Both timers
  active; the liveness alarm has never run on this host before tonight.

Rollback, if needed: `systemctl disable --now orch-fleet-nudge.timer
orch-fleet-nudge-liveness.timer`, restore from `/root/oldorch-breakglass/pre-v3-2.11-backup/`.

**Still open from this incident:** the launcher itself is unchanged. `preflight-cli-auth.sh`
is still absent from `HEAD`, `mission-cli.ts` still implements neither `reap` nor `lease`,
and the orchestrator still runs only because of two lines in the gitignored
`orchestrator/runtime.env`. The watchdog being alive does not make the host rebuildable —
it only means the machine can now tell someone when it stops.

## Closed, 2026-08-06 — blockers 1 and 2, at `21edc86` (lane `ag-v3-5.37`)

Both of this record's own lane-work items are closed. Item 3 (make the meteorite
proof start the orchestrator) was closed earlier by V3-5.36, and it is what measured
these two: its container stage refused with `launch-refused:error-unknown-action`,
which is blocker 1 seen from the outside.

**Blocker 1 — the unimplemented actions.** `core/mission-cli.ts` now implements
`reap` and `lease acquire|renew|release` against a durable named-lease table in
`core/schema.ts`, in the argument order and the exact output shape the launcher has
always parsed. The lease is fenced by owner and fencing token; the reaper releases
only holders that are provably dead on this host, and treats a live, foreign-host or
malformed owner as unverifiable rather than dead.

**Blocker 2 — the missing auth gate.** `orchestrator/preflight-cli-auth.sh` is a
tracked file again, restored from `75411d9` (the last commit it was alive in) and
committed `100755`, so a clean clone can execute it. It was run against this host's
real credentials for both providers before landing: removing the break-glass cannot
strand the live orchestrator.

### What would now catch each one at land time

This record asked for a test that locks *the caller and the callee agreeing*,
because neither side alone looked wrong. That test exists:

- `core/mission-cli-actions.test.ts` scans the tracked runtime shell for every
  mission-cli verb it calls and fails when the CLI does not implement it. Against the
  pre-fix vocabulary it names all eight divergent call sites with `file:line`. Note
  why the pre-existing `tools/check-documented-mission-cli.ts` could not have caught
  this: it scans *documentation*, and `launch.sh` calls through a `mission_cli()`
  shell function that no scan for the documented `bun .../mission-cli.ts` form would
  ever have seen.
- `orchestrator/launcher-startable-from-git.test.sh` runs the real launcher with no
  `runtime.env` and no `ORCH_AUTH_PREFLIGHT`/`ORCH_MISSION_CLI` override, against a
  state DB created exactly as `bootstrap/install.sh` creates one. Against the pre-fix
  tree it fails nine checks, reproducing both blockers verbatim —
  `ERROR unknown action: reap` and the absent preflight.

### What this does NOT close

- **The break-glass is still in place and still load-bearing on this host.**
  `orchestrator/runtime.env` remains gitignored and still sets `ORCH_STATE_DB` to an
  absent path and `ORCH_AUTH_PREFLIGHT` to `/root/oldorch-breakglass/`. Nothing in
  this lane removed those two lines — removing them is a live-host change, and it is
  the orchestrator's call, after this branch lands. Until then the repository can
  start an orchestrator that the running host still starts the old way, which is the
  same divergence class this record is about, merely much smaller.
- **Blocker 3 from the V3-5.36 finding is untouched:** `launch.sh` verifies its
  singleton owner through `/proc/locks`, which is namespace-filtered, so no
  orchestrator can start inside a container even now. That is filed separately as a
  Tier-A question (workboard V3-5.38) and deliberately not softened here; the
  full-start rehearsal above is capability-gated on exactly that probe and reports
  `EXCLUDED case=full-start capability=proc-locks-visibility` where it is unavailable.
