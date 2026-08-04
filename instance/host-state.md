# Non-git host state on this installation

Hard Floor 5 (`instructions/reproducible-from-git.md`) says host state that must
not be in git is **enumerated instead** — *"not in git is never allowed to mean
not written down"*. Until 2026-08-04 that obligation had never been discharged.
`meteorite/run.sh` proves the repository rebuilds a **host**; it says nothing
about the state that host accumulated. Rebuild this machine from git tomorrow
and you get every script, unit, rule and decision — and no answer to "what was
in flight and why".

This document is the narrative half. The binding data is
[`host-state.tsv`](host-state.tsv): 31 rows, each naming a location, what writes
it, whether a rebuild needs it, and **the exact command that decides whether it
is present and sound**. [`host-state-exclusions.tsv`](host-state-exclusions.tsv)
is the other half of the enumeration — the locations that were looked at and the
reason each needs no row of its own. Neither file is a snapshot:
`tools/check-host-state.ts` fails closed when the two disagree with the code.

## How to use it

```sh
bun tools/check-host-state.ts                      # manifest lint + drift scan (the gate runs this)
bun tools/check-host-state.ts --verify             # run every row's own command against this host
bun tools/check-host-state.ts --verify --only lane-root
bun tools/check-host-state.ts snapshot <db> <dst>  # WAL-correct sqlite copy
```

`--verify` executes the `verify` column verbatim. There is deliberately no
second version of those commands: what the manifest documents and what the
checker runs are the same string, so they cannot drift apart.

## What keeps it from going stale

The mechanism inventory went stale because it was a snapshot with no checker
(V3-0.42); the decision ledger did the same until it got one. So the drift scan
runs in **both directions**:

- **Forward.** Every host path the tracked code names — after comments are
  stripped, and including the `join(homedir(), …)` forms the daemon builds — must
  be covered by a row or an exclusion. Teaching the system to write somewhere new
  without enumerating it cannot land.
- **Reverse.** A row naming tracked writers is re-checked against those files. A
  row survives the deletion of the code it describes only if someone deletes the
  row too.

Comments are stripped first, deliberately. V3-0.28 was reopened because the
reachability checker accepted a code comment as an executor; a detector that
reads prose is not a detector.

### The honest limits of the scan

- **Scope is `$HOME`, the XDG roots, `/root`, `/home`, `/var/lib`, `/var/log`,
  `/var/spool/cron` and `/etc/systemd`.** `/usr` and `/bin` belong to the
  distribution. `/tmp` is excluded by construction: it does not survive a reboot,
  so it cannot hold state a rebuild restores.
- **A path assembled entirely from variables is invisible to it.** The manifest
  records those as `external:` writers, which costs the reverse check on that row.
  That is a real gap, not a solved problem.
- **`install-root` is a broad row.** It covers anything new under the canonical
  checkout — bounded in practice by `.gitignore`, whose only runtime entries
  (`orchestrator/runtime/`, `/runtime/`) both have their own rows.
- **`ephemeral`, `orphan` and `optional` rows cannot fail on absence**, because
  for them absence is the correct reading. They still fail on damage — something
  present and empty or unparseable, which a restore would silently accept.

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

**`--verify` is not on a timer.** The drift scan runs in `gate/land.sh`, which is
a real executor. The host-level `--verify` mode is an operator command with no
automatic caller — so the *enumeration* cannot go stale, but a row can become
false on the host between manual runs. Wiring it to a unit needs a timer that is
actually armed, and on this host no bpa timer is (F5, V3-2.1). Naming that rather
than adding a twelfth unarmed unit.

**Nothing was deleted, moved, pruned or tidied** — including F4's directory mode
and the two orphan databases.
