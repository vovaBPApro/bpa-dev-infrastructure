#!/usr/bin/env bash
# External orchestrator watchdog — single-shot, driven by launchd every 600s.
#
# WHY launchd and not an internal loop: this must be MORE reliable than the
# orchestrator AND the daemon. launchd restarts it on crash and on reboot, so it
# ticks like a clock regardless of what the orchestrator/daemon are doing.
#
# Each tick:
#   1. If the "done" sentinel exists, rest (the Human confirmed completion).
#   2. Verify the daemon and the orchestrator tmux session are alive; escalate
#      to Telegram (via the daemon /notify endpoint) if not.
#   3. Compute a progress signature (dev HEAD + commit count + tmux pane tail).
#   4. If progress moved since last tick: record it, reset stall + restart state.
#      If it did NOT move: nudge the orchestrator in tmux. After STALL_TICKS
#      consecutive stalls escalate to Telegram, and — because a nudge cannot
#      un-wedge a TUI that is hung on a background terminal and queues all input
#      — RESTART the orchestrator (kill + relaunch), throttled by a cooldown so
#      it cannot thrash.
#
# Escalation has NO bot token of its own: it POSTs to the daemon /notify
# endpoint, and the daemon (which holds the token) relays to the bound chat.
#
# Pause/resume:
#   touch  "$STATE_DIR/runtime/orchestrator-done"   # rest (Human-confirmed done)
#   rm -f  "$STATE_DIR/runtime/orchestrator-done"    # resume autonomous nudging
set -u

STATE_DIR="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram/daemon}"
REPO="${ORCH_GIT_REPO_PATH:-$HOME/BPAprojects/agent-bill}"
REF="${ORCH_GIT_REF:-dev}"
PORT="${TELEGRAM_DAEMON_PORT:-4822}"
RUNTIME="$STATE_DIR/runtime"
STATE_FILE="$RUNTIME/watchdog-state"
LOG="$RUNTIME/watchdog.log"
DONE_SENTINEL="$RUNTIME/orchestrator-done"
LOWPAR_FILE="$RUNTIME/watchdog-lowpar"
MISSION_INBOX="$RUNTIME/mission-inbox.log"   # daemon-written ground truth of Human tasks
MISSION_FILE="$RUNTIME/mission.txt"          # standing mission (resume-on-restart)
mkdir -p "$RUNTIME"

