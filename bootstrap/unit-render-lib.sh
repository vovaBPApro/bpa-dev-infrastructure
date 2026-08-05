#!/usr/bin/env bash
# Single source of truth for rendering systemd unit templates (workboard row
# V3-2.12). Source this; do not re-implement any part of it.
#
# WHY THIS FILE EXISTS
#
# bootstrap/install.sh rendered every unit template with envsubst while
# exporting FOUR variables. bootstrap/check-unit-drift.sh rendered the SAME
# templates while exporting SIX. Two lists in two files is the whole defect:
# what got DEPLOYED differed from what the drift checker VALIDATED, and
# envsubst reports nothing when a template names a variable the caller never
# set -- it substitutes the empty string and exits 0.
#
# The two templates that needed exactly the two names the installer omitted
# were the nightly full-suite timer and the orchestrator watchdog timer:
#
#   OnCalendar=$FULL_SUITE_ON_CALENDAR        -> OnCalendar=
#   OnUnitActiveSec=${ORCH_WATCHDOG_INTERVAL}s -> OnUnitActiveSec=s
#
# `OnCalendar=` with an empty value is systemd's documented way to CLEAR a
# schedule, so that timer never fires again; `OnUnitActiveSec=s` does not
# parse and systemd drops the line. Those are the two mechanisms whose entire
# job is to notice that something has stopped, so a rebuilt host would come up
# with both watchers dead and look healthy. See
# instance/incidents/2026-08-04-systemd-ate-the-tenth-argument.md ("Same
# class") -- an argument list and a variable list fail the same way, silently
# and in the direction of doing less.
#
# THREE INDEPENDENT DEFENCES, all fail-closed (Hard Floor 7):
#
#   1. ONE LIST. UNIT_RENDER_DEFAULTS below is the only place any renderer
#      learns which variables exist or what they default to. Both renderers
#      call unit_render_template; neither builds its own environment. Adding a
#      name here is the complete change -- there is no second place to forget.
#
#   2. RESTRICTED ENVSUBST. envsubst is invoked with an explicit SHELL-FORMAT
#      argument, so it substitutes ONLY the names in this file's list. A
#      template that names anything else keeps its raw `$NAME` token instead of
#      quietly becoming an empty string -- which converts an invisible failure
#      into a visible one that check 3 then rejects. Unrestricted envsubst can
#      never leave a residual `$`, which is exactly why the pre-existing
#      "renders cleanly" test could not see this bug.
#
#   3. POST-RENDER ASSERTION. unit_render_assert_complete refuses any rendered
#      unit that still contains `$`, or whose key= line lost a value the
#      template had. Absence of evidence is a failure here, never a skip.
#
#      FORWARD CONSTRAINT, deliberate: because restricted envsubst leaves an
#      unknown `$NAME` intact and this assertion then refuses it, a unit
#      CANNOT use systemd's ordinary `ExecStart=/bin/foo $ARGS` +
#      EnvironmentFile idiom. That is the correct fail-closed default here --
#      every `$` in these templates today is a render variable -- but it is a
#      rule, not an accident. A unit that genuinely needs systemd-side
#      expansion needs this assertion taught the difference first; meeting it
#      as a broken install is the wrong way to find out.
#
#   4. unit_render_verify_staged runs systemd's own parser over the staged set
#      on the install path. It is NOT a weaker fourth opinion: for a value
#      that is present but INVALID it is the only check any of this has. See
#      its header for why its absence is therefore fatal.
#
# Check 4 is deliberately NOT wired into check-unit-drift.sh: that script
# renders for byte-comparison against /etc/systemd/system using a DEPLOYMENT
# INSTALL_ROOT that need not exist on the machine running the check, so
# systemd-analyze's filesystem opinions there would be noise, not evidence.

# Check 4 classifies MACHINE FACTS separately from render defects. Two of its
# lines are claims about the machine running the check rather than about the
# rendered bytes -- a missing ExecStart target, and a dependency unit that does
# not exist here -- and each has its own ledger of visible debt. See
# unit_render_verify_staged and instance/unit-dependency-exemptions.tsv.

# SOURCE THIS AT FILE SCOPE, never from inside a function. `declare -A` and
# `mapfile` create LOCALS when they run in a function body, so a sourcing
# caller would get an empty variable list and an empty SHELL-FORMAT -- an
# unrestricted render that empties every name, which is this row's defect
# reached by a new route. Both current callers (bootstrap/install.sh,
# bootstrap/check-unit-drift.sh) source at top level.

