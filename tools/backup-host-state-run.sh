#!/usr/bin/env bash
# The scheduled face of tools/backup-host-state.ts: run the backup, and make a
# failure reach the operator instead of dying in the journal.
#
# WHY A WRAPPER EXISTS AT ALL (workboard V3-5.39, operator design HR-2171)
#
# The backup mechanism landed able to run, and ran only when a human typed the
# command. HR-2171 asks for a rhythm -- write locally, copy off-host
# periodically, keep about ten versions -- so bpa-backup-host-state.timer fires
# this hourly. The moment it is unattended, the failure mode changes shape: a
# backup that stops working looks EXACTLY like a backup that is working, because
# both are silent, and the difference only surfaces on the day someone needs to
# restore. That is the single most expensive silence in this repository, so the
# only acceptable outcome of a failed run is that the operator is told.
#
# HOW IT TELLS HIM -- the same path a failing watchdog uses today
# (orchestrator/fleet/fleet-nudge-liveness.sh): POST to the daemon's /notify,
# which relays to Telegram. Deliberately not a new channel: a second alert
# transport is a second thing that can be quietly broken, and this one is
# already exercised every minute by the fleet alarm.
#
# DEDUPLICATED, because hourly is 24 messages a day. An episode raises AT MOST
# ONCE and says so again only when it repairs. That pairing is not politeness --
# a raise with no clear teaches the operator that a message means nothing,
# because he can never tell whether the condition is still true. State lives
# under /run (tmpfs), so a reboot forgets the episode and a standing failure
# re-announces itself once. That is the correct direction to fail: a repeated
# alert is noise, a swallowed one is a backup nobody is taking.
#
# EVERY EXIT IS LOUD SOMEWHERE. The script's own status is non-zero whenever the
# backup did not succeed, whether or not the operator could be reached, so the
# unit is `failed` in systemd even when Telegram is down. If the notification
# itself fails, the episode state is deliberately NOT written: the next firing
# tries again rather than treating "we failed to tell him" as "he has been
# told".
#
# THE KILL CASE. A run stopped by the unit's TimeoutSec takes this script with
# it, so the SIGTERM trap below is what turns that into a message; without it
# the one failure that produces no output would also produce no alert. A kill is
# not a pass (instructions/verification-and-locks.md), and it must not be a
# silence either. The residual gap is SIGKILL, which no in-process handler can
# survive; systemd sends it only after the stop timeout, and the unit is left
# `failed` for the drift/status surfaces to show.
#
# The passphrase: this script never reads, prints, or copies it. It passes no
# passphrase argument at all -- the tool resolves the PATH from
# instance/params.yaml `backup.passphrase_file`, which is where that decision
# has one home.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Derived from this file's own location, never named: the script is launched
# from a tracked path inside the repository it backs up, and a second copy of
# the install root is a second thing to keep in sync (HR-309).
REPO="${BACKUP_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TOOL="${BACKUP_TOOL:-$REPO/tools/backup-host-state.ts}"
BUN="${BACKUP_BUN_BIN:-bun}"
DAEMON="${BACKUP_DAEMON:-http://127.0.0.1:4822}"
ALERT_STATE="${BACKUP_ALERT_STATE:-/run/bpa-orchestrator/backup-host-state.alerted}"
# How much of the tool's last line rides along in the operator message. Bounded
# because he reads on a phone (instructions/operator-feedback.md) and because an
# unbounded tail is an unbounded thing to put in a chat message.
DETAIL_LIMIT="${BACKUP_DETAIL_LIMIT:-200}"

log() { printf 'BACKUP-RUN %s\n' "$*"; }

# JSON-escaped through python3 exactly as the fleet alarm does, so one idiom
# covers both alert producers. A missing python3 is a hard failure here: silently
# posting an unescaped body would either be rejected by the daemon or, worse,
# accepted as a truncated message that reads as reassurance.
notify() { # text
  if ! command -v python3 >/dev/null 2>&1; then
    log "NO-GO cannot notify: python3 is required to encode the message"
    return 1
  fi
  if ! curl -fsS -m 10 -X POST "$DAEMON/notify" -H 'Content-Type: application/json' \
    --data "$(printf '{"text":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null; then
    log "NO-GO operator notification failed (daemon=$DAEMON)"
    return 1
  fi
}

# Raise once per episode. Returns non-zero when the operator could NOT be told,
# and leaves the episode unrecorded in that case so the next firing retries.
raise() { # text
  if [[ -e "$ALERT_STATE" ]]; then
    log "alert already raised for this episode: $ALERT_STATE"
    return 0
  fi
  notify "$1" || return 1
  if ! mkdir -p "$(dirname "$ALERT_STATE")" || ! : >"$ALERT_STATE"; then
    # He has been told; only the bookkeeping failed. Say so and carry on rather
    # than converting a delivered alert into a second failure.
    log "WARN could not record the alert episode at $ALERT_STATE"
  fi
  return 0
}

clear_alert() { # text
  [[ -e "$ALERT_STATE" ]] || return 0
  notify "$1" || return 1
  rm -f "$ALERT_STATE"
}

output="$(mktemp "${TMPDIR:-/tmp}/backup-host-state-run.XXXXXX")"
trap 'rm -f "$output"' EXIT

# systemd's stop timeout kills this script alongside the tool. Turn that into
# the same message any other failure produces; `exit` inside the handler is what
# stops bash from resuming as if nothing happened.
on_terminated() {
  log "NO-GO run terminated by signal — the hourly archive was not created"
  raise "⚠️ Бекап host-state перервано (таймаут або зупинка юніта). Архів за цю годину не створено. journalctl -u bpa-backup-host-state.service"
  exit 143
}
trap on_terminated TERM INT

log "starting: repo=$REPO tool=$TOOL"
"$BUN" "$TOOL" --repo "$REPO" >"$output" 2>&1
rc=$?
# Straight to the journal, unpiped: this is the evidence for whichever run the
# operator ends up reading about.
cat "$output"

if ((rc == 0)); then
  log "clean exit=0"
  if ! clear_alert "✅ Бекап host-state знову проходить. Alert cleared."; then
    log "NO-GO the recovery message did not reach the operator"
    exit 4
  fi
  exit 0
fi

# The last non-empty line is the tool's own verdict ("HOST-STATE ..."), which is
# the actionable half of the message. Bounded, and never the passphrase: the
# tool takes a path and prints paths, never the value behind one.
detail="$(grep -v '^[[:space:]]*$' "$output" | tail -n 1 | cut -c "1-$DETAIL_LIMIT")"
log "NO-GO backup failed exit=$rc"
if ! raise "⚠️ Бекап host-state впав (код $rc). ${detail:-без виводу}. Архів за цю годину не створено. journalctl -u bpa-backup-host-state.service"; then
  log "NO-GO the failure message did not reach the operator; the episode stays unrecorded so the next run retries"
  exit 4
fi
exit "$rc"
