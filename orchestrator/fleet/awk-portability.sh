# shellcheck shell=bash
# Sourced by the fleet watchdog's regression locks. Not executable on its own.
#
# Why this exists: V3-2.11 round 2 was ACCEPTed by both lenses of the Tier-A
# consilium on this host and then refused by the landing gate's meteorite proof.
# This host carries gawk 5.2.1; a clean Ubuntu 24.04 carries mawk. The board
# parser used a regex interval (`-{2,}`), which mawk does not enable by default,
# so under mawk every table separator row failed the id recognizer and every
# board read as structurally damaged. The watchdog would have refused every board
# on the rebuilt server and paged the operator forever — fail-closed, correct,
# and useless. That is Hard Floor 5 failing in the exact direction it exists to
# catch: the repository alone must bring the host back.
#
# The locks that use this harness pin the interpreter BY NAME. Running under
# whatever `awk` happens to be first on PATH is precisely the hole round 2 fell
# through, because on the machine that runs the suite that awk is gawk.

# Prints the path of a directory whose only entry is `awk -> mawk`; prepend it to
# PATH to replay a lock through mawk. Prints nothing (and succeeds) when this
# machine has no real mawk to prove anything against — the caller must then take
# the loud-skip path below rather than reporting a pass.
awk_portability_shim() { # tmpdir
  local bin dir ver
  bin=$(command -v mawk 2>/dev/null) || return 0
  [ -n "$bin" ] || return 0
  # `mawk` can be an alternatives symlink onto gawk. A shim that is secretly the
  # same interpreter as the default one proves nothing, so ask the binary what it
  # is instead of trusting its name. Captured whole rather than piped into `head`:
  # these suites run under `pipefail` and a closed pipe would fail the check for
  # the wrong reason.
  ver=$("$bin" -W version 2>&1) || true
  case "$ver" in
    mawk*) ;;
    *) return 0 ;;
  esac
  dir="$1/awk-portability-shim"
  mkdir -p "$dir" || return 0
  ln -sf "$bin" "$dir/awk" || return 0
  printf '%s' "$dir"
}

# A skip must be impossible to mistake for a pass. This prints to stderr; callers
# ALSO carry the skip into their final PASS line, so the recorded evidence says
# which of the two interpreters was actually proven.
awk_portability_skip_notice() { # suite-name
  cat >&2 <<EOF

################################################################
## SKIPPED: $1 did NOT run its awk-portability lock.
## mawk is not installed here, so the board parser is proven
## under this machine's awk ONLY. A clean Ubuntu 24.04 ships
## mawk, and that is the machine on which V3-2.11 round 2 was
## refused. This suite has NOT proven portability.
## Install it (apt-get install -y mawk) and rerun.
################################################################

EOF
}
