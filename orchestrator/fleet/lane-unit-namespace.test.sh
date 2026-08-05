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

SCRATCH="$(mktemp -d)"
probe_started=false
cleanup() {
  rm -rf "$SCRATCH"
  [[ -n "${PROBE_UNIT:-}" ]] || return 0
  if [[ "$probe_started" == true ]]; then
    systemctl stop "$PROBE_UNIT" >/dev/null 2>&1 || true
  fi
  systemctl reset-failed "$PROBE_UNIT" >/dev/null 2>&1 || true
  systemctl reset-failed "$PROBE_UNIT-capability" >/dev/null 2>&1 || true
}
trap cleanup EXIT

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

# ===========================================================================
# The scanner.
#
# The guard only helps where it is used, and the failure mode is silent: a new
# fixture writes `--unit "lane-something-$$"`, never calls probe_unit_name at
# all, and nothing goes red until the operator stops being told about a stall.
# So the rule is enforced over the tracked tree instead of trusted, and this
# scanner is the only thing that enforces it.
#
# It reads LOGICAL lines, not physical ones. `--unit` routinely sits on a
# different physical line from the command word -- that is how this repository
# writes its only production invocation, orchestrator/fleet/launch-lane.sh:
#
#     if ! systemd-run --collect --unit "$unit" \
#       --property=IPAddressDeny=localhost \
#
# Round 1 of this lock required `systemd-run` and `--unit` to hit the same
# physical line. It therefore matched nothing in the launcher, nothing in the
# vendored old-contracts copy, and -- the reason that is a defect rather than an
# omission -- nothing in a NEW fixture written in that same house style. A
# reviewer added a file containing only a continued `systemd-run` with
# `--unit "lane-evil-probe-$$"`, five minutes of a unit inside the live lane
# namespace, and the suite stayed green: "matched no candidates" and "found no
# violations" were one indistinguishable outcome, which is what a check that
# cannot fail looks like from outside. Both halves are repaired here -- the fold,
# and the positive control that goes red if the fold ever stops working.
#
# Every tracked file is folded rather than a `grep -l systemd-run` shortlist:
# a prefilter that reads physical lines carries the identical blind spot.
# ===========================================================================