# Where this library sits, so the ledger and manifest it consults are found
# relative to the checkout it was sourced from rather than the caller's cwd.
# Built from builtins only: unit_render_verify_staged must keep working on a
# PATH that carries nothing but the interpreter, which is the condition the
# systemd-analyze-absence arm of the lock puts it under.
if [[ "${BASH_SOURCE[0]}" == */* ]]; then
  UNIT_RENDER_LIB_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
else
  UNIT_RENDER_LIB_DIR="$PWD"
fi

# ── The one list ────────────────────────────────────────────────────────────
# Every variable any tracked unit template may reference, with the default
# used when the caller does not override it. Nothing else in this repository
# may carry a second copy of these names or these values.
declare -A UNIT_RENDER_DEFAULTS=(
  [INSTALL_ROOT]='/root/bpa-dev-infrastructure'
  [ENV_FILE]='/root/.config/bpa/orchestrator.env'
  [BUN_BIN]='/usr/local/bin/bun'
  [BASH_BIN]='/usr/bin/bash'
  [FULL_SUITE_ON_CALENDAR]='*-*-* 03:30:00'
  [ORCH_WATCHDOG_INTERVAL]='60'
)

# Names are DERIVED from the defaults map, never typed twice: a name present in
# one list and absent from the other is the class of bug this file exists to
# end. Sorted so every renderer, every `--print-env` dump and every test sees
# the same order regardless of hash iteration.
mapfile -t UNIT_RENDER_VARS < <(printf '%s\n' "${!UNIT_RENDER_DEFAULTS[@]}" | LC_ALL=C sort)

# Applied at source time on purpose. A caller that had to remember to call an
# initializer is a caller that can forget to, which is the failure mode above
# wearing a different hat. Existing values always win, so an override in the
# environment (or a test fixture) still works.
unit_render_apply_defaults() {
  local name
  for name in "${UNIT_RENDER_VARS[@]}"; do
    printf -v "$name" '%s' "${!name:-${UNIT_RENDER_DEFAULTS[$name]}}"
  done
}
unit_render_apply_defaults

# ── Environment plumbing ────────────────────────────────────────────────────
# Deliberately NOT `export`ed at source time. install.sh runs the repository's
# whole Bun suite (run_install_test_gate) and already strips its own
# configuration out of that child environment; exporting six installer values
# into every test process would leak installer configuration into fixtures
# that read the same names. Callers get the assignments explicitly instead.

# Fill a caller-named array with NAME=value assignments suitable for `env`.
# Usage: local -a e=(); unit_render_env_assignments e; env "${e[@]}" some-cmd
unit_render_env_assignments() {
  local -n _unit_render_out="$1"
  local name
  _unit_render_out=()
  for name in "${UNIT_RENDER_VARS[@]}"; do
    _unit_render_out+=("$name=${!name}")
  done
}

# The envsubst SHELL-FORMAT argument: "${A}${B}..." restricts substitution to
# exactly these names.
unit_render_shell_format() {
  local name fmt=''
  for name in "${UNIT_RENDER_VARS[@]}"; do
    fmt+="\${$name}"
  done
  printf '%s' "$fmt"
}

# An empty render variable reproduces the original defect from the other
# direction: the name IS in the list, but its value is empty, so
# `OnUnitActiveSec=${ORCH_WATCHDOG_INTERVAL}s` renders as the unparsable `s`,
# which the post-render key check cannot see (that value is not empty, it is
# wrong). A caller cannot reach that state -- unit_render_apply_defaults uses
# `:-`, so an explicitly empty override is replaced by the default, which is
# what bootstrap/check-unit-drift.test.ts relies on when it deliberately
# passes BUN_BIN="" to prove the script does not depend on a caller-supplied
# value. What this check actually guards is an empty entry in
# UNIT_RENDER_DEFAULTS itself: adding a name to the map with no value would
# otherwise render silently and emptily, exactly like the bug above.
unit_render_require_env() {
  local name missing=0
  for name in "${UNIT_RENDER_VARS[@]}"; do
    if [[ -z "${!name:-}" ]]; then
      printf 'RENDER-ENV-EMPTY %s: render variable is unset or empty; refusing to render\n' "$name" >&2
      missing=1
    fi
  done
  return "$missing"
}

# ── Post-render assertion ───────────────────────────────────────────────────
# envsubst can only rewrite lines, never add or remove them, so template line
# N and rendered line N correspond. A differing line count means something
# substituted a newline and the pairing below would be meaningless -- refuse
# rather than compare the wrong lines.
unit_render_assert_complete() {
  local template="$1" rendered="$2" unit="$3"
  awk -v unit="$unit" '
    function blank(s) { gsub(/[[:space:]]/, "", s); return s == "" }
    NR == FNR { tpl[FNR] = $0; tn = FNR; next }
    { ren[FNR] = $0; rn = FNR }
    END {
      if (tn != rn) {
        printf("RENDER-LINE-COUNT %s: template has %d lines, rendered has %d\n", unit, tn, rn) > "/dev/stderr"
        exit 1
      }
      for (i = 1; i <= tn; i++) {
        # Check 2: a residual `$` means envsubst was never told about a name
        # the template uses. Restricted substitution is what makes this
        # reachable; unrestricted envsubst would have emptied it instead.
        if (index(ren[i], "$") > 0) {
          printf("RENDER-RESIDUAL-VAR %s:%d: no renderer supplies this variable: %s\n", unit, i, ren[i]) > "/dev/stderr"
          bad = 1
        }
        # Check 3: a key that carried a value in the template must still carry
        # one. This is the check that catches `OnCalendar=` directly.
        if (match(tpl[i], /^[A-Za-z][A-Za-z0-9_-]*=/)) {
          key = substr(tpl[i], 1, RLENGTH - 1)
          tval = substr(tpl[i], RLENGTH + 1)
          if (blank(tval)) continue
          if (substr(ren[i], 1, RLENGTH) != substr(tpl[i], 1, RLENGTH)) {
            printf("RENDER-KEY-CHANGED %s:%d: %s= became %s\n", unit, i, key, ren[i]) > "/dev/stderr"
            bad = 1
            continue
          }
          # Whitespace-only counts as empty: `OnCalendar= ` clears a schedule
          # exactly as `OnCalendar=` does, so a variable holding only spaces
          # must not read as a surviving value.
          if (blank(substr(ren[i], RLENGTH + 1))) {
            printf("RENDER-EMPTY-VALUE %s:%d: %s= rendered empty from template value \"%s\"\n", unit, i, key, tval) > "/dev/stderr"
            bad = 1
          }
        }
      }
      exit bad
    }
  ' "$template" "$rendered"
}

# ── The render itself ───────────────────────────────────────────────────────
# unit_render_template TEMPLATE OUTPUT [UNIT_NAME]
# Renders one template and validates the result. Non-zero means the output is
# not fit to deploy or to compare against; the reason is already on stderr.
unit_render_template() {
  local template="$1" out="$2" unit="${3:-}"
  if [[ -z "$unit" ]]; then
    unit="$(basename "$template")"
    unit="${unit%.in}"
  fi
  if [[ ! -f "$template" || ! -r "$template" ]]; then
    printf 'RENDER-TEMPLATE-UNREADABLE %s: %s\n' "$unit" "$template" >&2
    return 1
  fi
  command -v envsubst >/dev/null 2>&1 || {
    printf 'RENDER-NO-ENVSUBST %s: envsubst is required to render unit templates\n' "$unit" >&2
    return 1
  }
  unit_render_require_env || return 1
  local -a render_env=()
  unit_render_env_assignments render_env
  if ! env "${render_env[@]}" envsubst "$(unit_render_shell_format)" < "$template" > "$out"; then
    printf 'RENDER-FAILED %s: envsubst exited non-zero for %s\n' "$unit" "$template" >&2
    return 1
  fi
  unit_render_assert_complete "$template" "$out" "$unit"
}

# ── systemd's own opinion of the staged output ──────────────────────────────
# unit_render_verify_staged STAGED_DIR
#
# Runs before anything is published, and is MANDATORY: see "not a fourth,
# weaker check" below. The exit status of `systemd-analyze verify` is NOT
# usable on its own, in either direction:
#
#   - it exits 1 for "Command /x/y is not executable", which is a claim about
#     files on THIS machine, not about the render. Whether a unit may name a
#     path this repository does not carry yet is owned by
#     bootstrap/check-unit-drift.sh's referenced-path check and its
#     instance/unit-path-exemptions.tsv ledger -- deciding it a second time
#     here would either duplicate that ledger or overrule it.
#   - it exits 0 while printing "Failed to parse timer value, ignoring: s".
#     Verified against systemd 255 on 2026-08-05: the exact defect this row is
#     about passes `systemd-analyze verify` with status 0. A check that quietly
#     does nothing is the class this row belongs to, so the OUTPUT decides.
#
# Every emitted line is therefore classified, and an unrecognized line is
# fatal. Silence plus a non-zero status is fatal too -- an unexplained failure
# is not a pass.
#
# NOT A FOURTH, WEAKER CHECK -- for value validity it is the ONLY check.
# The render assertions above see three things: a residual `$`, a `key=` line
# that lost the value its template had, and a changed line count. They cannot
# see a value that is PRESENT BUT WRONG, and that is half of this row's own
# defect:
#
#   OnCalendar=            (emptied)      -> RENDER-EMPTY-VALUE catches it
#   OnUnitActiveSec=s      (unparsable)   -> ONLY systemd-analyze catches it
#
# unit_render_require_env cannot reach the second one either: `:-` semantics
# mean an empty override is replaced by the default, so an empty variable is
# unreachable -- a wrong one is not. So absence of systemd-analyze is FATAL
# (`return 1`), not a warning. Returning 0 there would install a
# value-unvalidated unit set under a success banner, which is the sentence
# instructions/verification-and-locks.md forbids: a skipped or unverifiable
# result is NO-GO, never clean.
#
# The cost is approximately zero and was measured, not assumed: `dpkg -S` puts
# systemd-analyze and systemctl in the SAME package (systemd), so any host that
# can arm a timer already has it, and a host that lacks it cannot run these
# timers at all. render_units already refuses to run without root and without
# envsubst; a hard prerequisite here matches that posture. If a container tier
# ever genuinely cannot carry the package, the escape is an explicitly named,
# evidence-producing opt-out recorded in the change record -- not a silent
# default, and not added speculatively.

# The ONE benign line class, anchored to the whole message shape rather than
# matched as a substring. `systemd-analyze verify` reports a missing ExecStart
# target as:
#
#   <unit>: Command <path> is not executable: No such file or directory
#
# The predicate used to be `*"is not executable: No such file or directory"*`
# -- unanchored on both sides. systemd echoes DIRECTIVE VALUES into its other
# diagnostics ("Failed to parse timer value, ignoring: <value>"), so a value
# carrying that phrase dragged a fatal line into the benign class and this
# function printed "accepted" over a permanently disarmed timer. That is this
# row's own defect, restored through this row's own new check.
#
# Anchoring at both ends is what closes it, and it closes strictly more than a
# prefix/suffix substring pair would: systemd prefixes a directive complaint
# with `<unit>:<line>:`, so the first colon is followed by a digit, while the
# benign line's first colon is followed by ` Command `. Laundered text can
# therefore never reach the start of the line, whatever it contains -- not even
# a value that itself embeds `: Command … is not executable: No such file or
# directory`. Verified against systemd 255 over the live output of every
# tracked template: all four legitimate lines stay NOTE, and every crafted
# variant is FATAL.
UNIT_RENDER_BENIGN_VERIFY_LINE='^[^[:space:]:]+\.[A-Za-z]+: Command .+ is not executable: No such file or directory$'

# ── The second machine-fact class: a dependency that does not resolve HERE ──
#
# V3-2.12 round 4. `Requires=postgresql.service` in a tracked template makes
# systemd-analyze emit, on a machine where that unit does not exist:
#
#   <unit>: Failed to create <unit>/start: Unit <required> not found.
#
# Verified against systemd 255: Requires=, Requisite= and BindsTo= produce it;
# After=, Wants= and PartOf= produce nothing.
#
# That is the SAME KIND of claim as the benign line above -- about what exists
# on the machine running the check, not about the rendered bytes -- and it was
# classified FATAL because no ledger existed for it. The consequence was not
# theoretical: the whole point of this row is a clean-machine rebuild, and on a
# clean machine every render refused to publish. This host passed only because
# it happens to have postgresql.service installed, which is precisely the drift
# between "the machine that checks" and "the machine that runs" that a machine
# fact must be ledgered rather than decided by accident.
#
# The ledger is instance/unit-dependency-exemptions.tsv, keyed on the EXACT
# unit+required-unit pair for the same reason unit-path-exemptions.tsv is:
# a whole-unit exemption would license any future unresolvable dependency added
# to that template, wearing the original, unrelated justification.
#
# VISIBLE DEBT, not a mute button. An entry is REJECTED when the unit it names
# does resolve -- that is, when this repository's own manifest renders it. If we
# ship the unit, a "not found" for it is a real defect (a typo, a manifest gap,
# a missing Install section), and exempting it would hide exactly the class this
# row exists to end. The same test in the other direction rejects an entry for a
# depending unit the manifest no longer carries, so a row cannot outlive the
# template that justified it.
#
# "Does resolve" is deliberately answered from the MANIFEST and never by asking
# the local systemd (`systemctl cat`, a unit-path probe, ...). A host probe would
# make this host and a clean container disagree about whether the same commit is
# valid, which is the defect being fixed here, not a fix for it.
UNIT_DEPENDENCY_EXEMPTIONS_FILE="${UNIT_DEPENDENCY_EXEMPTIONS_FILE:-$UNIT_RENDER_LIB_DIR/../instance/unit-dependency-exemptions.tsv}"
UNIT_RENDER_MANIFEST_FILE="${UNIT_RENDER_MANIFEST_FILE:-$UNIT_RENDER_LIB_DIR/../instance/expected-units.tsv}"
# Anchored to the WHOLE message shape, both ends, like the benign class -- an
# unanchored predicate here is the defect the anchored benign line just closed,
# one class over. Three independent things must hold before a line is a machine
# fact: the line matches this shape from ^ to $; the unit it is prefixed with is
# the same unit the failed job belongs to; and that unit is one of the files
# being verified. systemd prefixes a directive complaint with `<unit>:<line>:`,
# so an echoed DIRECTIVE VALUE can never reach the start of the line, and the
# unit tokens here admit no colon, so it cannot forge the prefix either.
UNIT_RENDER_MISSING_DEPENDENCY_VERIFY_LINE='^([A-Za-z0-9@_.-]+\.[A-Za-z]+): Failed to create ([A-Za-z0-9@_.-]+\.[A-Za-z]+)/[A-Za-z-]+: Unit ([A-Za-z0-9@_.-]+\.[A-Za-z]+) not found\.$'

# Populated by unit_render_load_dependency_exemptions. Declared at file scope on
# purpose: `declare -A` inside a function creates a LOCAL, which is the same
# foot-gun the header warns about for UNIT_RENDER_DEFAULTS.
declare -A UNIT_RENDER_DEPENDENCY_EXEMPTIONS=()
# US (0x1F) cannot appear in a TSV field or a systemd unit name.
UNIT_RENDER_KEY_SEP=$'\x1f'

unit_render_is_unit_name() {
  [[ "$1" =~ ^[A-Za-z0-9@_.-]+\.(service|socket|target|device|mount|automount|swap|path|timer|slice|scope)$ ]]
}

# Read the expected-units manifest into a caller-named associative array. This
# is the same file bootstrap/install.sh renders from and
# bootstrap/check-unit-drift.sh checks against. Both it and the ledger are
# resolved relative to THIS library, so the two files a staleness verdict
# compares always come from one tree; pinning the manifest to a caller's
# INSTALL_ROOT while the ledger came from the source checkout would judge one
# tree's debt against another tree's fleet.
unit_render_load_manifest() {
  local -n _unit_render_manifest="$1"
  local unit rest
  _unit_render_manifest=()
  if [[ ! -f "$UNIT_RENDER_MANIFEST_FILE" || ! -r "$UNIT_RENDER_MANIFEST_FILE" ]]; then
    printf 'UNIT-VERIFY-LEDGER-NO-MANIFEST %s: cannot decide whether a ledgered dependency resolves without the expected-units manifest\n' \
      "$UNIT_RENDER_MANIFEST_FILE" >&2
    return 1
  fi
  while IFS=$'\t' read -r unit rest || [[ -n "${unit:-}" ]]; do
    [[ -z "$unit" || "$unit" == \#* ]] && continue
    _unit_render_manifest["$unit"]=1
  done < "$UNIT_RENDER_MANIFEST_FILE"
  ((${#_unit_render_manifest[@]} > 0)) || {
    printf 'UNIT-VERIFY-LEDGER-NO-MANIFEST %s: manifest is empty\n' "$UNIT_RENDER_MANIFEST_FILE" >&2
    return 1
  }
}

# Load and VALIDATE the dependency-exemption ledger. Runs on every verify, even
# on a machine where no dependency is missing, so a stale or malformed row is
# visible everywhere rather than only where it would have been used. Absence of
# the file is not an error -- it means no exemption exists, and every
# unresolvable dependency stays fatal. Every other doubt fails closed.
unit_render_load_dependency_exemptions() {
  local file="$UNIT_DEPENDENCY_EXEMPTIONS_FILE"
  local unit required evidence extra key bad=0 entries=0
  local -A manifest=()
  UNIT_RENDER_DEPENDENCY_EXEMPTIONS=()
  if [[ -e "$file" ]] && { [[ ! -f "$file" ]] || [[ ! -r "$file" ]]; }; then
    printf 'UNIT-VERIFY-LEDGER-UNREADABLE %s: exists but is not a readable regular file (refusing to treat as empty)\n' "$file" >&2
    return 1
  fi
  [[ -e "$file" ]] || return 0
  while IFS=$'\t' read -r unit required evidence extra || [[ -n "${unit:-}" ]]; do
    [[ -z "$unit" || "$unit" == \#* ]] && continue
    ((entries += 1))
    if [[ -n "${extra:-}" ]] || ! unit_render_is_unit_name "$unit" \
      || ! unit_render_is_unit_name "${required:-}" || [[ -z "${evidence:-}" ]]; then
      printf 'UNIT-VERIFY-LEDGER-INVALID %s: an entry is <unit>TAB<required-unit>TAB<evidence>, all three present\n' "$unit" >&2
      bad=1
      continue
    fi
    key="$unit$UNIT_RENDER_KEY_SEP$required"
    if [[ -n "${UNIT_RENDER_DEPENDENCY_EXEMPTIONS[$key]+x}" ]]; then
      printf 'UNIT-VERIFY-LEDGER-DUPLICATE %s: %s is exempted twice\n' "$unit" "$required" >&2
      bad=1
      continue
    fi
    if ((${#manifest[@]} == 0)) && ! unit_render_load_manifest manifest; then
      return 1
    fi
    if [[ -n "${manifest[$required]+x}" ]]; then
      printf 'UNIT-VERIFY-LEDGER-STALE %s: %s is rendered by this repository (%s), so it resolves -- a not-found for it is a real defect, not a machine fact\n' \
        "$unit" "$required" "$UNIT_RENDER_MANIFEST_FILE" >&2
      bad=1
      continue
    fi
    if [[ -z "${manifest[$unit]+x}" ]]; then
      printf 'UNIT-VERIFY-LEDGER-STALE %s: this repository no longer renders that unit (%s); the entry outlived the template that justified it\n' \
        "$unit" "$UNIT_RENDER_MANIFEST_FILE" >&2
      bad=1
      continue
    fi
    UNIT_RENDER_DEPENDENCY_EXEMPTIONS["$key"]="$evidence"
  done < "$file"
  if ((entries == 0)); then
    printf 'UNIT-VERIFY-LEDGER-EMPTY %s: the file exists but declares nothing; delete it or name the debt\n' "$file" >&2
    return 1
  fi
  return "$bad"
}

unit_render_verify_staged() {
  local staged="$1" output line rc=0 fatal=0 lines=0
  local subject job_unit required key staged_file
  local -a staged_units=()
  local -A staged_names=()
  # Enumerate explicitly rather than handing systemd-analyze a bare glob: an
  # empty directory would otherwise pass the literal `dir/*` through and be
  # reported as an ordinary parse error, which reads like a verified render.
  mapfile -t staged_units < <(find "$staged" -mindepth 1 -maxdepth 1 -type f -printf '%p\n' 2>/dev/null | LC_ALL=C sort)
  if ((${#staged_units[@]} == 0)); then
    printf 'UNIT-VERIFY: no staged unit files found in %s (refusing to report a verified render)\n' "$staged" >&2
    return 1
  fi
  for staged_file in "${staged_units[@]}"; do
    staged_names["${staged_file##*/}"]=1
  done
  # Before systemd is asked anything: a ledger that cannot be read, parsed, or
  # justified refuses the render on every machine, including the ones where no
  # dependency is missing and no entry would have been consulted.
  if ! unit_render_load_dependency_exemptions; then
    printf 'UNIT-VERIFY: the dependency-exemption ledger %s was rejected (nothing verified)\n' \
      "$UNIT_DEPENDENCY_EXEMPTIONS_FILE" >&2
    return 1
  fi
  if ! command -v systemd-analyze >/dev/null 2>&1; then
    printf 'UNIT-VERIFY-UNAVAILABLE: systemd-analyze is not on PATH -- the staged units in %s were NOT verified by systemd. This check did nothing; treat the render as proven only by the render assertions above. systemd-analyze is a HARD PREREQUISITE of rendering units, not an optional extra: it ships in the same package as systemctl, so any host that can arm these timers has it, and it is the ONLY check here that sees a directive value that is present but invalid.\n' \
      "$staged" >&2
    return 1
  fi
  output="$(systemd-analyze verify "${staged_units[@]}" 2>&1)" && rc=0 || rc=$?
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    ((lines += 1))
    if [[ "$line" =~ $UNIT_RENDER_BENIGN_VERIFY_LINE ]]; then
      printf 'UNIT-VERIFY-NOTE %s (path presence is check-unit-drift.sh scope)\n' "$line" >&2
      continue
    fi
    if [[ "$line" =~ $UNIT_RENDER_MISSING_DEPENDENCY_VERIFY_LINE ]]; then
      subject="${BASH_REMATCH[1]}"
      job_unit="${BASH_REMATCH[2]}"
      required="${BASH_REMATCH[3]}"
      # The line must be systemd talking about a unit we handed it, about its
      # own job. Anything else falls through to fatal below.
      if [[ "$subject" == "$job_unit" && -n "${staged_names[$subject]+x}" ]]; then
        key="$subject$UNIT_RENDER_KEY_SEP$required"
        if [[ -n "${UNIT_RENDER_DEPENDENCY_EXEMPTIONS[$key]+x}" ]]; then
          printf 'UNIT-VERIFY-NOTE %s (ledgered machine fact: %s)\n' \
            "$line" "${UNIT_RENDER_DEPENDENCY_EXEMPTIONS[$key]}" >&2
          continue
        fi
        printf 'UNIT-VERIFY-FATAL %s -- no entry for %s + %s in %s; a dependency this machine cannot resolve is debt that must be named there, with evidence\n' \
          "$line" "$subject" "$required" "$UNIT_DEPENDENCY_EXEMPTIONS_FILE" >&2
        fatal=1
        continue
      fi
    fi
    printf 'UNIT-VERIFY-FATAL %s\n' "$line" >&2
    fatal=1
  done <<<"$output"
  if ((fatal != 0)); then
    printf 'UNIT-VERIFY: systemd-analyze rejected the staged units in %s\n' "$staged" >&2
    return 1
  fi
  if ((rc != 0 && lines == 0)); then
    printf 'UNIT-VERIFY: systemd-analyze exited %d with no output for %s (unexplained failure)\n' "$rc" "$staged" >&2
    return 1
  fi
  printf 'UNIT-VERIFY: systemd-analyze accepted the staged units in %s\n' "$staged"
}