# Night mode: the Human is asleep (local 22:00–07:00) and cannot intervene, so be
# STRICTER — hold more agents, react to stalls faster, restart sooner. By day,
# looser defaults (the Human is around to steer).
HOUR=$((10#$(date +%H)))
if [ "$HOUR" -ge 22 ] || [ "$HOUR" -lt 7 ]; then
  NIGHT=1
  STALL_TICKS="${ORCH_WATCHDOG_STALL_TICKS_NIGHT:-2}"        # act at ~20min
  RESTART_COOLDOWN="${ORCH_WATCHDOG_RESTART_COOLDOWN_NIGHT:-900}"  # 15min between restarts
  MIN_AGENTS="${ORCH_WATCHDOG_MIN_AGENTS_NIGHT:-12}"
else
  NIGHT=0
  STALL_TICKS="${ORCH_WATCHDOG_STALL_TICKS:-3}"              # act at ~30min
  RESTART_COOLDOWN="${ORCH_WATCHDOG_RESTART_COOLDOWN:-1800}" # 30min between restarts
  MIN_AGENTS="${ORCH_WATCHDOG_MIN_AGENTS:-8}"
fi

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"; }

SESSION=""
[ -f "$STATE_DIR/.env.session" ] && SESSION="$(grep -E '^CLAUDE_TMUX_SESSION=' "$STATE_DIR/.env.session" | head -1 | cut -d= -f2-)"
# Fall back to the persisted binding (same source the daemon now hydrates from).
if [ -z "$SESSION" ] && [ -f "$RUNTIME/orchestrator-binding.json" ]; then
  SESSION="$(grep -oE '"tmux_session"[[:space:]]*:[[:space:]]*"[^"]*"' "$RUNTIME/orchestrator-binding.json" | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"
fi

# Escalate to the Human via the daemon (token lives only in the daemon).
tg() {
  curl -s -m 10 -o /dev/null -X POST --data-binary "$1" \
    "http://127.0.0.1:${PORT}/notify" && return 0
  log "escalation via /notify failed: $1"
  return 1
}

restart_orchestrator() {
  log "RESTART: requesting daemon /orchestrator/restart"
  curl -s -m 60 -o /dev/null -X POST "http://127.0.0.1:${PORT}/orchestrator/restart" \
    && { log "RESTART ok"; return 0; } || { log "RESTART request failed"; return 1; }
}

STALL_MSG='[watchdog] No progress on `dev`. Do NOT idle and do NOT run long test loops as a background terminal in your own TUI (that wedges you). Drive the task: dispatch agents (scripts/dispatch-agent.sh) or commit this turn. If a background run is hung, kill it and re-dispatch.'

# nudge "<message>" — paste a line into the orchestrator TUI and submit it.
nudge() {
  local msg="$1"
  [ -n "$SESSION" ] || { log "nudge skip: no tmux session"; return 1; }
  tmux has-session -t "$SESSION" 2>/dev/null || { log "nudge skip: session $SESSION dead"; return 1; }
  local buf="/tmp/orch-watchdog-nudge.$$"
  printf '%s\n' "$msg" > "$buf"
  tmux load-buffer -b orch_watchdog "$buf" 2>/dev/null
  tmux paste-buffer -t "$SESSION" -b orch_watchdog -d 2>/dev/null
  sleep 0.2
  tmux send-keys -t "$SESSION" Enter 2>/dev/null
  # codex queues input and flushes on Escape (not Enter); send Esc only if queued.
  sleep 0.5
  tmux capture-pane -t "$SESSION" -p -S -15 2>/dev/null \
    | grep -qiE 'to be submitted after next tool call|edit last queued message' \
    && tmux send-keys -t "$SESSION" Escape 2>/dev/null
  rm -f "$buf"
  log "nudged orchestrator: ${msg%%.*}."
}

# ── 1. Rest if the Human said /done ──────────────────────────────────────────
# /done sets this sentinel. It rests the watchdog until the Human gives a NEW
# directive — the daemon clears it on the next inbound message (mission-inbox
# capture). NO auto-expiry on purpose: "done" is intentional and must hold until
# real new work arrives; an expiry would resume burning quota on backlog hours
# later on its own. Resuming is the Human's call (just message the orchestrator).
if [ -f "$DONE_SENTINEL" ]; then
  log "rest: /done sentinel present — passive until the Human sends a new task"
  exit 0
fi

# ── 1b. Open mission? ALL enforcement below is gated on this ─────────────────
# With no open task (fresh start, or after /done cleared it) the watchdog stays
# passive: it will NOT nudge, restart, or push parallelism — a finished/idle
# orchestrator is left alone and no quota is burned. An open task exists when the
# Human has given any directive (mission-inbox) or a standing mission is set.
HAS_TASK=0
{ [ -s "$MISSION_INBOX" ] || [ -s "$MISSION_FILE" ]; } && HAS_TASK=1
# Broader: keep agents busy on the WHOLE project (plans/bugreports/backlog), not
# only the (often small/abstract) mission. /done sets the rest sentinel above,
# which wins, so this won't burn quota after the Human says done.
HAS_WORK=$HAS_TASK
if [ "$HAS_WORK" = 0 ]; then
  { [ -s "$REPO/docs/backlog.md" ] || [ -s "$REPO/docs/bugreport.md" ] \
    || ls "$REPO"/docs/plans/PLAN_*.md >/dev/null 2>&1; } && HAS_WORK=1
fi

# ── 2. Liveness ──────────────────────────────────────────────────────────────
if ! curl -s -m 5 -o /dev/null "http://127.0.0.1:${PORT}/health"; then
  log "ESCALATE: daemon /health unreachable on :$PORT"
  # Can't use /notify if the daemon is down; just log (launchd keeps the daemon up).
  exit 0
fi
if [ "$HAS_WORK" = 0 ]; then
  log "no open task and no work sources (plans/backlog/bugreport) — watchdog passive"
  rm -f "$LOWPAR_FILE" 2>/dev/null
  exit 0
fi
if [ -z "$SESSION" ] || ! tmux has-session -t "$SESSION" 2>/dev/null; then
  # The Human starts the orchestrator MANUALLY (/start_codex). The watchdog must
  # NOT cold-start it. Escalate ONCE per absence (throttle) and wait. (A wedged
  # but ALIVE session is still auto-recovered below — that is recovery, not a
  # cold start.)
  if [ ! -f "$RUNTIME/wd-absent-notified" ]; then
    tg "ℹ️ Watchdog: оркестратор не запущено. Підніми вручну: /start_codex (або /start_claude). Сам його не стартую."
    : > "$RUNTIME/wd-absent-notified"
  fi
  log "orchestrator session absent — NOT auto-starting (Human controls start)"
  printf 'sig=\nstall=0\nlast_restart=%s\n' "$(date +%s)" > "$STATE_FILE"
  exit 0
fi
rm -f "$RUNTIME/wd-absent-notified" 2>/dev/null   # session present → reset absence notice

# ── 3. Progress signature — REAL throughput only (dev HEAD) ──────────────────
# We deliberately do NOT include the tmux pane (the watchdog's own nudges change
# it → false "progress") and we do NOT count live dispatch processes (agents are
# short-lived; sampling every 10 min sees ~0 between waves → that produced a
# pathological "0 agents → launch 15 → they finish → 0 again" re-dispatch STORM
# that exploded branches to 200+). The signal that the orchestrator is alive and
# landing work is simply: does dev HEAD move? If it does NOT move for the stall
# window, the orchestrator is genuinely stuck → escalate/restart. Whether the
# work is the RIGHT work / non-redundant is the orchestrator's judgment (use a
# capable model), not something this safety-net can or should police.
HEAD_SHA="$(git -C "$REPO" rev-parse "$REF" 2>/dev/null || echo none)"
COMMIT_N="$(git -C "$REPO" rev-list --count "$REF" 2>/dev/null || echo 0)"
SIG="$(printf '%s|%s' "$HEAD_SHA" "$COMMIT_N" | shasum | cut -d' ' -f1)"

PREV_SIG=""; PREV_STALL=0; LAST_RESTART=0
if [ -f "$STATE_FILE" ]; then
  PREV_SIG="$(grep -E '^sig=' "$STATE_FILE" | head -1 | cut -d= -f2-)"
  PREV_STALL="$(grep -E '^stall=' "$STATE_FILE" | head -1 | cut -d= -f2-)"
  LAST_RESTART="$(grep -E '^last_restart=' "$STATE_FILE" | head -1 | cut -d= -f2-)"
fi
[ -z "$PREV_STALL" ] && PREV_STALL=0
[ -z "$LAST_RESTART" ] && LAST_RESTART=0
NOW="$(date +%s)"

# NOTE: the old "parallelism enforcement" (count live dispatch-agent.sh procs and
# nudge to ~15) was REMOVED — it caused a re-dispatch storm (see §3). The
# watchdog no longer polices agent count; it only detects a genuine HEAD stall
# below. Keeping ~15 agents productively busy is the orchestrator's job.

# ── 4. Decide ────────────────────────────────────────────────────────────────
if [ "$SIG" != "$PREV_SIG" ]; then
  log "progress ok (sha=$HEAD_SHA commits=$COMMIT_N) — resetting stall"
  printf 'sig=%s\nstall=0\nlast_restart=%s\n' "$SIG" "$LAST_RESTART" > "$STATE_FILE"
  exit 0
fi

STALL=$((PREV_STALL + 1))
log "STALL #$STALL (sha=$HEAD_SHA commits=$COMMIT_N)"

if [ "$STALL" -lt "$STALL_TICKS" ]; then
  # Early stall: a gentle nudge may be enough if the orchestrator is merely idle.
  nudge "$STALL_MSG"
  printf 'sig=%s\nstall=%s\nlast_restart=%s\n' "$SIG" "$STALL" "$LAST_RESTART" > "$STATE_FILE"
  exit 0
fi

# Hard stall: nudges have not helped. Escalate, and auto-restart if cooldown elapsed.
nudge "$STALL_MSG"
since_restart=$((NOW - LAST_RESTART))
mins=$((STALL * 10))
if [ "$since_restart" -ge "$RESTART_COOLDOWN" ]; then
  tg "⚠️ Watchdog: оркестратор без прогресу по \`dev\` ~${mins} хв і не реагує на пінги. Перезапускаю його автоматично, щоб довести задачу."
  if restart_orchestrator; then
    tg "🔄 Watchdog: оркестратор перезапущено. Продовжую стежити за прогресом."
    printf 'sig=%s\nstall=0\nlast_restart=%s\n' "$SIG" "$NOW" > "$STATE_FILE"
  else
    tg "🔴 Watchdog: авто-рестарт не вдався. Потрібне ручне втручання (/restart або /start_*)."
    printf 'sig=%s\nstall=%s\nlast_restart=%s\n' "$SIG" "$STALL" "$LAST_RESTART" > "$STATE_FILE"
  fi
else
  log "hard stall but within restart cooldown (${since_restart}s < ${RESTART_COOLDOWN}s) — escalating only"
  tg "⚠️ Watchdog: оркестратор стоїть ~${mins} хв (нещодавно вже перезапускався). Можливо потрібне твоє рішення."
  printf 'sig=%s\nstall=%s\nlast_restart=%s\n' "$SIG" "$STALL" "$LAST_RESTART" > "$STATE_FILE"
fi
exit 0