# systemd_run_invocations <file>... -> "<path>\t<logical invocation>" per line.
#
# Comment lines are dropped before folding -- prose about systemd-run creates no
# units, and this repository (this file most of all) is full of such prose. A
# comment line ending in a backslash is still just a comment, which is why the
# drop is unconditional while no continuation is open.
systemd_run_invocations() {
  [[ $# -gt 0 ]] || return 0
  awk '
    function flush() { if (buf != "") { print fname "\t" buf; buf = "" } }
    FNR == 1 { flush(); fname = FILENAME }
    /^[[:space:]]*#/ && buf == "" { next }
    {
      line = $0
      if (buf != "") { sub(/^[[:space:]]+/, "", line); line = buf " " line }
      if (line ~ /\\$/) { sub(/\\$/, "", line); buf = line; next }
      buf = line
      flush()
    }
    END { flush() }
  ' "$@" | grep -E '(^|[^A-Za-z0-9_-])systemd-run[[:space:]]+-' || true
}

# unit_tokens <file> -> every `--unit` value the file's real invocations pass,
# one per line, quotes stripped. ALL of them, not just the first on a line.
# An empty line means `--unit` was passed with no value at all.
#
# An invocation carrying no `--unit` produces no line, and that is deliberate,
# not an oversight: systemd then auto-names the unit `run-<pid>.service`, which
# no `lane-*` glob can match. Only a NAME can put a fixture in the census.
unit_tokens() {
  local invocation raw token
  while IFS=$'\t' read -r _ invocation; do
    while IFS= read -r raw; do
      token="$(printf '%s' "$raw" | sed -n 's/^--unit[=[:space:]]\{1,\}\(.*\)$/\1/p')"
      printf '%s\n' "${token//\"/}"
    done < <(printf '%s\n' "$invocation" | grep -oE -- '--unit([=[:space:]][^[:space:]]*)?' || true)
  done < <(systemd_run_invocations "$1")
}

# scan_fixture_file <label> <path> -> 0 clean, 1 violation.
# Sets SCAN_REASON (why) and SCAN_UNITS (how many `--unit` values were seen).
# The two are separate on purpose: a caller must be able to tell "this file is
# clean" from "this file was not read", which is the distinction round 1 lost.
SCAN_REASON=''
SCAN_UNITS=0
scan_fixture_file() {
  local label="$1" path="$2" token var
  SCAN_REASON=''
  SCAN_UNITS=0
  while IFS= read -r token; do
    SCAN_UNITS=$((SCAN_UNITS + 1))
    if [[ -z "$token" ]]; then
      SCAN_REASON="$label: a systemd-run invocation passes --unit with no value"
      return 1
    fi
    # The name must come from the guard: a direct call, or a variable this same
    # file assigns from it. A literal is refused even when it looks safe;
    # `lane-payload-probe-$$` looked safe too.
    case "$token" in
      '$(probe_unit_name'*) ;;
      '$'*)
        var="${token#\$}"
        var="${var#\{}"
        var="${var%%[^A-Za-z0-9_]*}"
        if ! grep -Eq "^[[:space:]]*$var=\"?\\\$\(probe_unit_name" "$path"; then
          SCAN_REASON="$label: unit name \$$var is not assigned from probe_unit_name (workboard V3-5.19)"
          return 1
        fi
        if ! grep -q 'probe-unit-namespace.sh' "$path"; then
          SCAN_REASON="$label: builds unit names without sourcing the namespace helper"
          return 1
        fi
        ;;
      *)
        SCAN_REASON="$label: fixture unit name $token is a literal, not built by probe_unit_name (workboard V3-5.19)"
        return 1
        ;;
    esac
  done < <(unit_tokens "$path")
  return 0
}

# ---------------------------------------------------------------------------
# Case: the scanner catches the shape it used to miss.
#
# Held to fixtures rather than trusted, because "the scan found nothing" is the
# indistinguishable failure this whole section exists to remove. The first
# fixture is the reviewer's, verbatim in shape: the exact file that was invisible
# to round 1.
#
# The fixture text is assembled through a variable instead of being written out
# literally, and that is load-bearing rather than fussy: this file is itself
# scanned by the tree pass below, so a literal continued `systemd-run ... --unit
# "lane-..."` here would be read as a real violation inside the lock that forbids
# it.
# ---------------------------------------------------------------------------
SR='systemd-run'

evil_multiline="$SCRATCH/evil-multiline.test.sh"
{
  printf '%s --collect --quiet \\\n' "$SR"
  printf '  --unit "lane-evil-probe-$$" \\\n'
  printf '  /bin/sleep 300\n'
} >"$evil_multiline"
if scan_fixture_file 'evil-multiline' "$evil_multiline"; then
  fail 'the scanner passed a continued systemd-run creating lane-evil-probe-$$ -- it cannot see continuation lines'
fi
[[ "$SCAN_UNITS" -eq 1 ]] ||
  fail "the scanner saw $SCAN_UNITS unit names in the continued fixture, expected 1"
[[ "$SCAN_REASON" == *'lane-evil-probe-$$'* ]] ||
  fail "the scanner refused the continued fixture for the wrong reason: $SCAN_REASON"

evil_single="$SCRATCH/evil-single.test.sh"
printf '%s --collect --quiet --unit "lane-evil-probe-$$" /bin/sleep 300\n' "$SR" >"$evil_single"
if scan_fixture_file 'evil-single' "$evil_single"; then
  fail 'the scanner passed a single-line systemd-run creating lane-evil-probe-$$'
fi

