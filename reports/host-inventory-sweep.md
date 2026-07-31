# Host inventory sweep — 2026-07-31

## Scope and method

This is a read-only inventory of the running host, compared with git commit
`288aeab99e5342727657d66db9cfd2f3eec7b75d`. It deliberately records no secret
values. The two radioactive files named by the mission were inspected with
`find`/`stat` only; their contents were never read.

Re-run from a lane checkout on this host (as root), then compare the output and
this table. The commands avoid environment dumps and secret contents:

```sh
find /etc/systemd/system -maxdepth 3 \( -type f -o -type l \) -print | sort
rg -l -i 'bpa|orchestrator|infra-lanes|telegram-daemon|morning-report|full-suite' /etc/systemd/system
systemctl is-enabled bpa-orchestrator.service bpa-telegram-daemon.service orch-fleet-nudge.timer
systemctl is-active bpa-orchestrator.service bpa-telegram-daemon.service orch-fleet-nudge.timer
loginctl show-user root -p Linger -p State
find /root/.config/systemd /root/.local/share/systemd -maxdepth 4 -printf '%y %M %u:%g %p -> %l\n' 2>/dev/null | sort
crontab -l; atq
find /etc/cron.d /var/spool/cron /var/spool/cron/crontabs -maxdepth 2 -type f -print 2>/dev/null | sort
find /root/.local/bin /root/bin -xdev -type f -perm /111 -printf '%M %u:%g %s %p\n' 2>/dev/null | sort
find /root/.config/bpa /root/.claude/channels/telegram /root/.cache/infra-lanes /opt/whisper.cpp -maxdepth 2 -printf '%y %M %u:%g %s %p -> %l\n' 2>/dev/null | sort
bun --version; codex --version; claude --version; /opt/whisper.cpp/bin/whisper-cli --version
ffmpeg -version | head -n 1; docker --version; git --version
find /etc -xdev -type f -newermt '2026-07-28' -printf '%TY-%Tm-%TdT%TH:%TM %M %u:%g %p\n' 2>/dev/null | sort
systemd-delta --type=extended
```

For deployed unit comparison, inspect only the four relevant unit files and
compare structural directives with `bootstrap/units/*.in`; redact
`Environment=` and `EnvironmentFile=` values before retaining output. Package
ownership (`dpkg-query -S`) and creation-era mtimes distinguish distribution or
Hetzner image files under `/etc` from installation-specific files. This is an
enumeration control, not proof of provenance for files whose package/image
baseline is unavailable; the prioritized list calls out that remaining gap.

## Classified inventory

Every row has exactly one classification. A row may group homogeneous entries
that share one lifecycle (for example, all lane logs); the entry column states
the complete grouping rule.

