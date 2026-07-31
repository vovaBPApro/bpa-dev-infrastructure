#!/usr/bin/env bash
# Shared reader for the kernel's reuse-safe process identity. Sourced — defines
# one function, no side effects, no dependencies. Deliberately NOT lib.sh: the
# liveness pulse sources this and must keep running even when bun is missing.
#
# Why it exists: a PID alone does not name a process. The kernel recycles PIDs,
# so "PID 4242 exists" can be true of a process that is NOT the one recorded.
# PID plus the process start time (/proc/<pid>/stat field 22, clock ticks since
# boot) is fixed at fork, survives exec, and never repeats for a recycled PID
# within one boot — the pair is sufficient identity for the liveness fence:
# same pid AND same starttime -> the recorded process; anything else -> gone.
#
# proc_starttime <pid>
#   Prints the start time of <pid>, or NOTHING when it cannot be read (process
#   gone, /proc unavailable, malformed pid). Absent output is ambiguity for the
#   caller to classify — never fabricated evidence in either direction.
proc_starttime() {
  local pid="$1" stat rest fields
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 0
  # comm (field 2) is the executable name in parentheses and may itself contain
  # spaces or ')'. Everything after the LAST ')' is fixed-position, so strip up
  # to it: starttime, stat field 22, is then field 20 of the remainder.
  rest="${stat##*) }"
  read -ra fields <<<"$rest" || return 0
  [[ "${fields[19]:-}" =~ ^[0-9]+$ ]] || return 0
  printf '%s\n' "${fields[19]}"
}
