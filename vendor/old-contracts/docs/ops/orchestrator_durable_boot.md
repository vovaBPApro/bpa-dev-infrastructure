# Orchestrator Durable Boot

The Telegram-facing orchestrator survives reboot through the user systemd unit
at `deploy/systemd/bpa-orchestrator.service`.

## Enable

```bash
mkdir -p ~/.config/systemd/user
cp deploy/systemd/bpa-orchestrator.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable bpa-orchestrator.service
loginctl enable-linger bpa-shell
```

The unit launches:

```bash
/home/bpa-shell/tools/claude-telegram-daemon/launch-orchestrator.sh \
  --provider claude \
  --session master-orchestrator \
  --workdir /home/bpa-shell
```

The launcher defaults to `claude-fable-5` and honors the last Telegram `/model`
choice persisted in `~/.claude/channels/telegram/daemon/runtime/orchestrator-model`
on the next orchestrator start. `ORCH_MODEL` remains an explicit environment
override and should not be set in the durable unit unless the runtime switch is
intentionally disabled.

## Mission

The dynamic fleet ping reads two layers at send time:

- Human mission: `MISSION: <text>` in Telegram sets
  `runtime/mission-human.txt`; optional suffixes are `| ttl=6h` or
  `| until=2026-07-04T23:00:00Z`.
- Derived status: recomputed from dispatch logs, backlog headers, Telegram
  history, and the latest health snapshot.

`MISSION DONE` or `MISSION CLEAR` clears the Human layer. If no Human mission is
active, the ping emits the standing ladder: land plans, clear backlog/bugs,
tests-to-green, then idle for a new mission.

## Cron

Run `tools/orchestrator/install-orchestrator-cron.sh` after checkout updates. It
installs:

- 30-minute dynamic fleet ping.
- 30-minute health snapshot run.
- 10-minute landed-shard reaper.

The installer removes this repo's older `maintenance-ping.sh` and
`orchestrator-maintenance-audit.sh` cron entries. It preserves unrelated lines,
including `orchestrator-hourly-compact.sh`, whose purpose is context compaction.

Crontab entries persist across reboot. Firewall persistence is handled outside
this repo via `netfilter-persistent`.