| Surface | Entry on host | Classification | Git comparison, disposition, and verification |
|---|---|---|---|
| systemd (system) | `/etc/systemd/system/bpa-telegram-daemon.service` and enablement symlink | MUST-TRACK | Active/enabled legacy system unit; no matching system-unit template or install path. It differs from `bootstrap/units/bpa-telegram-daemon.service.in`: system rather than user manager; `User=root`, `Group=root`, three inline `Environment=` entries, `/root/...` working directory, `/usr/local/bin/bun server.ts`, `Restart=always`, `TimeoutStopSec=20`, `WantedBy=multi-user.target`; lacks `NoNewPrivileges=true` and `PrivateTmp=true`; template uses one `EnvironmentFile`, `$BUN_BIN run server.ts`, `Restart=on-failure`, and `WantedBy=default.target`. Verify with `systemctl cat bpa-telegram-daemon.service` after redacting environment values. Includes known W-17 plus additional drift.
| systemd (system) | `/etc/systemd/system/bpa-orchestrator.service` | MUST-TRACK | Present but disabled/inactive; no template in `bootstrap/units`. It contains system-level ownership, three inline environment entries, an environment file, `/root/bpa-dev-infrastructure`, and `launch.sh start/stop`; it lacks both security directives. Decide in a later change whether to template it or remove it; this sweep does not fix it.
| systemd (system) | `/etc/systemd/system/orch-fleet-nudge.service` | MUST-TRACK | Enabled indirectly by its timer and invokes `/root/.local/bin/orch-fleet-nudge.sh`; no tracked unit template/install step. Mode is `0600`, unusual for a deployed unit. No sandboxing directives.
| systemd (system) | `/etc/systemd/system/orch-fleet-nudge.timer` and `timers.target.wants` symlink | MUST-TRACK | Enabled/active ten-minute stopgap timer, absent from git. Unit behavior is host-only even though the invoked script is tracked.
| systemd (user) | root user manager and root user unit directories | TRANSIENT | `loginctl` says root state active, `Linger=no`; `systemctl --user` has no bus and `/root/.config/systemd` plus `/root/.local/share/systemd` do not exist. There are therefore no deployed user units to compare. Manager/session availability is runtime state.
| systemd (expected but absent) | daemon, watchdog, full-suite and morning-report user units rendered by `bootstrap/install.sh` | MUST-TRACK | Six templates exist in git, but none is deployed on this host. Git's installer defaults to `/home/bpa-dev-infrastructure`, Bun 1.3.14 and user systemd, whereas the live installation is `/root/bpa-dev-infrastructure`, Bun 1.2.22 and system systemd. The tracked install/verify path does not describe the live topology.
| cron | root user crontab | TRANSIENT | `crontab -l` reports no crontab. Absence is runtime state. Notably, tracked `hygiene/install-cron.sh` is not deployed.
| cron | `/etc/crontab`, `/etc/cron.d/{e2scrub_all,sysstat}`, standard periodic directories | TRANSIENT | Distribution-owned schedules; none references BPA, the orchestrator, lanes, or Telegram. They are base-host state, not this installation's source.
| cron | other users | TRANSIENT | Only login-capable accounts are `root` and `sync`; no per-user spool files exist. `sync` has no operational BPA schedule.
| at | `/var/spool/cron/atjobs/.SEQ`; empty `atq` | TRANSIENT | Queue bookkeeping only; no queued job.
| external scripts | `/root/.local/bin/orch-fleet-nudge.sh` | TRACKED | SHA-256 exactly matches `orchestrator/fleet/fleet-nudge.sh`. The copied deployment is reproducible only after its missing unit/install mechanism is tracked. Verify with `sha256sum` on both paths.
| external scripts | all other executable regular files directly under `/root/.local/bin` or `/root/bin` | TRANSIENT | None exist. (`bun`, `codex`, and `claude` are separately inventoried installed binaries.)
| BPA config | `/root/.config/bpa/orchestrator.env` (mode `0600`) | ENUMERATE | Host-supplied runtime values; do not commit contents. Onboarding must name the path, owner/mode, required variable names, and a non-printing verification command such as `test -f ... && test "$(stat -c %a ...)" = 600`.
| BPA config | `/root/.config/bpa/gcp-sa-bpa-automations.json` (mode `0600`) | ENUMERATE | Radioactive service-account credential. Existence and metadata only were inspected. Onboarding must name purpose/path/permissions and use `test -s` plus `stat`; never print or parse values into evidence.
| BPA config | `/root/.config/bpa/orchestrator.env.bak-20260730` and `backups/runtime.env.bak-20260731*` | TRANSIENT | Host-local secret-bearing backups. They must never enter git and are not required to rebuild when canonical inputs are provisioned; a retention/removal policy is missing (separate MUST-TRACK row below).
| BPA state | `/root/.config/bpa/orchestrator-state.sqlite` (mode `0644`) | MUST-TRACK | Durable operational database location is neither the installer's default nor documented as a recovery input. The data itself must not be committed, but its backup/restore mechanism, location, ownership, and restrictive permissions must be tracked. World-readable mode is a recorded security drift.
| Telegram config | `/root/.claude/channels/telegram/.env` (mode `0600`) | ENUMERATE | Radioactive secret file; metadata only inspected. Onboarding must list path, required names, permissions, and non-printing verification.
| Telegram config | `/root/.claude/channels/telegram/access.json` (mode `0600`) | ENUMERATE | Host-specific authorization/allowlist data. Do not commit values; enumerate schema/purpose/path and verify regular file, owner, mode, and non-empty status without echoing contents.
| Telegram runtime | `daemon.pid` and `daemon/runtime/{orchestrator-binding.json,turn-deliveries.json,mission-inbox.log}` | TRANSIENT | Process identity, delivery journal and runtime queue/binding generated by the daemon. Disposable as files for rebuild; recovery semantics and retention should come from tracked code. No contents were retained.
| Telegram inbox | all seven current files under `inbox/` (`4 *.jpg`, `2 *.oga`, `1 *.md`) | TRANSIENT | Received operator media/message artifacts. Runtime inputs may be processed, but raw chat exports/media must not enter git; they are not installation prerequisites.
| lane cache | every top-level `ag-*` and `review-*` directory under `/root/.cache/infra-lanes` | TRANSIENT | Isolated git worktrees created from repository refs. They are disposable after accepted landing and conservative reaping; source of truth is git plus durable mission state.
| lane cache | every top-level `pack-*` directory | TRANSIENT | Materialized instruction packs generated by tracked compose tooling; reproducible and disposable.
| lane cache | all top-level `lane-*.log`, `fleet-nudge.log`, `probe.log` | TRANSIENT | Host runtime logs (64 `.log` files at sweep time), never git inputs; retention/reaping must be mechanized.
| lane cache | all top-level `lane-*.prompt.md` and the one lane report markdown | TRANSIENT | Generated prompts/raw lane delivery artifacts (63 `.md` files at sweep time); not source and forbidden as chat/session exports. Durable accepted evidence belongs in the governed evidence path.
| Whisper install | `/opt/whisper.cpp/bin/whisper-cli` and `.version` | TRACKED | Installed artifact is version 1.9.1 and is reproducible through pinned `tools/whisper/install.sh`; verify with `whisper-cli --version` and the installer's smoke test. Binary itself is host output, not committed.
| Whisper models | `/opt/whisper.cpp/models/{ggml-large-v3-turbo.bin,ggml-medium.bin}` | TRACKED | Generated/downloaded artifacts with pinned checksums and installation logic in `tools/whisper/install.sh`; disposable and reproducible, not committed.
| binary | `/usr/local/bin/bun`, version 1.2.22 | ENUMERATE | Host-installed runtime. Git documents installation but pins 1.3.14, so the live version is drift. Verification: `bun --version`. Version policy/live upgrade is a later fix.
| binary | `/usr/local/bin/codex` -> global npm package, `codex-cli 0.144.3` | MUST-TRACK | Required by orchestrator but no pinned install/upgrade/verify procedure was found. The symlink is host output; the missing dependency declaration is what must be tracked.
| binary | `/usr/local/bin/claude` -> global npm package, Claude Code 2.1.220 | MUST-TRACK | Required provider CLI but no pinned install/upgrade/verify procedure was found.
| binary | `/opt/whisper.cpp/bin/whisper-cli`, version 1.9.1 | TRACKED | Covered by the pinned installer above.
| binary | `/usr/bin/ffmpeg`, version 6.1.1-3ubuntu5 | TRACKED | `tools/whisper/install.sh` installs/checks it and explains its role. Verify with `ffmpeg -version`.
| binary | `/usr/bin/docker`, version 29.1.3 (`docker.io` package) | MUST-TRACK | Used by stands/gates and bootstrap verifies only presence/version; no clean-host Docker engine installation/configuration procedure or version policy is present in the inspected onboarding path.
| binary | `/usr/bin/git`, version 2.43.0 | TRACKED | Bootstrap installs/checks git through apt. Verify with `git --version`.
| `/etc` installation files | the four BPA/orchestrator unit files and two enablement symlinks listed above | MUST-TRACK | These are the only project-specific files found by name/content search plus July 30–31 creation mtimes. Their individual dispositions are above.
| `/etc` base/image files | Hetzner/netplan/SSH host keys, machine identity, host/network/grub/mdadm/fstab/sysctl/timesyncd files dated July 29; locale/PAM account files dated July 30; package-generated `/etc/ld.so.cache` | TRANSIENT | Host/provider/OS state, not added by this BPA installation. Secrets such as SSH private host keys are host-provisioned and must not be committed. They are outside BPA operational dependency except ordinary OS/network availability.
| `/etc` overrides | nine entries reported by `systemd-delta`, all vendor/runtime extensions (`mdcheck`, Debian/systemd/netplan) | TRANSIENT | None references this installation; no BPA-specific override/drop-in exists beyond the standalone units already listed.
| installation provenance | authoritative manifest of files this installation added/modified under `/etc` | MUST-TRACK | Current attribution relies on targeted content search, mtimes, package ownership and image knowledge. Add a tracked install manifest/check command so future sweeps can prove a complete `/etc` diff against a known clean baseline rather than infer it.
| secret/runtime retention | backup and raw-runtime lifecycle for BPA config, Telegram inbox/runtime, and lane cache | MUST-TRACK | Git has general hygiene/reaping rules, but the observed secret backups and Telegram runtime/inbox lack a host-specific bounded retention and cleanup inventory. Track paths and safe dry-run verification, never values.

