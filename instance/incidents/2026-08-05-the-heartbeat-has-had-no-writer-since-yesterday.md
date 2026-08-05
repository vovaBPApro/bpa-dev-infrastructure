# The orchestrator heartbeat has had no writer since 2026-08-04 18:13

date: 2026-08-05
found-by: lane V3-5.2 (`ag-v3-3.2`), while making three fail-open launcher guards fail-closed
severity: the primary liveness signal for the orchestrator is dead, and its death is masked
status: open — repair row filed, see `instance/workboard.md` V3-5.6

## What was measured

`orchestrator/launch.sh` `build_command` references two relay scripts:

- `orchestrator/orchestrator-claude-stop-relay.sh`
- `orchestrator/orchestrator-turnend-relay.sh`

**Neither exists.** Not in `git ls-files` at any SHA on this line, not on disk in the
canonical checkout, not in any lane worktree. The live `orchestrator/runtime.env` sets
neither `ORCH_TURNEND_RELAY` nor `ORCH_CLAUDE_STOP_RELAY`, so the running launcher resolves
the same dangling defaults. A `[[ -x ]]` guard skipped both in silence.

The turn-end relay is not decoration. `orchestrator/watchdog.sh:348-350` names it as the
**single ongoing writer** of the heartbeat file.

Measured directly on this host at 2026-08-05 07:53 CEST:

```
orchestrator/runtime/orchestrator.heartbeat   last written Aug  4 18:13
content:  1785860025
now:      1785909222
age:      49197 seconds
ORCH_HEARTBEAT_MAX_AGE default: 1200 seconds   (orchestrator/watchdog.sh:21)
```

**The heartbeat is 41× past its own staleness threshold and has been for nearly fourteen
hours.** `heartbeat_stale()` has been returning true continuously since roughly 18:33
yesterday.

## Why nothing happened

Because a second signal was built, deliberately, and it has been carrying the system alone.
`orchestrator/watchdog.sh:347-360` explains the design: the heartbeat says "a turn ENDED",
never "a turn is running", so a single long turn was indistinguishable from a corpse and the
tick used to kill live sessions mid-work. tmux pane activity was added as a second signal
under a newest-signal-wins rule.

That backup is why the orchestrator was not killed and relaunched every twenty minutes all
night. It worked exactly as designed — and in working, it hid that the primary signal had no
writer at all.

## The defect class, which is the reason to write this down

This is **a property defended by accident rather than construction**, the dominant pattern
in two days of audits on this repository — but with a sharper edge than the previous nine
instances. Here the accident is not a coincidence of naming or ordering: it is a *correctly
built redundancy* silently absorbing the total failure of the thing it was meant to
supplement.

A backup signal that covers for a dead primary, without saying so, converts redundancy into
a single point of failure while presenting as two. If the tmux signal now fails for any
reason, the watchdog has nothing — and nobody would learn that until it mattered.

Related shape, same repository, recorded so the pattern is legible:

- V3-2.12 — `envsubst` substituted empty for two undefined variables, rendering the
  nightly-suite and watchdog timers broken on a clean rebuild.
- V3-0.44 — systemd expanded `${10}` to empty, so every lane invoked its exit gate as
  `--role ""`.
- The requirements audit's F4 — a SessionStart hook pointing at a file that does not exist,
  skipped by a silent `[[ -x ]]`.

Four instances of the same sentence: **a mechanism referenced by path, absent in fact, and
absent without complaint.**

## What the discovering lane did, and why it reported NO-GO

V3-5.2 made all three guards fail-closed as its dispatch required. That is correct
behaviour and it immediately turned two tracked suites red —
`orchestrator/singleton-failclosed.test.sh` (`ERROR orchestrator-turnend-relay-unavailable`)
and `orchestrator/launch-handshake-bounded.test.sh` — because the relays genuinely are not
there. Both pass with `launch.sh` reverted in the same worktree, so the lane proved this was
its own regression rather than pre-existing flake, and refused to relabel it as a warning.

It also drew the consequence correctly: **landing it as-is would stop the orchestrator from
starting at its next natural restart** — the operator's only channel to this system. The
lane reported NO-GO rather than shipping a change that was locally correct and globally
fatal. That judgement is the reason this incident was found rather than caused.

## Disposition

Taken: the session-hook fix is separated from the relay guards (V3-5.2 round 2), so the
28-inbox-row cost of the missing session load stops accruing today. The relay repair becomes
its own row, V3-5.6, rather than a prose promise.

The sequencing argument for doing it this way rather than the reverse: the relay has been
absent since at least yesterday evening and the system has been running on its backup
throughout, so one more day of the status quo is a known quantity. The session load has
never run on this provider at all. Neither is acceptable; only one of them is getting worse.

**What must not happen:** the relay guards going back to fail-open permanently. That is the
status quo being restored on purpose, and the only thing that makes it acceptable is V3-5.6
existing with a date on it. If V3-5.6 is still open when someone reads this, that is the
finding, not this incident.
