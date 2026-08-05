#!/usr/bin/env bash
# Regression lock for V3-5.19: a TEST FIXTURE must never be visible to anything
# that counts lanes.
#
# `orchestrator/fleet/lane-payload-systemd.test.sh` named its six transient
# units `lane-payload-probe-<pid>-*`, and `lane-*` is the glob two independent
# readers use to mean "a live lane": the fleet census in fleet-nudge.sh and the
# completion channel in daemon/server.ts. So the fixture was counted as running
# lanes and reported as lanes finishing.
#
# The half that makes this a lock rather than tidiness: since V3-5.9 the census
# is the input to the idle dwell, and `streak_break idle` runs on ANY busy
# sample before the dwell is consulted. One phantom tick therefore costs one
# full period of delay before the operator hears about a stall, and a phantom
# on alternating firings produces NO operator message at all across six hours
# of a genuinely idle fleet. That was survivable only because a probe lived
# seconds and could not span two censuses -- an accident of timing standing in
# for a guarantee. This file replaces the accident with a property: a fixture
# unit is outside the namespace, so its LIFETIME cannot matter. The live case
# below proves exactly that, with a deliberately long-lived unit.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
# shellcheck source=orchestrator/fleet/probe-unit-namespace.sh
. "$DIR/probe-unit-namespace.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

capability_forced_missing() {
  [[ ",${INFRA_TEST_FORCE_MISSING_CAPABILITIES:-}," == *",$1,"* ]]
}