## Prioritized MUST-TRACK list

1. **P0 — reconcile deployed service topology with git.** Track the real
   system-level deployment or deliberately migrate it through a separately
   reviewed change. Account for `bpa-telegram-daemon.service`,
   `bpa-orchestrator.service`, both fleet-nudge units, enablement, root install
   path, Bun path, and security directives. The current tracked user-unit
   installer cannot recreate the running host.
2. **P0 — durable state and secrets inventory.** Document and mechanize backup,
   restore, owner/mode and non-printing checks for
   `orchestrator-state.sqlite`; enumerate `orchestrator.env`, the GCP service
   account, Telegram `.env`, and `access.json`. Do not commit their values.
3. **P1 — dependency bootstrap parity.** Add pinned or policy-governed install
   and verify procedures for Codex CLI, Claude Code, and Docker; reconcile live
   Bun 1.2.22 with tracked Bun 1.3.14.
4. **P1 — installation manifest.** Make the installer emit or verify a tracked
   manifest of installation-owned `/etc` files so later host sweeps are a real
   clean-baseline diff.
5. **P2 — bounded retention.** Define safe retention/dry-run cleanup for secret
   backups, Telegram inbox/runtime artifacts, lane logs/prompts/packs, and the
   temporary fleet-nudge deployment after its replacement lands.

No remediation was performed by this lane.
