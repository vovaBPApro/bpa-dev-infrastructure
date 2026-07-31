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

## `/tmp` compatibility check for `PrivateTmp=true`

Before scheduling the daemon restart, the tracked and live daemon source were
searched for `/tmp`, `tmpdir`, socket, Whisper, and ffmpeg use. Voice
transcription creates a private `stt-*` directory through `os.tmpdir()`; ffmpeg
and whisper-cli consume and produce files wholly inside it, and the directory is
removed in `finally`. Telegram-to-tmux paste and `/screen` export each create a
single `/tmp` file, consume it from the same daemon process through tmux or the
Telegram client, and remove it. No daemon Unix-domain socket path uses `/tmp`.
The live daemon's open file descriptors were also inspected; none referenced a
file or Unix socket path under `/tmp`. A private namespace therefore does not
break a cross-service file or socket hand-off in the current implementation.

## Controlled restart plan (not executed by this change)

1. Arrange an attended window with the operator because Telegram is the only
   control channel; keep an independent shell open and record the current unit
   and daemon health.
2. Render the tracked units with `bootstrap/install.sh`, then run
   `systemctl daemon-reload`. Do not use the installer's activation step for
   this attended change because it may restart or start other units.
3. Confirm `systemd-analyze verify /etc/systemd/system/bpa-telegram-daemon.service`
   and inspect `systemctl cat bpa-telegram-daemon.service` for both hardening
   directives.
4. With the operator present, restart only `bpa-telegram-daemon.service` from
   the independent shell. Confirm `active (running)`, Telegram text round-trip,
   a voice-message transcription, `/screen`, and tmux delivery.
5. If any check fails, restore the pre-change unit captured at step 1, run
   `systemctl daemon-reload`, restart only the daemon, and repeat the text
   round-trip. Preserve the failed journal and unit diff as `NO-GO` evidence.

`bootstrap/check-unit-drift.sh` renders every tracked SYSTEM-unit template with
the installation parameters and compares it byte-for-byte with the deployed
unit. `bootstrap/install.sh --verify` now fails when any unit diverges.
