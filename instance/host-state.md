# Non-git host state on this installation

Hard Floor 5 (`instructions/reproducible-from-git.md`) says host state that must
not be in git is **enumerated instead** — *"not in git is never allowed to mean
not written down"*. Until 2026-08-04 that obligation had never been discharged.
`meteorite/run.sh` proves the repository rebuilds a **host**; it says nothing
about the state that host accumulated. Rebuild this machine from git tomorrow
and you get every script, unit, rule and decision — and no answer to "what was
in flight and why".

This document is the narrative half. The binding data is three files:

- [`host-state.tsv`](host-state.tsv) — 59 rows, each naming a location, what
  writes it, whether a rebuild needs it, and **the exact command that decides
  whether it is present and sound**.
- [`host-state-exclusions.tsv`](host-state-exclusions.tsv) — 58 locations that
  were looked at and the reason each needs no row of its own.
- [`host-units.tsv`](host-units.tsv) — 25 systemd units **deployed on this
  host**, whether each is *armed* or merely *installed*, and where its
  `ExecStart` points. Added in round 3 because a filesystem walk cannot see the
  fact that makes a unit matter: that systemd will run it again after a reboot.

None of the three is a snapshot: `tools/check-host-state.ts` fails closed when
they disagree with the code, again when they disagree with the filesystem, and
again when they disagree with the unit graph.

## How to use it

```sh
bun tools/check-host-state.ts                      # manifest lint + drift scan (the gate runs this)
bun tools/check-host-state.ts --sweep              # walk this host for anything unlisted
bun tools/check-host-state.ts --units              # enumerate deployed systemd units
bun tools/check-host-state.ts --verify             # every row's own command, then sweep, then units
bun tools/check-host-state.ts --verify --only lane-root
bun tools/check-host-state.ts snapshot <db> <dst>  # WAL-correct sqlite copy
```

