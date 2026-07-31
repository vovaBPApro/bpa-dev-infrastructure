#!/usr/bin/env bash
# TEMPORARY stopgap until ML-2 (ag-ml2-autonomy-keepalive) lands and replaces it
# inside the daemon.
#
# Runs from a systemd TIMER as root on this host — deliberately NOT from the
# orchestrator session. It keeps working if the orchestrator is relaunched, wedged
# or dead, which is the whole point: the Human must not be the thing that notices.
#
# Three outcomes, per the operator's instruction (2026-07-31, Telegram 299):
#   lanes < FLOOR, work REMAINS   -> wake the ORCHESTRATOR (tmux), no Human ping
#   lanes < FLOOR, NO work left   -> ask the HUMAN what to do next (Telegram)
#   orchestrator not running      -> tell the HUMAN it needs starting
set -uo pipefail

SESSION=bpa-orchestrator
FLOOR=3
BOARD=/root/bpa-dev-infrastructure/instance/workboard.md
DAEMON=http://127.0.0.1:4822
LOGFILE=/root/.cache/infra-lanes/fleet-nudge.log

notify() { # text
  curl -s -m 10 -X POST "$DAEMON/notify" -H 'Content-Type: application/json' \
    --data "$(printf '{"text":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    >/dev/null 2>&1
}

running=$(systemctl list-units --type=service --state=running --no-legend 'lane-*' 2>/dev/null | wc -l)
[ "$running" -ge "$FLOOR" ] && exit 0

open=$(grep -cE '^- \*\*(W|ML|NI|P)-[0-9]+' "$BOARD" 2>/dev/null || echo 0)

# Every firing is recorded. This log is the honest metric of whether the
# orchestrator holds the fleet by ITSELF: a nudge that fires often means the
# orchestrator keeps ending its turn with the fleet idle, which is an
# orchestrator defect, not a watchdog success. Vova asked for a number he can
# demand at any time instead of taking the orchestrator's word (Telegram 314).
# Query it with: tail /root/.cache/infra-lanes/fleet-nudge.log
mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true
printf '%s fired running=%s floor=%s open_rows=%s\n' \
  "$(date -Is)" "$running" "$FLOOR" "$open" >>"$LOGFILE" 2>/dev/null || true

if [ "$open" -eq 0 ]; then
  # Nothing left to dispatch. This is the ONE case that legitimately goes to the
  # Human, because only he can say what comes next.
  notify "Дошка порожня, активних лейнів $running. Роботи для флоту не лишилось — скажи, що робимо далі."
  exit 0
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  notify "Оркестратор не запущений, а на дошці $open відкритих рядків. Потрібен /start_codex або /start_claude."
  exit 0
fi

# Work remains but the fleet is idle => something on the orchestrator side is
# wrong. Wake IT, not the Human.
msg="[fleet-nudge] running lanes=$running (floor $FLOOR), workboard open rows=$open. Collect finished lane reports, land what is ACCEPTed, dispatch the next wave. Per HR-281 report the lane count to Vova unprompted."
buf="nudge$$"
tmux set-buffer -b "$buf" -- "$msg" 2>/dev/null || exit 0
tmux paste-buffer -t "$SESSION" -b "$buf" -d 2>/dev/null || exit 0
sleep 1
tmux send-keys -t "$SESSION" Enter 2>/dev/null || true