# ── Direct invocation (tests, humans, and anything not written in bash) ─────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
  case "${1:-}" in
    --print-env)
      for _unit_render_name in "${UNIT_RENDER_VARS[@]}"; do
        printf '%s=%s\n' "$_unit_render_name" "${!_unit_render_name}"
      done
      ;;
    --print-names) printf '%s\n' "${UNIT_RENDER_VARS[@]}" ;;
    --render)
      shift
      (($# == 2 || $# == 3)) || { echo 'Usage: unit-render-lib.sh --render TEMPLATE OUTPUT [UNIT]' >&2; exit 2; }
      unit_render_template "$@"
      ;;
    --verify-staged)
      shift
      (($# == 1)) || { echo 'Usage: unit-render-lib.sh --verify-staged STAGED_DIR' >&2; exit 2; }
      unit_render_verify_staged "$1"
      ;;
    *)
      cat >&2 <<'EOF'
Usage: bootstrap/unit-render-lib.sh <mode>
  --print-env                    print NAME=value for every render variable
  --print-names                  print every render variable name
  --render TEMPLATE OUT [UNIT]   render one template and validate the result
  --verify-staged DIR            run systemd-analyze verify over a staged set
Source this file to use unit_render_template/unit_render_verify_staged directly.
EOF
      exit 2
      ;;
  esac
fi