# The exact census command in fleet-nudge.sh, and the exact one in the daemon.
# Kept as functions so the live case below asserts against what production runs
# rather than a paraphrase of it.
census_nudge() { systemctl list-units --type=service --state=running --no-legend 'lane-*' 2>/dev/null || true; }
census_daemon() { systemctl list-units --all --type=service 'lane-*' --no-legend --plain --no-pager 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# Case: the namespace guard discriminates.
#
# A helper that cannot refuse anything would pass every other assertion in this
# file while protecting nothing, so it is shown rejecting the name the fixture
# actually used before this row.
# ---------------------------------------------------------------------------
name="$(probe_unit_name payload 12345)" || fail 'probe_unit_name refused a legitimate fixture name'
[[ "$name" != lane-* ]] || fail "probe_unit_name produced $name, which is inside the lane namespace"
[[ "$name" == *payload-12345 ]] || fail "probe_unit_name lost its parts: $name"

refusal_status=0
refusal="$(PROBE_UNIT_PREFIX=lane probe_unit_name payload-probe 12345 2>&1)" || refusal_status=$?
[[ "$refusal_status" -ne 0 ]] || fail \
  "probe_unit_name accepted 'lane-payload-probe-12345' -- the exact name that caused V3-5.19"
[[ "$refusal" == *'live lane namespace'* ]] || fail "the refusal did not say what it refused: $refusal"
printf '%s\n' 'lane-unit-namespace: RAN case=guard-refuses-lane-namespace'

# ---------------------------------------------------------------------------
# Case: every fixture in the repository takes its unit names from the guard.
#
# The guard only helps where it is used, and the failure mode is silent: a new
# fixture writes `--unit "lane-something-$$"`, and nothing goes red until the
# operator stops being told about a stall. So the rule is enforced over the
# tracked tree instead of trusted: the ONLY file permitted to create units in
# the lane namespace is the real launcher.
# ---------------------------------------------------------------------------
LAUNCHER='orchestrator/fleet/launch-lane.sh'
mapfile -t unit_creators < <(cd "$REPO" && git ls-files -z | xargs -0 grep -l 'systemd-run' 2>/dev/null | sort)
[[ ${#unit_creators[@]} -gt 0 ]] || fail 'no file in the tree invokes systemd-run -- the scan is looking at nothing'

launcher_seen=false
fixture_seen=false
for file in "${unit_creators[@]}"; do
  if [[ "$file" == "$LAUNCHER" ]]; then
    launcher_seen=true
    grep -q 'unit="lane-\$name"' "$REPO/$file" ||
      fail "$LAUNCHER no longer names real lanes lane-<name>; the whole rule below rests on that"
    continue
  fi
  # Every `--unit` handed to a real systemd-run INVOCATION -- the command word
  # followed by a flag, comments excluded. Prose about systemd-run creates no
  # units, and this file (and the scanner in it) is full of prose. The name must
  # come from the guard: a direct call, or a variable this same file assigns
  # from it. A literal is refused even when it looks safe; `lane-payload-probe-$$`
  # looked safe too.
  while IFS= read -r line; do
    token="$(printf '%s' "$line" | sed -n 's/.*--unit[ =]\{1,\}\([^ ]*\).*/\1/p')"
    [[ -n "$token" ]] || fail "$file: a systemd-run line passes --unit with no value: $line"
    token="${token//\"/}"
    case "$token" in
      '$(probe_unit_name'*) ;;
      '$'*)
        var="${token#\$}"
        var="${var#\{}"
        var="${var%%[^A-Za-z0-9_]*}"
        grep -Eq "^[[:space:]]*$var=\"?\\\$\(probe_unit_name" "$REPO/$file" ||
          fail "$file: unit name \$$var is not assigned from probe_unit_name (workboard V3-5.19)"
        grep -q 'probe-unit-namespace.sh' "$REPO/$file" ||
          fail "$file: builds unit names without sourcing the namespace helper"
        ;;
      *) fail "$file: fixture unit name $token is a literal, not built by probe_unit_name (workboard V3-5.19)" ;;
    esac
    fixture_seen=true
  done < <(grep -nE '(^|[^A-Za-z0-9_-])systemd-run[[:space:]]+-' "$REPO/$file" |
    grep -- '--unit' | grep -Ev '^[0-9]+:[[:space:]]*#' || true)
done
[[ "$launcher_seen" == true ]] || fail "the scan never saw $LAUNCHER -- it is not scanning what it claims to"
[[ "$fixture_seen" == true ]] || fail 'the scan found no fixture unit name at all; it proves nothing'
printf '%s\n' 'lane-unit-namespace: RAN case=fixtures-outside-lane-namespace'

# ---------------------------------------------------------------------------
# Case: the readers this rule protects still read `lane-*`.
#
# The namespace choice is only equivalent to an exclusion-at-every-reader while
# the readers glob what this file thinks they glob. If one of them widens its
# glob, a fixture becomes visible again through a door nobody reviewed -- so
# the two known call sites are pinned here by name.
# ---------------------------------------------------------------------------
grep -q "systemctl list-units --type=service --state=running --no-legend 'lane-\*'" \
  "$REPO/orchestrator/fleet/fleet-nudge.sh" ||
  fail 'the fleet census no longer globs lane-* — re-derive the fixture namespace rule against its new form'
grep -q "'lane-\*'," "$REPO/daemon/server.ts" ||
  fail 'the daemon lane census no longer globs lane-* — re-derive the fixture namespace rule against its new form'
grep -Fq '/^lane-[^\s]+\.service$/' "$REPO/daemon/autonomy-keepalive.ts" ||
  fail 'daemon/autonomy-keepalive.ts no longer filters unit names on ^lane- — the completion channel changed shape'
printf '%s\n' 'lane-unit-namespace: RAN case=census-readers-still-glob-lane'

# ---------------------------------------------------------------------------
# Live case: a LONG-LIVED fixture unit is invisible to both censuses.
#
# The short-lived fixture passing proves nothing -- that is precisely the
# accident this row removes. This unit outlives many censuses on purpose, and is
# sampled twice with the samples separated in time.
# ---------------------------------------------------------------------------
PROBE_UNIT="$(probe_unit_name namespace-lock "$$")" || fail 'could not name the live probe'
probe_started=false
cleanup() {
  if [[ "$probe_started" == true ]]; then
    systemctl stop "$PROBE_UNIT" >/dev/null 2>&1 || true
  fi
  systemctl reset-failed "$PROBE_UNIT" >/dev/null 2>&1 || true
  systemctl reset-failed "$PROBE_UNIT-capability" >/dev/null 2>&1 || true
}
trap cleanup EXIT

systemd_usable=true
if capability_forced_missing systemd-transient-unit; then
  systemd_usable=false
elif ! command -v systemd-run >/dev/null 2>&1; then
  systemd_usable=false
elif ! timeout 60 systemd-run --collect --wait --quiet --unit "$PROBE_UNIT-capability" \
  /bin/true >/dev/null 2>&1; then
  systemd_usable=false
fi

if ! "$systemd_usable"; then
  printf '%s\n' 'lane-unit-namespace: EXCLUDED case=long-lived-probe-invisible-to-census capability=systemd-transient-unit'
  printf 'lane unit namespace: PASS (live case excluded)\n'
  exit 0
fi

systemctl reset-failed "$PROBE_UNIT" >/dev/null 2>&1 || true
# 90 seconds is nine timer periods' worth of sampling at the ten-minute census
# rate, and orders of magnitude longer than the fixture units that made this
# survivable by accident. It is stopped below; the trap covers every other exit.
timeout 60 systemd-run --collect --quiet --unit "$PROBE_UNIT" /bin/sleep 90 >/dev/null 2>&1 ||
  fail "could not start the long-lived probe unit $PROBE_UNIT"
probe_started=true

deadline=$((SECONDS + 15))
until systemctl is-active --quiet "$PROBE_UNIT"; do
  [[ "$SECONDS" -lt "$deadline" ]] || fail "$PROBE_UNIT never became active"
  sleep 1
done

assert_invisible() { # label
  local nudge daemon own
  nudge="$(census_nudge)"
  daemon="$(census_daemon)"
  own="$(systemctl list-units --type=service --state=running --no-legend "$PROBE_UNIT_PREFIX-*" 2>/dev/null || true)"
  # Vacuity guard first: an absent unit is absent from every glob, so the two
  # assertions below only mean something while the probe is demonstrably alive.
  if ! printf '%s' "$own" | grep -Fq "$PROBE_UNIT"; then
    fail "$1: the probe is not running under its own namespace; the census assertions would be vacuous"
  fi
  if printf '%s' "$nudge" | grep -Fq "$PROBE_UNIT"; then
    fail "$1: the long-lived probe is counted by the fleet census (workboard V3-5.19)"
  fi
  if printf '%s' "$daemon" | grep -Fq "$PROBE_UNIT"; then
    fail "$1: the long-lived probe is visible to the daemon completion channel (workboard V3-5.19)"
  fi
  return 0
}

assert_invisible 'first census'
sleep 3
assert_invisible 'second census, one probe lifetime later'
systemctl is-active --quiet "$PROBE_UNIT" ||
  fail 'the probe died between the two censuses; this run did not test a long-lived unit'

# A real lane must still be counted. Asserted against the census command rather
# than against a live `lane-*` unit ON PURPOSE: starting one here would inflate
# the live fleet count and suppress a real stall for its lifetime, which is the
# defect. The name shape is the whole of what the glob decides on.
lane_like='lane-v3-0.32-counter.service'
[[ "$lane_like" == lane-* ]] || fail 'the census glob would no longer match a real lane name'
[[ "$PROBE_UNIT.service" != lane-* ]] || fail 'the probe name would still match the census glob'
printf '%s\n' 'lane-unit-namespace: RAN case=long-lived-probe-invisible-to-census'

systemctl stop "$PROBE_UNIT" >/dev/null 2>&1 || true
probe_started=false
printf 'lane unit namespace: PASS\n'
