#!/usr/bin/env bash
# Central bounded parser for numeric orchestrator knobs. Sourced — defines one
# function, no side effects, no dependencies.
#
# Why it exists: install-watchdog.sh used to interpolate ORCH_WATCHDOG_INTERVAL
# into a systemd unit file completely unvalidated, so `0` produced a zero-period
# timer and a value with an embedded newline injected arbitrary unit directives
# (`[Service]\nExecStartPre=...`). watchdog.sh accepted `0` for its cadence,
# heartbeat and cooldown knobs ([0-9]+ only, no bounds), which turns the restart
# throttle off and makes every tick a restart. Both surfaces must reject the
# same values the same way, so there is exactly ONE parser and both source it.
#
# Documented ranges (the single authority — callers pass these numbers):
#   ORCH_WATCHDOG_INTERVAL        10 .. 86400      s   (tick cadence)
#   ORCH_HEARTBEAT_MAX_AGE         5 .. 604800     s
#   ORCH_LIVENESS_MAX_AGE         15 .. 86400      s   (pulse staleness verdict)
#   ORCH_LIVENESS_PULSE_INTERVAL   5 .. 600        s   (pulse renewal cadence)
#   ORCH_RESTART_COOLDOWN[_NIGHT] 60 .. 604800     s   (anti-thrash floor)
#   ORCH_LEASE_TTL_MS           1000 .. 86400000   ms
#   FLEET_IDLE_NUDGE_MS            1 .. 604800000  ms
#   FLEET_NUDGE_REPEAT_MS          0 .. 604800000  ms  (0 = no nudge throttle;
#                                                       nudges only, never
#                                                       gates a restart)
#   DISK_ALERT_PCT / DISK_CRITICAL_PCT  1 .. 100   %
#   DOCKER_STALE_TAG_KEEP          1 .. 1000
# Ordering constraints (cooldown >= interval, critical >= alert, lease TTL vs
# tick fence) are enforced by watchdog.sh after parsing; they need several
# knobs at once and belong to the tick, not to the parser.
#
# knob_check <value> <min> <max>
#   Returns 0 iff <value> is a plain decimal integer within [min, max].
#   Otherwise returns 1 and sets KNOB_REASON to one of:
#     empty | non-numeric | below-min | above-max
#   The ^[0-9]+$ match is anchored over the WHOLE string, so signs, spaces,
#   separators, control characters and embedded newlines (the systemd
#   unit-directive injection vector) are all rejected as non-numeric. The
#   length cap keeps absurdly long digit strings out of shell arithmetic
#   before they can overflow it.
# shellcheck disable=SC2034  # KNOB_REASON is the out-parameter read by callers
knob_check() {
  local value="$1" min="$2" max="$3"
  KNOB_REASON=""
  if [[ -z "$value" ]]; then
    KNOB_REASON=empty
    return 1
  fi
  if ! [[ "$value" =~ ^[0-9]+$ ]]; then
    KNOB_REASON=non-numeric
    return 1
  fi
  if (( ${#value} > 12 )); then
    KNOB_REASON=above-max
    return 1
  fi
  if (( 10#$value < min )); then
    KNOB_REASON=below-min
    return 1
  fi
  if (( 10#$value > max )); then
    KNOB_REASON=above-max
    return 1
  fi
  return 0
}

# systemd's NextElapseUSecRealtime property is rendered as one absolute UTC
# timestamp (for example "Sat 2026-08-01 12:00:00 UTC").  Treating arbitrary
# non-empty output as a future trigger made an active-but-unscheduled timer look
# armed.  This parser is shared by both installers and deliberately rejects
# relative text, infinity, zero, stale values, and property-label noise.
finite_future_systemd_trigger() { # <value> [now-epoch-seconds]
  local value="$1" now="${2:-$(date +%s)}" epoch
  [[ "$now" =~ ^[0-9]+$ ]] || return 1
  [[ "$value" =~ ^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[[:space:]][0-9]{4}-[0-9]{2}-[0-9]{2}[[:space:]][0-9]{2}:[0-9]{2}:[0-9]{2}[[:space:]]UTC$ ]] ||
    return 1
  epoch="$(LC_ALL=C date -u -d "$value" +%s 2>/dev/null)" || return 1
  [[ "$epoch" =~ ^[0-9]+$ ]] && (( epoch > now ))
}
