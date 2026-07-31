# As-built systemd units (bpa-infra)

The units **actually deployed** on this host, captured verbatim from
`/etc/systemd/system/`. They are here because of Hard Floor 5
(`instructions/reproducible-from-git.md`): a unit that exists only on the host
cannot survive the meteorite test.

These are `instance/` content — host-specific as-built facts. The portable
templates live in `bootstrap/units/*.in`. The portable desired state now follows
the SYSTEM-unit topology; remaining deliberate deviations are recorded below.

## `bpa-orchestrator.service`

The portable template now reproduces the root account, working directory,
environment file, launch start/stop boundary, timeouts, remain-after-exit, and
`multi-user.target` enablement. It intentionally adds `NoNewPrivileges` and
`PrivateTmp`: the captured host file is evidence of the old unhardened state,
not a requirement to reproduce that security gap.

## `bpa-telegram-daemon.service` — drifted from its template

Deployed vs `bootstrap/units/bpa-telegram-daemon.service.in`:

| aspect | template | as built |
| --- | --- | --- |
| user | `User=root` / `Group=root` | `User=root` / `Group=root` |
| working dir | `$INSTALL_ROOT/daemon` | `/root/bpa-dev-infrastructure/daemon` |
| bun | `$BUN_BIN` | `/usr/local/bin/bun` |
| restart | `always` | `always` |
| extra env | `HOME`; other values via environment file | inline `TELEGRAM_STATE_DIR`, `PATH`, `HOME` |
| `NoNewPrivileges=true` | **present** | **ABSENT** |
| `PrivateTmp=true` | **present** | **ABSENT** |

The last two rows are a **security regression in the running system**: the
template hardens the daemon and the deployed unit does not. This was found by
diffing deployed against template on 2026-07-31 — nothing had ever compared them,
which is the same "nobody re-executed it" shape behind every other infra defect
found that day.

The portable template retains both hardening directives. Inline `PATH` and
`TELEGRAM_STATE_DIR` are not copied: `BUN_BIN` is rendered explicitly and
installation-specific runtime values belong in the mode-0600 environment file.
This is the written justification for those deviations.

The as-built files remain immutable evidence of what was captured. The templates
are the rebuildable desired state and the installer verifies their real SYSTEM
activation.