# The fold must not be a blanket refusal: a compliant fixture written in the same
# continued house style has to pass, or the scanner would be red for everyone and
# would be turned off.
compliant="$SCRATCH/compliant.test.sh"
{
  printf '. "$(dirname "$0")/probe-unit-namespace.sh"\n'
  printf '%s --collect --quiet \\\n' "$SR"
  printf '  --unit "$(probe_unit_name evil-probe "$$")" \\\n'
  printf '  /bin/sleep 1\n'
} >"$compliant"
scan_fixture_file 'compliant' "$compliant" ||
  fail "the scanner refused a compliant continued fixture: $SCAN_REASON"
[[ "$SCAN_UNITS" -eq 1 ]] ||
  fail "the scanner saw $SCAN_UNITS unit names in the compliant continued fixture, expected 1"

# Prose still creates no units, including prose that is itself continued.
prose="$SCRATCH/prose.test.sh"
{
  printf '# %s --collect --unit "lane-in-a-comment" /bin/true\n' "$SR"
  printf '#   %s --collect \\\n' "$SR"
  printf '#   --unit "lane-in-a-continued-comment"\n'
} >"$prose"
scan_fixture_file 'prose' "$prose" ||
  fail "the scanner read a comment as an invocation: $SCAN_REASON"
[[ "$SCAN_UNITS" -eq 0 ]] ||
  fail "the scanner extracted $SCAN_UNITS unit names out of comments, expected 0"

# `--unit` with nothing after it is a broken invocation, not a clean one.
novalue="$SCRATCH/novalue.test.sh"
{
  printf '%s --collect \\\n' "$SR"
  printf '  --unit\n'
} >"$novalue"
if scan_fixture_file 'novalue' "$novalue"; then
  fail 'the scanner accepted a systemd-run passing --unit with no value'
fi
[[ "$SCAN_REASON" == *'no value'* ]] ||
  fail "the scanner refused the valueless --unit for the wrong reason: $SCAN_REASON"
printf '%s\n' 'lane-unit-namespace: RAN case=scanner-sees-continued-invocations'

# ---------------------------------------------------------------------------
# Case: every fixture in the repository takes its unit names from the guard.
#
# The ONLY file permitted to create units in the lane namespace is the real
# launcher.
# ---------------------------------------------------------------------------
LAUNCHER='orchestrator/fleet/launch-lane.sh'

# Retained evidence rather than a fixture this repository runs. Enumerated one
# path at a time on purpose: an exemption expressed as a pattern is the same hole
# as a scan that cannot see. Each entry is re-proven below -- it must still
# exist, and it must NOT be in the executed shell-test inventory -- so this list
# cannot quietly become somewhere to park a live fixture.
#
# vendor/old-contracts is the imported old-orchestrator corpus (vendor/old-contracts/SOURCE.md),
# kept for parity evidence. Its `systemd-run --unit="bpa-lane-$NAME"` sits inside
# a heredoc that the same test stubs out with a fake `systemd-run` earlier in the
# file, so no unit is ever created; the name is also outside `lane-*`, so no
# census could see it either way. It is not in tools/shell-test-tier.test.ts and
# is never executed here.
SCAN_EXEMPT=(
  'vendor/old-contracts/tools/orchestrator/lane-survives-dispatcher-death.test.sh'
)
# Asserted before it is read. `grep` over a path that does not exist finds
# nothing and reports nothing, so the check below would pass by being unable to
# run -- the same shape as the defect this round repairs, one file smaller.
TIER_INVENTORY='tools/shell-test-tier.test.ts'
[[ -f "$REPO/$TIER_INVENTORY" ]] ||
  fail "$TIER_INVENTORY is missing; the exemption check below would pass by finding nothing"
