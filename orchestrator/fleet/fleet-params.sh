#!/usr/bin/env bash
# One home for reading the fleet block of instance/params.yaml from shell, and
# for taking the lane census that the cap is enforced against.
#
# Why this file exists (workboard V3-5.10). The cap and the ruling that declares
# it were RETYPED into every mechanism that mentioned them: the launcher had no
# cap at all, `orchestrator/fleet/fleet-nudge.sh` carried `${FLEET_NUDGE_CAP:-5}`
# as a literal default and quoted a literal `HR-2456` in the message it pastes to
# the orchestrator, and `daemon/autonomy-keepalive.ts` quoted the same id in its
# own. All three were correct only because a person edited them together at the
# last cap change, and the evidence that this does not hold is already in the
# tree: at the moment this file was written, fleet-nudge.sh's own comment still
# read "caps parallel lanes at five" against a parameter of three.
#
# So the number and the ruling id are read from instance/params.yaml, which
# tools/check-fleet-cap.ts already holds against the decision ledger — the cap
# against every binding record declaring a live `lane_cap:`, and `declared_by`
# against the set of records that declare it. Nothing downstream retypes either.
#
# Sourced, not executed: `source .../fleet-params.sh` then call the functions.
# POSIX-clean awk, no regex intervals — a clean Ubuntu has mawk and this code
# runs on the fleet's launch path (see the awk note in fleet-nudge.sh).

# The value of one key in the `fleet:` block, comments stripped. Prints nothing
# and returns 1 when the file, the block, or the key is absent — an unreadable
# parameter is never silently a number.
#
# The accepted grammar, stated so that the next reader of this file does not have
# to derive it from the program (it is a fixed subset of YAML, not YAML):
#
#   * the block opens on a column-1 `fleet:`, optionally with a trailing comment;
#   * it closes at the next column-1 line that is NOT a comment. A `#` in column
#     one is a comment wherever it sits, so a comment reflowed to the left margin
#     inside the block does not truncate it. It used to: the terminator was
#     `/^[^ \t]/`, which a `#` satisfies, and because an unreadable cap is a
#     refusal evaluated BEFORE `--allow-over-cap`, that reflow stopped every
#     dispatch in the fleet with no override path (review F4);
#   * only keys at the block's OWN indentation are the block's keys. The reader
#     was depth-blind and answered `cap` with a `cap:` nested under any subkey of
#     `fleet:` (review F5), which is a different parameter wearing the same name;
#   * a scalar may be bare, single-quoted or double-quoted — `cap: "3"` is valid
#     YAML and was a total dispatch refusal. A `#` INSIDE a quoted scalar still
#     begins a comment here; no fleet parameter is prose, so that limit is
#     declared rather than parsed around.
fleet_param() { # repo key
  local value
  [ -r "$1/instance/params.yaml" ] || return 1
  value=$(awk -v want="$2" '
    /^fleet:[ \t]*(#.*)?$/ { inside = 1; depth = 0; next }
    /^[ \t]*#/ { next }
    /^[^ \t]/ { inside = 0 }
    inside {
      if (match($0, /^[ \t]+[A-Za-z][A-Za-z0-9_]*:/)) {
        indent = 0
        while (substr($0, indent + 1, 1) == " " || substr($0, indent + 1, 1) == "\t") indent++
        if (depth == 0) depth = indent
        if (indent != depth) next
        key = substr($0, 1, RLENGTH - 1)
        gsub(/^[ \t]+/, "", key)
        if (key == want) {
          val = substr($0, RLENGTH + 1)
          sub(/[ \t]*#.*$/, "", val)
          gsub(/^[ \t]+/, "", val)
          gsub(/[ \t]+$/, "", val)
          quote = substr(val, 1, 1)
          if (length(val) > 1 && (quote == "\"" || quote == sprintf("%c", 39)) &&
              substr(val, length(val), 1) == quote) {
            val = substr(val, 2, length(val) - 2)
          }
          print val
          exit
        }
      }
    }
  ' "$1/instance/params.yaml")
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

# The cap, validated as a positive integer. A missing or malformed cap returns 1
# rather than a fallback: the caller must refuse or say so, because a default
# invented here is exactly the retyped literal this file removes.
fleet_cap() { # repo
  local value
  value=$(fleet_param "$1" cap) || return 1
  case "$value" in
    '' | *[!0-9]*) return 1 ;;
    # A leading zero is refused, including a bare 0. `09` used to reach the
    # launcher's `((running >= cap))`, where bash reads a leading-zero literal as
    # OCTAL: `09` is not valid octal, so the arithmetic errored, evaluated false,
    # and the launcher LAUNCHED at twelve running — a cap that fails open, in the
    # one mechanism written to be fail-closed (review F1). `010` was the quiet
    # half: read as 8, enforced as 8, quoted as `010` in every message.
    #
    # Refused rather than normalised with `10#`, because the ambiguity is real
    # and not bash's alone: bash arithmetic and a YAML 1.1 loader both read `010`
    # as 8, YAML 1.2 reads the string, and tools/check-fleet-cap.ts reads 10.
    # Normalising here would make this reader agree with the checker while both
    # disagreed with a YAML loader — one number, two answers, which is the exact
    # class of drift this file exists to remove. No cap needs a leading zero.
    0*) return 1 ;;
  esac
  printf '%s' "$value"
}

# The ruling id(s) that declare the live cap, for operator-facing messages.
# Derived here only in the sense of being read from one place; the value itself
# is held against instance/decisions/ by tools/check-fleet-cap.ts on every run,
# so a ledger change that nobody mirrored here fails the check rather than
# quietly printing a superseded ruling at the operator.
fleet_declared_by() { # repo
  local value
  value=$(fleet_param "$1" declared_by) || return 1
  case "$value" in
    HR-[0-9]*) printf '%s' "$value" ;;
    *) return 1 ;;
  esac
}

# The lane census: how many lane units are running right now. This is the same
# question `systemctl list-units --state=running 'lane-*'` answered inline in
# fleet-nudge.sh, kept in one place so the cap is enforced against the same
# number the watchdog reports. Returns 1 when the census cannot be taken at all,
# which is a refusal condition for the launcher, not a zero.
fleet_running_lanes() {
  local units
  command -v systemctl >/dev/null 2>&1 || return 1
  units=$(systemctl list-units --type=service --state=running --no-legend 'lane-*' 2>/dev/null) || return 1
  # The counted contract is one unit per line: an optional marker column, then
  # the unit name. systemd prefixes a line with `●` when the unit is not happy,
  # and the previous pattern `^[ \t]*lane-` did not survive it — in a BRE,
  # `[ \t]` is the literal set {space, backslash, t} and not a tab, so a bulleted
  # lane was skipped and the census UNDER-counted (review F7). An undercount is
  # the fail-open direction for a cap, so the prefix is now "anything that is not
  # part of the unit name", and `.service` pins the field rather than trusting
  # the column.
  printf '%s' "$units" | grep -cE '^[^[:alnum:]]*lane-[^[:space:]]*\.service' || true
}