**`--units` and `--verify` exit non-zero on this host today, and that is the
correct reading, not a broken check.** Seven unit rows and seven state rows carry
disposition `unresolved`: they name live Hard Floor 5 breaches that are enumerated
but *undecided*, and their probes are built to keep failing until someone decides.
See [What is still broken](#what-is-still-broken-and-is-supposed-to-stay-loud).

`--verify` executes the `verify` column verbatim. There is deliberately no
second version of those commands: what the manifest documents and what the
checker runs are the same string, so they cannot drift apart.

## Two scans, two questions, and why one was not enough

Round 1 of this row shipped only the drift scan and described it as though it
answered both questions. It does not, and the reviewer showed the consequence in
three lines: create `~/.local/state/bpa-review-probe-fixture/unlisted.db`, run
the checker, get `HOST-STATE clean` and exit 0. **A checker that answers "is
anything here unaccounted for?" by reading only the repository cannot answer
it.** The two scans are now separate and neither substitutes for the other.

### Drift scan — "does the tracked code write anywhere the manifest does not name?"

Reads tracked sources only, so it is deterministic and host-independent. That is
why it, and only it, runs in `gate/land.sh`: it behaves identically inside the
meteorite container, where there is no installation to inspect. It runs in
**both directions**, because the mechanism inventory went stale as a snapshot
with no checker (V3-0.42):

- **Forward.** Every host path the tracked code names — after comments are
  stripped, and including the `join(homedir(), …)` forms the daemon builds — must
  be covered by a row or a `source`-scope exclusion. Teaching the system to write
  somewhere new without enumerating it cannot land.
- **Reverse.** A row naming tracked writers is re-checked against those files. A
  row survives the deletion of the code it describes only if someone deletes the
  row too.

Comments are stripped first, deliberately. V3-0.28 was reopened because the
reachability checker accepted a code comment as an executor; a detector that
reads prose is not a detector.

### Sweep — "does anything exist on this host that the manifest does not name?"

Reads the filesystem only. It is the **only** one of the two that can see state
written by something untracked — an improvised script, the agent harness, a
person — and that is exactly the state Hard Floor 5 says gets left behind. It
stays out of the landing gate on purpose: a gate step that reads the live host
would make landing depend on which machine ran it.

The walk is bounded by the manifest's own shape rather than by depth or size,
which is what keeps it cheap across a 1.6 G lane root:

| at each entry | action |
|---|---|
| a row or a `host`-scope exclusion covers it | stop, do not descend — that is the answer |
| a row lives beneath it | descend, the answer is further down |
| otherwise | report it, do not descend |

So a finding is named at the shallowest uncovered path: `/root/.ssh` is one
line, not four hundred.

Two roots behave differently, because they are different kinds of place:

- **Owned** (`$HOME`, `/home`) — this installation is the only thing that puts
  state here, so anything uncovered is a finding.
- **Shared** (`/var/lib`, `/var/log`, `/var/spool/cron`, `/etc/systemd`) — the
  distribution lives here too. Listing its ~95 directories would go stale on the
  next `apt upgrade` and teach the operator to ignore red, so the boundary is
  declared once as a name claim: under a shared root, this installation's state
  is identifiable by name.

A `host` exclusion that matches nothing is **reported, not failed**. The
fail-closed direction is uncovered state; a host getting *cleaner* must never
turn the sweep red, or the operator learns to ignore it.

### Units — "what does systemd run here, and did anything tracked render it?"

The third scan, and the one round 2 did not have. It exists because of a single
counter-example that both other scans missed completely:

> `orch-fleet-nudge.timer` is **enabled, runs as root, and fires every ten
> minutes**. Its service runs `/root/.local/bin/orch-fleet-nudge.sh` — 5198
> bytes, untracked, in no template and no decision. It wakes the orchestrator
> over tmux and pings the operator over Telegram: it is the fleet's only stall
> detector, and its own header says *"the Human must not be the thing that
> notices"*. **The machine is operated by a mechanism the meteorite would not
> restore**, and while that was true the checker printed `unlisted=0`.

Neither existing scan could see it. The drift scan reads tracked sources, and
nothing tracked mentions it. The sweep reads the filesystem, and a unit file is
just a config file — what makes it matter is the *unit graph*, which is not a
directory listing. It also sat behind two exclusions whose stated reasons were
factually wrong about this host; both are gone (see below).

#### The reverse of `check-unit-drift.sh`

`bootstrap/check-unit-drift.sh` loops `for template in "$dir"/*.in` — it asks
*"is every **tracked** unit deployed and identical?"* and **never enumerates what
is deployed**. So a unit with no template is invisible to it by construction.
The `systemd-dir` row used to delegate the question to it anyway, and was marked
`rebuildable` — an affirmative claim that a rebuild reproduces
`/etc/systemd/system`. It would not: deployed units there are rendered from
nothing tracked (four when this was written; three as of 2026-08-05, the fleet
nudge having become tracked). That row is now `unresolved`, and the reverse
question has a mechanism instead of a delegation.

#### Armed is not the same as installed

The distinction the workboard claimed elsewhere and could not back (V3-0.28).
Here it is derived from the **unit graph on disk**, not from `systemctl`:

| state | meaning |
|---|---|
| `armed` | a `.wants`/`.requires` symlink arms it, **or** an armed timer/socket/path activates it |
| `installed` | the unit file is deployed and nothing arms it |

`systemctl is-active` is deliberately *not* the definition. A unit active now but
not enabled does not come back after a reboot; one enabled but inactive does — and
Hard Floor 5's question is about the rebuilt host, not this minute. Deriving it
from the filesystem is also what lets a test build a unit graph in a scratch
directory instead of asserting against whatever this machine has installed.

The propagation rule is load-bearing: `orch-fleet-nudge.service` is `static`, so
`systemctl is-enabled` calls it neither enabled nor disabled. It runs every ten
minutes because an enabled timer activates it. A checker reading `is-enabled`
would have called it `installed` and been wrong about the most important unit on
the host.

#### `DRIFT` and `UNRESOLVED` are different claims

- **`DRIFT`** — the manifest is *wrong*: a row calls an armed unit installed, an
  `ExecStart` moved, a `rebuildable` row names a template this repository does
  not carry. Someone must fix the file.
- **`UNRESOLVED`** — the manifest is *right* and the host has a breach awaiting a
  decision.

They are separate counters on purpose. Folding the second into the first is how a
permanently-red check stops being read, and then real drift arrives into noise
nobody looks at.

#### KNOWN OVERLAP with `check-unit-drift.sh`, stated rather than unified

Found on the 2026-08-05 rebase and **deliberately left in place**. Two mechanisms
now ask an overlapping question and return different verdicts about one unit:

| mechanism | reads | asks | verdict on `orch-morning-report.service` |
|---|---|---|---|
| `bootstrap/check-unit-drift.sh` | tracked templates | is the `$INSTALL_ROOT`-anchored path carried by this repository? | `PATH-EXEMPT` — green, ledgered in `instance/unit-path-exemptions.tsv` as `owner=V3-2.17` |
| `tools/check-host-state.ts --units` | units deployed on the host | does this armed unit's `ExecStart` target exist? | `DRIFT` — red |

Both are right on their own terms, and the questions are not identical: the first
is repository-side and host-independent, the second is host-side. They coincide
whenever a deployed unit was rendered from a tracked template with an
`$INSTALL_ROOT`-anchored `ExecStart`, and `orchestrator/morning.sh` is exactly
that case. So the system currently tells an agent that this fact is an owned,
expiring debt **and** that it is drift, with no reference between the two.

That is the shape of defect V3-2.16 was filed about, which is why it is written
down here instead of being quietly fixed. Two things make it worse than cosmetic:

- By this document's own taxonomy directly above, `DRIFT` means *the manifest is
  wrong — someone must fix the file*. Here the manifest is **right**: the unit is
  armed and its template is carried. No edit to `instance/host-units.tsv` clears
  this, so the one counter that is supposed to be actionable has an entry that
  cannot be actioned.
- `--units` has no exemption ledger, so it cannot express "known, owned, expiring"
  at all — the vocabulary the other mechanism uses for this exact fact.

Resolving it is a decision about mechanism ownership, not a rebase's call. The two
candidates are: teach `--units` to consult `instance/unit-path-exemptions.tsv`
(one ledger, two readers), or narrow `--units` to stop asking a question
`check-unit-drift.sh` already owns. Choosing wrongly duplicates the ledger, and
duplicating a ledger is how the expiry rule V3-2.16 built gets bypassed.

### The honest limits of all three scans

- **Scope is `$HOME`, the XDG roots, `/root`, `/home`, `/var/lib`, `/var/log`,
  `/var/spool/cron` and `/etc/systemd`.** `/usr` and `/bin` belong to the
  distribution. `/tmp` is excluded by construction: it does not survive a reboot,
  so it cannot hold state a rebuild restores.
- **The units scan reads `/etc/systemd/system` and `$HOME/.config/systemd/user`,
  and follows no symlinks.** `/lib/systemd/system` is the distribution's and is
  out of scope, exactly as `/usr` is for the sweep. Symlinks under the system
  directory are systemd's *enable* mechanism and point back into the
  distribution, so following them would drag ~200 distro units into an
  enumeration that is about this installation. The cost is real and stated: a
  unit deployed **as a symlink** to somewhere outside these two directories would
  not be enumerated. Nothing on this host is.
- **The units scan does not cover other managers.** No `cron` (that is the
  `root-crontab` row, F5), no `at`, no container restart policies, no
  `systemd --user` instance for the `bpa-shell` account. A Docker container with
  `restart: always` is infrastructure that survives a reboot and this
  enumeration does not name it. That is a real gap, not a bounded one.
- **The name claim is the sweep's real boundary.** A future directory belonging
  to this installation but sitting under a shared root *without* `bpa` in its
  name stays invisible to the sweep. That is a deliberate trade against
  false-positive churn, and it is the first thing to revisit if something is
  found missing.
- **No declared scan root is excused wholesale any more, and four used to be.**
  This section previously omitted its own largest limit. `/root/.local/bin`,
  `/root/.config/systemd`, `/root/.local/share` and `/home/bpa-shell/.local` each
  carried a single `host` exclusion that made an entire directory tree — two of
  them declared XDG scan roots — invisible. Every one of those four reasons was
  false about this host:

  | excused | the reason it gave | what was actually in it |
  |---|---|---|
  | `/root/.local/bin` | "per-user binaries installed by third-party tooling" | **only** `orch-fleet-nudge.sh`, the armed root timer's script |
  | `/root/.config/systemd` | "this repository installs system units only" | 14 of **this installation's own** units, one of them enabled |
  | `/root/.local/share` | "only third-party tooling state" | plus `systemd/`, this installation's own timer stamps |
  | `/home/bpa-shell/.local` | "third-party tooling state only" | swallowed the second account's XDG **state** root — where V3-1.9's non-root lane model will write |

  The first two are deleted and their contents have rows. The last two are
  narrowed to the specific third-party subdirectories that do occupy them
  (`applications`, `caddy`, `pnpm`, and the second account's `share`), so the
  state roots beside them stay visible. `tools/check-host-state.test.ts` locks
  the direction, and removing the four new rows turns the sweep red on all four
  paths — that is the fail-before evidence for this fix.

  The general lesson is the one worth keeping: **an exclusion is a claim about a
  directory's contents, and it decays.** A reason that was true when written goes
  false when someone drops a file in. Prefer narrow prefixes over roots.
- **The sweep and the units scan have no automatic caller.** `--verify`,
  `--sweep` and `--units` are operator commands; the gate runs the drift scan
  only. So a file or unit that appears between manual runs is not detected until
  the next one. Wiring one to a timer needs a timer that is actually armed, and
  `bpa-full-suite.timer` — the one that would carry it — is deployed and
  **disabled** (F5, V3-2.1).

  Round 2 stated this as *"on this host no bpa timer is armed"*. That was false
  when written: `orch-morning-report.timer` is armed and tracked, and
  `orch-fleet-nudge.timer` was armed and untracked (F16 — tracked since
  2026-08-05, and joined by the armed `orch-fleet-nudge-liveness.timer`). The
  claim is corrected rather than quietly dropped, because believing no timer was
  armed is part of what kept F16 unlooked-for.
- **A path assembled entirely from variables is invisible to the drift scan.**
  The manifest records those as `external:` writers, which costs the reverse
  check on that row. The sweep is what now covers them from the other side, but
  only while the path exists.
- **`install-root` is a broad row.** It covers anything new under the canonical
  checkout — bounded in practice by `.gitignore`, whose only runtime entries
  (`orchestrator/runtime/`, `/runtime/`) both have their own rows.
- **`ephemeral`, `orphan` and `optional` rows cannot fail on absence**, because
  for them absence is the correct reading. They still fail on damage — something
  present and empty or unparseable, which a restore would silently accept.

### What each scan can and cannot go stale about

Round 1's report stated this backwards, which matters more than the sentence
does: a correctly-behaving checker described wrongly is how V3-0.28 stayed green
for a week. Stated correctly:

- What **cannot** go stale is the **tracked-code ↔ manifest correspondence**.
  The gate enforces it on every landing, in both directions.
- What **can** go stale is the **enumeration itself**, and it is the direction
  that matters most. It had already gone stale when round 1 shipped: three
  untracked fleet-recovery scripts, a secret-bearing env backup and 1.1 MB of
  operator channel material were sitting under the declared scan roots with no
  row and no exclusion, and the checker printed `clean`.
- A row can also become false on the host between manual `--verify` runs.

## What is still broken, and is supposed to stay loud

`--sweep` reports `unlisted=0` on this host. **That number means "everything here
has a row", and it does not mean the host is in a good state.** Round 2 shipped
with `unlisted=0` while an armed root timer operated the fleet from outside git,
and the number said nothing. It now reports a second figure beside it so that
reading can never recur:

```
HOST-STATE sweep roots=6 unlisted=0 stale=0 unresolved=7
HOST-STATE units dirs=2 unlisted=0 drift=1 unresolved=5 stale=0
```

`unresolved` counts enumerated, undecided Hard Floor 5 breaches. Their probes
**fail while the breach exists** and clear themselves when the path is gone, so no
edit here is needed to resolve one. Today they are:

Re-measured 2026-08-05:

| what | why it is a breach |
|---|---|
| `bpa-db-network-boundary.service` (F17) | armed, and its script went away with a reaped lane worktree |
| `/etc/systemd/system` (`systemd-dir`) | deployed units there are rendered from nothing tracked |
| `/root/.config/systemd/user` + 4 unit rows (F18) | 14 units, one enabled, no templates |
| `orch-recover.sh`, `orch-recover-claude.sh`, `orch-claude-debug.sh` (F8) | untracked fleet-recovery scripts improvised during incidents |
| `/var/lib/bpa-authority` (F11) | a second, undeclared lane-provisioning state root |
| `/root/oldorch-breakglass` | holds `preflight-cli-auth.sh`, which `orchestrator/runtime.env` names in `ORCH_AUTH_PREFLIGHT` — so the launcher's auth preflight is outside git |

`orch-fleet-nudge.timer` + `.service` + its script (F16) **left this table on
2026-08-05**: V3-2.11 and V3-2.12 landed the script and the templates, the
deployed units were re-verified against them, and the rows are now `rebuildable`.
It is the first entry here to be closed rather than restated, and the closure was
detected by re-running the scans rather than by anyone remembering to update a
document.

`systemd-dir`'s exposure probe was repointed in the same pass. It targeted
`orch-fleet-nudge.timer`, which had become tracked — so the row would have
cleared itself on a directory that is still not reproducible. It now probes
`bpa-db-network-boundary.service` (F17), the sharpest remaining instance. A probe
that clears for the wrong reason is the same class of defect as a stale row.

None of them are deleted, moved or tidied. The operator has ruled against cleanup
(Telegram 2132, 2134); the decision about each is the operator's and the
orchestrator's, and these rows exist so the decision is **visible rather than
absent**.

## What this enumeration does not claim

It is **complete for what it scans, and it scans less than "this host"**. Stating
which parts are partial is the point — a mechanism that says `unlisted=0` while an
armed root timer runs untracked is worse than one that says plainly "I do not look
there".

Not covered, and known to be so:

- **Managers other than systemd**: cron, `at`, Docker restart policies, and the
  `bpa-shell` account's user manager. A container with `restart: always` survives a
  reboot and has no row.
- **Paths outside the declared roots**: `/usr`, `/bin`, `/opt`, `/srv`, `/etc`
  apart from `/etc/systemd`. The v2 product's `$APP_ROOT` (`/srv/projects/agentic-bpa`)
  and `/etc/bpa-edge/Caddyfile` are named by unit rows but their contents are not
  enumerated — that is the product repository's obligation, and the boundary is a
  recorded decision (`off-scope`), not an omission.
- **Content of anything marked `secret`**: location and mode only, never opened.
- **State under a shared root without `bpa` in its name** — the name claim above.
- **Anything that appears between manual runs.** The sweep and the units scan have
  **no automatic caller**; `bpa-full-suite.timer` is deployed and *disabled*.

### Deployed units with no tracked template, beyond the fleet nudge

Noted, not asserted beyond what was measured. `agentic-bpa.service`,
`bpa-edge.service` and `bpa-db-network-boundary.service` are deployed in
`/etc/systemd/system` and rendered from nothing tracked in this repository. The
first two are the **v2 product's** and carry `off-scope` — the same domain
boundary `host-state-exclusions.tsv` already draws for `/var/lib/agentic-bpa`.
Whether they belong to this control plane at all is not this row's question, and
no claim is made either way; what *is* measured is that `/etc/systemd/system` is
not reproducible from this repository, which is why `systemd-dir` stopped saying
`rebuildable`.

`bpa-db-network-boundary.service` is different in kind and is F17 below.

## The write-ahead log

Both live databases run in WAL mode. Copying `state.db` alone while writes are in
flight is not a backup, and the failure is worse than losing rows: in
`tools/check-host-state.test.ts` the naive copy is missing the **table**, because
the schema itself was still in the `-wal`. A restore from it looks like a fresh
install rather than a damaged one. `snapshot` uses `VACUUM INTO`, which takes a
read transaction and therefore captures every committed transaction including
those still in the log.

## Findings

Classified per the rule landed in `6257a32`.

**F1 — two live state databases, and the installer creates the wrong one. (open)**
`ORCH_STATE_DB` in `/root/.config/bpa/orchestrator.env` points the running
orchestrator at `/root/.local/state/bpa/state.db`, which holds 49 leases and 172
lease events and **zero** missions or lanes. `bootstrap/install.sh` has no
opinion about `ORCH_STATE_DB`: it defaults to `$RUNTIME_DIR/state.db` =
`/root/bpa-dev-infrastructure/runtime/state.db`, which holds 4 missions, 80 lanes
and 249 events. So the mission and lane history lives in the file the installer
creates and the orchestrator does not use, and a rebuild would produce an empty
database at a path nothing reads. `daemon/mission-source.ts` resolves
`INFRA_STATE_DB || ORCH_STATE_DB || $INSTALL_ROOT/runtime/state.db` — a third
order again. Both files are enumerated as `must-survive` because neither can
currently be discarded.

**F2 — the meteorite proof has two destinations. (open)**
`meteorite/run.sh` defaults to
`$XDG_STATE_HOME/bpa-dev-infrastructure/evidence/meteorite-latest.md`;
`bootstrap/units/bpa-meteorite.service.in` sets
`METEORITE_REPORT=/var/lib/bpa-orchestrator/evidence/meteorite-latest.md`. A timer
run and a manual run would not overwrite each other, so "latest" would mean two
different things.

**F3 — generic mechanisms hard-code `/root`. (open)**
`bootstrap/units/bpa-telegram-daemon.service.in` and `meteorite/run.sh` spell
`/root/.claude/channels/telegram` and `/root/.bun/bin` literally where the rest of
the code uses `$HOME`. Same locations, host baked in — an HR-309 defect. They are
in the exclusions file rather than duplicated as rows, so the duplication stays
visible with its reason attached.

**F4 — `$HOME/.codex` is mode 755. (open)**
The `auth.json` inside is 600, so the credential itself is protected, but the
directory listing is world-readable. Surfaced by `--verify`, which is the point
of giving every row a real command. Not changed by this lane: the trap list
forbids tidying host state here.

**F5 — the reap cron is still not installed. (open)**
`crontab -l` still returns `no crontab for root`. `hygiene/install-cron.sh` is
tracked, correct, and invoked by nothing on this host — the exact instance
V3-0.28 was written about, unchanged.

**F6 — two lane roots. (open)**
`orchestrator/fleet/launch-lane.sh` writes `${XDG_CACHE_HOME:-$HOME/.cache}/infra-lanes`
(1.6G, ~4470 entries here) while `daemon/status.ts` reads the constant
`/home/bpa-shell/.cache/infra-lanes` (12 entries). Both exist; they are not the
same directory. Enumerated as two rows because both currently hold work.

**F8 — three untracked scripts on this host operate the fleet. (open, and the sharpest row here)**
`/root/orch-recover.sh`, `/root/orch-recover-claude.sh` and
`/root/orch-claude-debug.sh` are executable, untracked, and they operate the
fleet — `orch-recover.sh` is a recovery launcher for `bpa-orchestrator` that
works around the singleton-lock deadlock. Hard Floor 5 names this case verbatim:
*"A script used to operate the fleet belongs in the repo, not in a temp
directory or a shell history… This applies most sharply to things improvised
during an incident, which is exactly when they get left behind."* Three of them,
left behind. **They were not deleted, moved or edited** — the operator has ruled
against cleanup (Telegram 2132, 2134). Each has a row with disposition
`unresolved`, whose probe **fails while the file exists**, so `--verify` keeps
reporting the exposure until the orchestrator and the operator decide whether
each one is landed into the repository or removed. That decision is theirs, not
this lane's; what this lane owes is that it cannot be made by forgetting.

**F9 — a secret-bearing env backup outside the enumerated backups. (open)**
`/root/.config/bpa/orchestrator.env.bak-20260730` is a copy of the launcher env,
sitting beside `orchestrator.env` rather than inside the enumerated `backups/`
directory, so the `config-backups` row did not reach it. Enumerated by location
and mode only (600). Its contents were never read, and it must not be moved into
the tree.

**F10 — the harness's own state is the largest unenumerated surface. (open)**
`~/.claude/{projects,sessions,tasks,history.jsonl}` is where the lanes actually
run, and `/home/bpa-shell/.claude` is the same thing for the second account.
`repository-hygiene` forbids putting session histories in git, which under Hard
Floor 5 makes enumerating them mandatory rather than optional — "not in git" is
never allowed to mean "not written down". Round 1 descended into `~/.claude` for
four rows and omitted the siblings, which made it an inconsistency rather than a
boundary.

**F11 — two lane-provisioning state roots. (open)**
`/var/lib/bpa-authority` exists, mode 700 and empty, and no tracked file names
it; the tracked default is `$LANE_PROVISION_STATE_ROOT` =
`/var/lib/bpa-dev-infrastructure/service-users` (the `service-users` row). Which
root carries provisioning authority is undecided, and `bootstrap/service-user-lib.sh`
treats that root as an authority input. Enumerated as `unresolved`.

**F12 — agent scratch accumulates and nothing reaps it. (open)**
`$XDG_CACHE_HOME/lane-tmp` alone holds 6559 entries, beside ten
`bpa-authority-test-*` fixture roots in `/var/lib` and a dozen per-investigation
reproduction trees under the cache root. None of it is state a rebuild restores,
so it is excused rather than enumerated — but the accumulation is the same reap
gap F5 names, now with a number attached.

**F13 — `/home/bpa-shell/.codex` is mode 775. (open)**
The same world-readable-directory defect as F4, on the second account. Surfaced
by `--verify`. Not changed by this lane: the trap list forbids tidying host
state here.

**F14 — the harness permission surface is host-only. (open)**
`~/.claude/settings.json` exists on this host and no tracked file installs it.
`tool-permissions` requires the permission surface to be versioned and
fail-closed; a host-only copy means the versioned surface and the live one
cannot be compared. Enumerated so the gap is visible; closing it is not this
row's scope.

**F16 — an armed root timer operates this fleet from outside git. (CLOSED 2026-08-05)**

> Closed between round 3 and this branch's rebase, by other rows and not by this
> one. **V3-2.11** (`1cdac84`, `d764a15`, `585581d`) landed the script as
> `orchestrator/fleet/fleet-nudge.sh`; **V3-2.12** (`b5f1cad`) landed
> `bootstrap/units/orch-fleet-nudge.service.in` and `.timer.in`. The deployed
> service now execs `$INSTALL_ROOT/orchestrator/fleet/fleet-nudge.sh`, verified
> against this host on 2026-08-05, and nothing under `/etc/systemd/system` or
> `/root/.config/systemd` still references the old path. `HR-309.md:66`'s claim,
> premature when made, is now true.
>
> `/root/.local/bin/orch-fleet-nudge.sh` is **still on disk** — untracked, 5198
> bytes, mode 755, unmodified since Jul 31 — and is now `orphan`: present, and
> nothing runs it. The breach was the arming, not the bytes. Nothing was deleted
> or moved (operator ruling, Telegram 2132/2134).
>
> The account below is left as written, because how this was found is the part
> worth keeping.

The round-2 blocking finding, and the sharpest live instance of Hard Floor 5 on
this machine. `orch-fleet-nudge.timer` is enabled and fires every ten minutes as
root; `orch-fleet-nudge.service` runs `/root/.local/bin/orch-fleet-nudge.sh`,
which is 5198 bytes, mode 755, and **tracked nowhere**. It wakes the orchestrator
over tmux, pings the operator over Telegram, and reads `instance/workboard.md` —
it is the fleet's only stall detector, deliberately outside the orchestrator
session so that, in its own words, *"the Human must not be the thing that
notices"*.

Three things made it invisible, all three now fixed: two exclusions whose stated
reasons were false about this host (see the limits table above), and a
`systemd-dir` row that delegated "which units belong here" to a checker that only
ever asks the opposite question.

What makes it a finding rather than a task: **`instance/decisions/HR-309.md:66`
already records this script as fixed** — *"the nudge script and its systemd units
are captured under `orchestrator/fleet/`"*. `orchestrator/fleet/` contains three
`launch-lane` files and no nudge script. The ledger records a fix that does not
exist, which is exactly the `instruction-layers` failure mode of a routed row
whose target does not carry the restriction. The user-manager unit at F19 even
names `orchestrator/fleet/fleet-nudge.sh` in its `ExecStart`, so a lane once ran
in a tree where that file was present.

Not deleted or moved (Telegram 2132, 2134). The decision is the operator's; this
row's obligation was to make it impossible to miss.

**F17 — an armed security boundary whose implementation was reaped. (open)**
`bpa-db-network-boundary.service` installs the payload database's network
boundary. It is **enabled**, ordered `Before=` the orchestrator and the telegram
daemon, and its `ExecStart` is:

```
/usr/bin/bash /root/.cache/infra-lanes/database-loopback-boundary-r5-1581/orchestrator/fleet/db-network-boundary.sh apply
```

That is a **lane worktree**, and it no longer exists. The unit is `Type=oneshot`
with `RemainAfterExit=yes` and last succeeded 2026-08-03 11:03:30, so
`systemctl is-active` still reports `active` while the unit is incapable of
running. The boundary is applied in the running kernel and **would not be
reapplied on reboot** — and `ExecStop` cannot remove it either.

Two failures compound here, which is why it is worth stating separately from F16.
The script is untracked, so a meteorite takes it; and it was deployed from a
disposable tree, so ordinary lane hygiene took it first. A unit pointing into
`$XDG_CACHE_HOME/infra-lanes` is a defect independent of what the script does,
because that root is reaped by design (`branching-policy`, `hygiene/reap.sh`).
Nothing about it is repaired here — the trap list forbids touching the host — but
`--units` now names it on every run.

**F18 — fourteen units in the user manager, none tracked, one enabled. (open)**
`/root/.config/systemd/user` holds 14 unit files rendered from no tracked
template, hidden until now behind an exclusion reading *"this repository installs
system units only"*. `orch-memory-sweep.timer` is **enabled** there (a
`timers.target.wants` symlink, mode 600); `orch-runtime-watchdog.*` is deployed
and not armed.

The user manager is **not running** on this host — `systemctl --user` fails with
`Failed to connect to bus: No medium found` — so `orch-memory-sweep` fires
nothing today. That makes it more important to enumerate, not less: a rebuild
that starts a user manager would begin running a unit nobody chose. Their
`ExecStart` targets *are* tracked (`tools/instructions/memory-sweep.ts`,
`orchestrator/watchdog.sh`), so the gap here is the schedule, not the script.

**F19 — a lane test installed units into the user manager and never removed them. (open)**
Eight of those fourteen point their `ExecStart` into
`$XDG_CACHE_HOME/lane-tmp/tmp.wxKhUSSRVi/…`, a per-lane scratch tree that is
already gone. They are residue from a lane test that deployed units into the real
user manager rather than a fixture, and nothing reaped them — the same unreaped
`lane-tmp` root as F12, which holds 6559 entries. None are armed, so nothing runs.

Recorded rather than tidied, and enumerated one row each rather than as a group,
because the most informative line in `host-units.tsv` is one of them: the residual
`orch-fleet-nudge.service` names `orchestrator/fleet/fleet-nudge.sh`, the exact
path HR-309 claims the script was captured to. It is evidence that the tracked
copy existed in some tree at some point and did not survive into `main`.

**F7 — the dispatch's premise, corrected. (closed by measurement)**
V3-2.9 was dispatched saying `missions` and `lanes` are empty because the fleet
launcher does not write to the state DB. Half right. Missions and lanes *were*
written — into the other database (F1), most recently 2026-08-02. Today's lanes
are in neither, so the launcher gap is real, but the enumeration matters *more*
today, not less: there is already durable operating history on this host that a
rebuild would lose, and it is sitting in the file nobody is looking at.

## What this lane did not do

**Backup and restore.** That is V3-2.10's row and it is untouched. Nothing here
copies, schedules, retains, or restores anything. The `snapshot` subcommand is
only the primitive V3-2.10 needs, plus the proof that the obvious alternative is
wrong.

**`--verify`, `--sweep` and `--units` are not on a timer.** The drift scan runs
in `gate/land.sh`, which is a real executor. The three host-level modes are
operator commands with no automatic caller. Wiring them to a unit needs an armed
timer, and the one that would carry it (`bpa-full-suite.timer`) is deployed and
disabled — so this lane names the gap rather than adding another unarmed unit.
What that costs is stated above under the honest limits, not left for a reader to
infer.

**Nothing was repaired on the host.** F17's boundary service still points into a
deleted worktree and F18's user units are still deployed. This row's obligation is
that the checker **names** them; the decisions belong to the operator and the
orchestrator, and none are made here.

F16 is the exception, and it was closed by other rows rather than by this one:
between round 3 and the 2026-08-05 rebase, V3-2.11 landed the nudge script as
`orchestrator/fleet/fleet-nudge.sh` and V3-2.12 landed its unit templates, so the
armed root timer now runs tracked code. This lane changed no host state to make
that true — it re-measured, found the finding closed, and moved the rows from
`unresolved` to `rebuildable`. The untracked `/root/.local/bin/orch-fleet-nudge.sh`
is still on disk, now unrun and carrying `orphan`.

**Nothing was deleted, moved, pruned or tidied** — including F4's and F13's
directory modes, the two orphan databases, the three untracked fleet scripts
(F8), the secret-bearing env backup (F9), every scratch tree under F12, and the
lane-test unit residue at F19.
`git diff --diff-filter=DR` against `origin/main` is empty for this branch.

## What `--verify` reports on this host today

Rebased onto `main` on 2026-08-05 and re-measured on the host that day; the
numbers below are that measurement, not the round-3 one.

61 state rows and 27 unit rows, 11 verify failures. The failures are real host
conditions, not mechanism defects: `codex-home` 755 (F4), `root-crontab` absent
(F5), `shell-codex-home` 775 (F13), `shell-xdg-state` present-but-empty, and the
`unresolved` exposures — F8 ×3, F11, `systemd-dir`, `user-systemd-units` and the
newly enumerated `oldorch-breakglass`. The units scan adds five more `unresolved`
for F17 and F18.

`--sweep` reports `unlisted=0`, and `--units` reports `unlisted=0 drift=1`. **That
`drift=1` is not new and was not introduced by the rebase**: `orch-morning-report.service`
is armed while its ExecStart target `$INSTALL_ROOT/orchestrator/morning.sh` does
not exist — on the host or at any commit on the v3 line. Round 3 printed
`drift=0` in this document while that condition already held, so the sentence
this paragraph replaces was inaccurate when it was written. The scan was right
and the prose was wrong, which is the direction this whole row exists to catch.

**A row that fails is doing its job.** What is deliberately *not* claimed is that
the enumeration is complete about this host: it is complete about what it scans,
and [what it does not scan](#what-this-enumeration-does-not-claim) is listed
above — other managers, paths outside the declared roots, the content of secrets.
Round 2 printed `unlisted=0` and called the enumeration complete while an armed
root timer ran the fleet from outside git; the difference now is not that the
scans see everything, but that the summary line reports `unresolved` beside
`unlisted`, and that the limits section names its own largest limits instead of
omitting them.
