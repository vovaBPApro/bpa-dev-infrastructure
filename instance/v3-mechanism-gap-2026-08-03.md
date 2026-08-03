# What v3 is missing — the bounded answer

Written in reply to Vova, Telegram 1763:

> бляха, ну, дружище, ну скільки ще такого ми проїбали, а? скільки ще такого буде
> вилізати?

The honest answer is a number, not an apology. The gap between the abandoned line and
v3 is finite and can be enumerated exactly, so "what else will surface" stops being
open-ended dread and becomes a checklist.

## The measurement

`git ls-tree -r` on both branches, then set difference:

- `v2-deprecated`: 607 tracked files
- `v3`: 231 tracked files
- present on the old line, absent from v3: **427 files**

But 427 is the wrong number to be frightened by. Most of it is history, not machinery:
106 files under `reports/`, 71 under `migration-prep/`, 48 under `instance/` — evidence
and decision records of work already done. Those belong to the old line and do not need
porting.

**The number that matters: 126 executable mechanisms** (`.sh`, systemd `.service.in` /
`.timer.in`) exist on the old line and not on v3. Full list committed at
`instance/evidence/v3-mechanism-gap-2026-08-03.tsv`.

| category | count | what it is |
|---|---|---|
| orchestration | 51 | lane dispatch, fleet, watchdog, launcher scripts |
| clean-server-rebuild | 33 | `bootstrap/` + units, whisper installer, hygiene, meteorite, deploy |
| verification | 20 | soak, stand, CI workflows, test harness |
| landing-gate | 9 | the gate hardening tests added after the fork |
| product-surface | 9 | edge, database, workspace, preview |
| other | 4 | |

## The 33 that block a clean server

This is the set that answers his Whisper question and his "should I wipe the server"
question in one:

- `bootstrap/install.sh`, `deploy-host-mechanism.sh`, `check-unit-drift.sh`,
  `check-deployed-drift.sh`, `telegram-transport-preflight.sh` and their tests
- all 17 unit templates under `bootstrap/units/` — including
  `bpa-telegram-daemon.service.in` and `bpa-orchestrator.service.in`, i.e. the units
  that start the system at all
- `tools/whisper/install.sh` — v3 has `daemon/transcribe.ts`, which *calls* whisper,
  but nothing that *installs* it
- `hygiene/install-cron.sh`, `hygiene/reap.sh` — the branch/worktree reaper
- `meteorite/run.sh` — the clean-rebuild proof itself
- `deploy/live-stand.sh` and the staleness check

Until these exist on v3, wiping this host would leave nothing able to rebuild it. That
is why the answer to "почищу сервак і з нуля почнемо?" is *not yet* — the wipe is the
right final test, but only once v3 can pass it.

## Why this was not visible before today

Not one of these is a surprise defect in the sense of a bug. They are all the same
shape as everything else found today: a mechanism exists, is tracked, and is not
connected — except here the disconnection is that v3 was forked before them and nobody
diffed the two lines. The fork happened at 14:41 on 2026-08-02 and the branch was
finished 95 minutes later; the comparison in this document takes about ten seconds to
run and had simply never been run.

That is the real lesson, and it is cheap to institutionalise: **a from-scratch rewrite
needs a standing, machine-checked inventory diff against the line it replaces**, so the
gap is a number on a dashboard rather than a discovery. That belongs in v3's own
checks, alongside `bootstrap/check-unit-drift.sh` which does exactly this for host
units and correctly exits 1.

## What this does not say

It does not say v3 is a mistake. v3's schema already carries
`correlation_id TEXT UNIQUE NOT NULL` (`core/schema.ts:141`) — the exact defect two
review rounds were spent fixing on the old line does not exist there, by design. v3 is
ahead on the parts it has built and absent on the parts it has not. The 126 is the
work, not a verdict.
