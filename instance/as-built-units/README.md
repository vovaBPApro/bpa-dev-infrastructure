# As-built systemd units (bpa-infra)

The units **actually deployed** on this host, captured verbatim from
`/etc/systemd/system/`. They are here because of Hard Floor 5
(`instructions/reproducible-from-git.md`): a unit that exists only on the host
cannot survive the meteorite test.

These are `instance/` content — host-specific as-built facts. The portable
templates live in `bootstrap/units/*.in`. **The two disagree**, which is recorded
below rather than hidden.

## `bpa-orchestrator.service`

Was **not in the repository at all** until 2026-07-31. It is the unit that starts
the orchestrator tmux session (`orchestrator/launch.sh start`), and
`bootstrap/units/` has no template for it. A rebuild from git alone would have
produced a host with a running daemon and no way to start the orchestrator except
by hand — which is precisely the outage shape the old orchestrator hit on
2026-07-30 (daemon up, orchestrator dead, only the Human able to revive it).

## `bpa-telegram-daemon.service` — drifted from its template

Deployed vs `bootstrap/units/bpa-telegram-daemon.service.in`:

| aspect | template | as built |
| --- | --- | --- |
| user | unset | `User=root` / `Group=root` |
| working dir | `$INSTALL_ROOT/daemon` | `/root/bpa-dev-infrastructure/daemon` |
| bun | `$BUN_BIN` | `/usr/local/bin/bun` |
| restart | `on-failure` | `always` |
| extra env | — | `TELEGRAM_STATE_DIR`, `PATH`, `HOME` |
| `NoNewPrivileges=true` | **present** | **ABSENT** |
| `PrivateTmp=true` | **present** | **ABSENT** |

The last two rows are a **security regression in the running system**: the
template hardens the daemon and the deployed unit does not. This was found by
diffing deployed against template on 2026-07-31 — nothing had ever compared them,
which is the same "nobody re-executed it" shape behind every other infra defect
found that day.

**Not silently fixed here.** Restoring `NoNewPrivileges`/`PrivateTmp` changes the
runtime behaviour of the live daemon (`PrivateTmp` in particular gives the unit a
private `/tmp`, which can break anything sharing paths through it) and the daemon
is the Human's only channel. It needs its own lane with a restart plan and an
external recovery backstop, not an in-passing edit. Recorded as a workboard row.

## Reconciliation is owed

`ag-onboarding-truth` owns making a fresh host reproduce this one. These files
are the ground truth it must reconcile against: either the templates are updated
to match reality, or the deviations are justified in writing. Do not treat this
directory as the desired end state — it is the honest record of what is running.
