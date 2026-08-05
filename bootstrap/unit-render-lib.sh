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
# unit_render_verify_staged adds a fourth, weaker check (systemd's own parser)
# for the install path only. It is deliberately NOT wired into
# check-unit-drift.sh: that script renders for byte-comparison against
# /etc/systemd/system using a DEPLOYMENT INSTALL_ROOT that need not exist on
# the machine running the check, so systemd-analyze's filesystem opinions
# there would be noise, not evidence.

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
# Runs before anything is published. The exit status of `systemd-analyze
# verify` is NOT usable on its own, in either direction:
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
unit_render_verify_staged() {
  local staged="$1" output line rc=0 fatal=0 lines=0
  local -a staged_units=()
  # Enumerate explicitly rather than handing systemd-analyze a bare glob: an
  # empty directory would otherwise pass the literal `dir/*` through and be
  # reported as an ordinary parse error, which reads like a verified render.
  mapfile -t staged_units < <(find "$staged" -mindepth 1 -maxdepth 1 -type f -printf '%p\n' 2>/dev/null | LC_ALL=C sort)
  if ((${#staged_units[@]} == 0)); then
    printf 'UNIT-VERIFY: no staged unit files found in %s (refusing to report a verified render)\n' "$staged" >&2
    return 1
  fi
  if ! command -v systemd-analyze >/dev/null 2>&1; then
    printf 'UNIT-VERIFY-UNAVAILABLE: systemd-analyze is not on PATH -- the staged units in %s were NOT verified by systemd. This check did nothing; treat the render as proven only by the render assertions above.\n' \
      "$staged" >&2
    return 0
  fi
  output="$(systemd-analyze verify "${staged_units[@]}" 2>&1)" && rc=0 || rc=$?
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    ((lines += 1))
    if [[ "$line" == *"is not executable: No such file or directory"* ]]; then
      printf 'UNIT-VERIFY-NOTE %s (path presence is check-unit-drift.sh scope)\n' "$line" >&2
      continue
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
