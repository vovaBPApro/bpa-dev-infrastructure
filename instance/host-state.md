# Non-git host state on this installation

Hard Floor 5 (`instructions/reproducible-from-git.md`) says host state that must
not be in git is **enumerated instead** — *"not in git is never allowed to mean
not written down"*. Until 2026-08-04 that obligation had never been discharged.
`meteorite/run.sh` proves the repository rebuilds a **host**; it says nothing
about the state that host accumulated. Rebuild this machine from git tomorrow
and you get every script, unit, rule and decision — and no answer to "what was
in flight and why".

This document is the narrative half. The binding data is
[`host-state.tsv`](host-state.tsv): 55 rows, each naming a location, what writes
it, whether a rebuild needs it, and **the exact command that decides whether it
is present and sound**. [`host-state-exclusions.tsv`](host-state-exclusions.tsv)
is the other half of the enumeration — the locations that were looked at and the
reason each needs no row of its own. Neither file is a snapshot:
`tools/check-host-state.ts` fails closed when they disagree with the code, and
again when they disagree with the host.

## How to use it

```sh
bun tools/check-host-state.ts                      # manifest lint + drift scan (the gate runs this)
bun tools/check-host-state.ts --sweep              # walk this host for anything unlisted
bun tools/check-host-state.ts --verify             # run every row's own command, then sweep
bun tools/check-host-state.ts --verify --only lane-root
bun tools/check-host-state.ts snapshot <db> <dst>  # WAL-correct sqlite copy
```

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

### The honest limits of both scans

- **Scope is `$HOME`, the XDG roots, `/root`, `/home`, `/var/lib`, `/var/log`,
  `/var/spool/cron` and `/etc/systemd`.** `/usr` and `/bin` belong to the
  distribution. `/tmp` is excluded by construction: it does not survive a reboot,
  so it cannot hold state a rebuild restores.
- **The name claim is the sweep's real boundary.** A future directory belonging
  to this installation but sitting under a shared root *without* `bpa` in its
  name stays invisible to the sweep. That is a deliberate trade against
  false-positive churn, and it is the first thing to revisit if something is
  found missing.
- **The sweep has no automatic caller.** `--verify` and `--sweep` are operator
  commands; the gate runs the drift scan only. So a file that appears on the
  host between manual runs is not detected until the next one. Wiring it to a
  unit needs a timer that is actually armed, and on this host no bpa timer is
  (F5, V3-2.1).
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

**`--verify` and `--sweep` are not on a timer.** The drift scan runs in
`gate/land.sh`, which is a real executor. The two host-level modes are operator
commands with no automatic caller. Wiring them to a unit needs a timer that is
actually armed, and on this host no bpa timer is (F5, V3-2.1). Naming that rather
than adding a twelfth unarmed unit. What that costs is stated above under the
honest limits, not left for a reader to infer.

**Nothing was deleted, moved, pruned or tidied** — including F4's and F13's
directory modes, the two orphan databases, the three untracked fleet scripts
(F8), the secret-bearing env backup (F9), and every scratch tree under F12.
`git diff --diff-filter=DR` against `origin/main` is empty for this branch.

## What `--verify` reports on this host today

55 rows, 7 failing, and every failure is a real host condition rather than a
mechanism defect: `codex-home` 755 (F4), `root-crontab` absent (F5), the four
`unresolved` exposures (F8 ×3, F11), and `shell-codex-home` 775 (F13). The sweep
reports 0 unlisted. A row that fails is doing its job; the enumeration is
complete, and what it enumerates includes things that should not be true.