for exempt in "${SCAN_EXEMPT[@]}"; do
  [[ -f "$REPO/$exempt" ]] ||
    fail "scan exemption $exempt no longer exists; delete the exemption rather than leaving it to cover nothing"
  if grep -q "\"$exempt\"" "$REPO/$TIER_INVENTORY"; then
    fail "$exempt is in the executed shell-test inventory; it must not be exempt from the unit-name scan"
  fi
done

mapfile -t -d '' tracked < <(cd "$REPO" && git ls-files -z)
[[ ${#tracked[@]} -gt 0 ]] || fail 'git ls-files listed no tracked file; the scan is looking at nothing'
mapfile -t unit_creators < <(
  systemd_run_invocations "${tracked[@]/#/$REPO/}" | cut -f1 | sort -u
)
[[ ${#unit_creators[@]} -gt 0 ]] ||
  fail 'no file in the tracked tree invokes systemd-run -- the scanner is broken, not the tree clean'

launcher_units=0
fixture_units=0
for path in "${unit_creators[@]}"; do
  label="${path#"$REPO/"}"

  if [[ "$label" == "$LAUNCHER" ]]; then
    # POSITIVE CONTROL for the scanner itself. This invocation spans seven
    # physical lines with `--unit` on the first, and it is guaranteed to be
    # there: if the scanner stops seeing it, the scanner regressed to physical
    # lines and every "no violations" verdict it prints is worthless. Pinning it
    # is what makes "matched nothing" loud instead of green.
    while IFS= read -r token; do
      launcher_units=$((launcher_units + 1))
      [[ "$token" == '$unit' ]] ||
        fail "$LAUNCHER now passes --unit $token; the rule this file enforces rests on the launcher naming real lanes"
    done < <(unit_tokens "$path")
    continue
  fi

  skip=false
  for exempt in "${SCAN_EXEMPT[@]}"; do
    [[ "$label" != "$exempt" ]] || skip=true
  done
  [[ "$skip" == false ]] || continue

  scan_fixture_file "$label" "$path" || fail "$SCAN_REASON"
  fixture_units=$((fixture_units + SCAN_UNITS))
done

[[ "$launcher_units" -ge 1 ]] || fail \
  "the scan found no --unit in $LAUNCHER, which certainly has one -- a continued invocation is invisible to the scanner and every verdict above is worthless"
grep -q 'unit="lane-\$name"' "$REPO/$LAUNCHER" ||
  fail "$LAUNCHER no longer names real lanes lane-<name>; the whole rule above rests on that"
[[ "$fixture_units" -ge 1 ]] || fail \
  'the scan found no fixture unit name at all; it proves nothing'
printf '%s\n' 'lane-unit-namespace: RAN case=fixtures-outside-lane-namespace'

# ---------------------------------------------------------------------------
# Case: the readers this rule protects still read `lane-*`.
#
# The namespace choice is only equivalent to an exclusion-at-every-reader while
# the readers glob what this file thinks they glob. If one of them widens its
# glob, a fixture becomes visible again through a door nobody reviewed -- so
# the three known call sites are pinned here by name. Each pin fails when the
# text moves or changes shape, which is the safe direction: a reader that no
# longer matches its pin gets re-derived by hand rather than assumed.
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
# accident this row removes. This unit outlives many census periods on purpose,
# and both production census commands are sampled twice against it.
# ---------------------------------------------------------------------------
PROBE_UNIT="$(probe_unit_name namespace-lock "$$")" || fail 'could not name the live probe'

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

# Two separate samplings, seconds rather than a full census period apart. Stated
# plainly because the difference matters and an overstated label would be worse
# than the gap: what is proven here is that two independent invocations of the
# exact production commands cannot see a unit that outlives them by orders of
# magnitude. That is sufficient because the property is a glob non-match, which
# is time-invariant -- `infra-probe-*` does not begin matching `lane-*` at minute
# ten. A real ten-minute separation would add nothing but twenty minutes to every
# suite run.
assert_invisible 'first census'
sleep 3
assert_invisible 'second census, an independent sampling of the same live unit'
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
