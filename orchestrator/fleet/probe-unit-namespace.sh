#!/usr/bin/env bash
# The one home for the systemd unit namespace that TEST FIXTURES may use.
#
# `lane-` is not a naming convention, it is an interface. Two independent
# readers treat a running `lane-*.service` as a live lane and act on it:
#
#   orchestrator/fleet/fleet-nudge.sh  -- the fleet census, which decides
#       whether the operator is told the fleet has stalled;
#   daemon/server.ts (listSystemLaneUnits) -- the completion channel, which
#       wakes the orchestrator with "lane X finished; inspect evidence".
#
# So a fixture that names its transient units `lane-...` is not merely untidy:
# it inflates the count HR-2538's cap is enforced against, and it sends the
# orchestrator after evidence of a lane that never existed (both observed
# 2026-08-05, workboard V3-5.19). It also silences a real stall — the census is
# the input to the idle dwell landed by V3-5.9, and `streak_break idle` runs on
# any busy sample, so each phantom tick costs one full period of delay before
# the operator hears anything.
#
# The fix is structural rather than a rule to remember: fixtures live in a
# DIFFERENT namespace, so no glob written against `lane-*` anywhere -- today's
# two readers or tomorrow's third -- can see them, no matter how long a fixture
# unit lives. An exclusion inside the census would have been narrower, but it
# would have to be repeated at every reader, and the reader that forgets it is
# exactly the failure this row is about.
#
# `probe_unit_name` is the only sanctioned way to build such a name, and it
# refuses to produce one inside the lane namespace: a fixture that regresses
# fails BEFORE it can create the unit, rather than after it has polluted the
# census. orchestrator/fleet/lane-unit-namespace.test.sh holds every fixture to
# this file.

# Deliberately not `lane-`, and deliberately not a prefix of it.
PROBE_UNIT_PREFIX=${PROBE_UNIT_PREFIX:-infra-probe}

# probe_unit_name <tag> [<suffix>...] -> "<prefix>-<tag>[-<suffix>...]"
probe_unit_name() {
  local name="$PROBE_UNIT_PREFIX"
  local part
  for part in "$@"; do
    [ -n "$part" ] || continue
    name="$name-$part"
  done
  case "$name" in
    lane-*)
      printf 'probe_unit_name: refusing to name a fixture unit %s -- that is the live lane namespace (workboard V3-5.19)\n' \
        "$name" >&2
      return 1
      ;;
  esac
  printf '%s' "$name"
}
