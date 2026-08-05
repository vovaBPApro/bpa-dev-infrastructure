#!/usr/bin/env bash
# Install or refresh the BPA development infrastructure checkout as the root
# system account -- STAGE 2.
#
# Ported from v2-deprecated (bootstrap/install.sh, 598 lines, ten stages) for
# workboard row S3-2 / V3-1.1. Stage 2 adds hygiene-cron installation, the
# repository's complete Bun test gate, manifest-driven unit rendering, and
# the verify rows those stages need. Unit activation and the watchdog
# arm/disarm pair remain explicitly out of scope. activate_units runs
# `systemctl enable --now bpa-orchestrator.service`, which would restart the
# live orchestrator on this host; HR-1720 defers all host deployment, and that
# hazard is exactly what this render-only stage avoids. Later rows add it.
#
# workspace_status (donor) is dropped outright: v3 has no workspace/ tree.
# telegram-transport-preflight.sh is not sourced: its token and activation
# checks belong to the later activation stage.
#
# Modes: --dry-run (print the stage-2 plan and exit) and --verify-source
# (check only boundaries a source/container test can prove, no live host
# required). There is no --verify yet -- the donor's --verify checks systemd
# unit state and Docker/codex/claude/whisper tooling this row does not touch.
#
# Secrets are never accepted on the command line; edit ENV_FILE locally.
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.14}"
DRY_RUN=false
VERIFY_SOURCE=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# INSTALL_ROOT, ENV_FILE, BUN_BIN, BASH_BIN and the two timer values are
# defined ONLY in unit-render-lib.sh, which applies their defaults on source.
# This script deliberately carries no copy of those names or values: the
# installer's list and check-unit-drift.sh's list drifting apart is workboard
# row V3-2.12, and it silently disarmed both watchdog timers.
# shellcheck source=bootstrap/unit-render-lib.sh
source "$SCRIPT_DIR/unit-render-lib.sh"
SYSTEMD_SYSTEM_DIR="${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
RUNTIME_DIR="${RUNTIME_DIR:-$INSTALL_ROOT/runtime}"
STATE_DB="${INFRA_STATE_DB:-$RUNTIME_DIR/state.db}"
CRONTAB_CMD="${CRONTAB_CMD:-crontab}"
EXPECTED_UNITS_FILE="${EXPECTED_UNITS_FILE:-$INSTALL_ROOT/instance/expected-units.tsv}"

usage() {
  cat <<'EOF'
Usage: bootstrap/install.sh [--dry-run | --verify-source]

Stage 2: prerequisites, Bun, repository sync, environment, state database,
hygiene cron, repository test gate, and systemd unit rendering. This stage
does not enable, start, restart, or reload units.

Environment overrides: INSTALL_ROOT, REPO_URL, REPO_BRANCH (default: main),
BUN_VERSION, ENV_FILE, BUN_BIN, BASH_BIN, RUNTIME_DIR, INFRA_STATE_DB,
TEST_GATE_ORIGIN_URL,
CRONTAB_CMD, SYSTEMD_SYSTEM_DIR, EXPECTED_UNITS_FILE.
--verify-source checks only the boundaries a source/container test can prove
and reports explicit SKIPs where a live host would be required; there is no
--verify mode in this row.
The Telegram token is never accepted as an argument. Paste it into ENV_FILE
locally once a later row uses it.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --verify-source) VERIFY_SOURCE=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if "$DRY_RUN" && "$VERIFY_SOURCE"; then
  echo "ERROR: --dry-run and --verify-source are mutually exclusive" >&2
  exit 2
fi

plan() { printf 'PLAN %-12s %s\n' "$1" "$2"; }

print_plan() {
  plan "apt" "check git, curl, tmux, flock, findmnt, and unzip; install any missing packages"
  plan "bun" "install Bun ${BUN_VERSION} if $BUN_BIN is absent"
  plan "repository" "clone \$INSTALL_ROOT from REPO_URL on REPO_BRANCH, or fast-forward it -- refusing if it is checked out on any other branch"
  plan "environment" "create $ENV_FILE from bootstrap/env.template if absent, reject symlinks, and enforce mode 0600"
  plan "state-db" "initialize $STATE_DB with core/mission-cli.ts status"
  plan "hygiene" "install the tracked hygiene cron using $CRONTAB_CMD"
  plan "test-gate" "run the repository's complete Bun test suite"
  plan "units" "render every manifest-listed unit into $SYSTEMD_SYSTEM_DIR (render only)"
}

result=0
check() {
  local label="$1"; shift
  if "$@"; then
    printf 'PASS %-24s\n' "$label"
  else
    printf 'FAIL %-24s\n' "$label"
    result=1
  fi
}

state_db_status() {
  INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$INSTALL_ROOT/core/mission-cli.ts" status >/dev/null
}

hygiene_cron_status() {
  "$CRONTAB_CMD" -l 2>/dev/null | grep -Fxq '# BEGIN bpa-dev-infrastructure hygiene'
}

rendered_units_status() {
  local installed_root="$INSTALL_ROOT"
  # The render variables are forwarded as ONE list built from
  # unit-render-lib.sh. Naming them here individually is what made this check
  # validate a different render than the one install.sh had just deployed
  # (V3-2.12): the checker fell back to its own defaults for the two names
  # this call did not pass, so it compared against units the installer never
  # wrote.
  local -a render_env=()
  unit_render_env_assignments render_env
  env TEMPLATE_DIR="$installed_root/bootstrap/units" \
    INSTANCE_TEMPLATE_DIR="$installed_root/instance/units" \
    MANIFEST_FILE="$installed_root/instance/expected-units.tsv" \
    SYSTEMD_SYSTEM_DIR="$SYSTEMD_SYSTEM_DIR" \
    REPO_ROOT="$installed_root" \
    "${render_env[@]}" \
    "$installed_root/bootstrap/check-unit-drift.sh" >/dev/null
}

# Fail-closed by construction: every row is an explicit named check against a
# real predicate (command presence, file mode, a real mission-cli invocation).
# There is no directory-enumeration step here to blind-spot an absent item --
# that failure class (a checker that only sees what a glob finds) belongs to
# bootstrap/check-unit-drift.sh, not to this stage.
verify() {
  printf '%-6s %-24s\n' 'STATUS' 'CHECK'
  printf '%-6s %-24s\n' '------' '------------------------'
  check "git" command -v git
  check "curl" command -v curl
  check "tmux" command -v tmux
  check "flock" command -v flock
  check "findmnt" command -v findmnt
  check "bun" test -x "$BUN_BIN"
  check "repository" test -d "$INSTALL_ROOT/.git"
  check "environment file" test -f "$ENV_FILE"
  check "environment permissions" test "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)" = 600
  check "state-db" state_db_status
  check "hygiene-cron" hygiene_cron_status
  check "rendered units" rendered_units_status
  return "$result"
}

if "$DRY_RUN"; then
  print_plan
  exit 0
fi
if "$VERIFY_SOURCE"; then
  verify
  exit $?
fi

ensure_prerequisites() {
  local missing=() command_name
  # BOOTSTRAP_TEST_EUID is a test-only override: bootstrap.test.sh runs as
  # root on CI/dev boxes, which would otherwise make the "neither root nor
  # sudo" branch below unreachable and untestable without a privilege drop.
  # It defaults to the real $EUID (read-only, so it cannot be reassigned
  # directly) and is never read outside this function.
  local effective_euid="${BOOTSTRAP_TEST_EUID:-$EUID}"
  local -A packages=(
    [git]=git
    [curl]=curl
    [tmux]=tmux
    [flock]=util-linux
    [findmnt]=util-linux
    [envsubst]=gettext-base
    [crontab]=cron
    # Review round 2, defect 2: dropped on the UNVERIFIED reasoning that it
    # was only needed by out-of-scope render_units/install_hygiene_cron.
    # install_bun (in scope) calls the real bun.sh/install, which hard-fails
    # with `error 'unzip is required to install bun'` and uses it to unpack
    # the release archive -- on exactly the clean-machine case this row
    # targets ($BUN_BIN absent). xz stays dropped; it is unused here.
    [unzip]=unzip
  )
  for command_name in "${!packages[@]}"; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("${packages[$command_name]}")
  done
  if ((${#missing[@]})); then
    if ((effective_euid == 0)); then
      apt-get update
      apt-get install -y "${missing[@]}"
    elif command -v sudo >/dev/null 2>&1; then
      sudo apt-get update
      sudo apt-get install -y "${missing[@]}"
    else
      echo "ERROR: missing prerequisites (${missing[*]}) and neither root nor sudo is available" >&2
      exit 1
    fi
  fi
}

install_bun() {
  local bun_directory
  if [[ ! -x "$BUN_BIN" ]]; then
    BUN_INSTALL="$HOME/.bun" curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
  fi
  "$BUN_BIN" --version >/dev/null
  bun_directory="$(dirname "$BUN_BIN")"
  export PATH="$bun_directory:$PATH"
}

repository_url() {
  if [[ -n "${REPO_URL:-}" ]]; then
    printf '%s\n' "$REPO_URL"
    return
  fi
  git -C "$SOURCE_ROOT" remote get-url origin
}

sync_repository() {
  local repo_url expected_branch="${REPO_BRANCH:-main}" current_branch
  repo_url="$(repository_url)"
  if [[ -d "$INSTALL_ROOT/.git" ]]; then
    # Review round 2, defect 1: fetch/pull fast-forward whatever branch
    # happens to be checked out to ITS OWN upstream -- they never look at
    # which branch that is. On a checkout sitting on the wrong line (this
    # host, right now: v2-deprecated, on purpose, while origin/main is v3 --
    # instance/v3-becomes-main-2026-08-03.md) that silently reports success
    # while leaving the host exactly where it started. Refuse before any
    # fetch or pull; do NOT silently check out the target -- switching the
    # branch under a running daemon is a human decision, not this script's.
    current_branch="$(git -C "$INSTALL_ROOT" rev-parse --abbrev-ref HEAD)"
    if [[ "$current_branch" != "$expected_branch" ]]; then
      echo "ERROR: INSTALL_ROOT is on branch '$current_branch', expected '$expected_branch' ($INSTALL_ROOT); refusing to fetch/pull a mismatched branch" >&2
      exit 1
    fi
    git -C "$INSTALL_ROOT" fetch --prune origin
    git -C "$INSTALL_ROOT" pull --ff-only
  elif [[ -e "$INSTALL_ROOT" ]]; then
    echo "ERROR: INSTALL_ROOT exists but is not a git checkout: $INSTALL_ROOT" >&2
    exit 1
  else
    git clone --branch "$expected_branch" "$repo_url" "$INSTALL_ROOT"
  fi
}

render_environment() {
  if [[ -L "$ENV_FILE" ]]; then
    echo "ERROR: environment file must not be a symlink: $ENV_FILE" >&2
    return 1
  fi
  if [[ ! -e "$ENV_FILE" ]]; then
    install -d -m 700 "$(dirname "$ENV_FILE")"
    install -m 600 "$SOURCE_ROOT/bootstrap/env.template" "$ENV_FILE"
  elif [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: environment file is not a regular file: $ENV_FILE" >&2
    return 1
  fi
  chmod 600 "$ENV_FILE"
}

initialize_state_db() {
  install -d -m 700 "$RUNTIME_DIR"
  INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$INSTALL_ROOT/core/mission-cli.ts" status
}

install_hygiene_cron() {
  CRONTAB_CMD="$CRONTAB_CMD" "$INSTALL_ROOT/hygiene/install-cron.sh"
}

run_install_test_gate() {
  echo 'INSTALL GATE: repository tests'
  # A clean rebuild may clone through a local transport while tests exercise
  # tracked-remote policy. Pin the canonical test subject explicitly, then keep
  # installer configuration from leaking into repository test fixtures.
  if [[ -n "${TEST_GATE_ORIGIN_URL:-}" ]]; then
    git -C "$INSTALL_ROOT" remote set-url origin "$TEST_GATE_ORIGIN_URL"
  fi
  (cd "$INSTALL_ROOT" && env -u BUN_BIN -u TMPDIR -u INSTALL_ROOT -u REPO_URL \
    -u REPO_BRANCH -u TEST_GATE_ORIGIN_URL "$BUN_BIN" test)
  echo 'INSTALL GATE: PASS full sweep'
}

render_units() {
  local effective_euid="${BOOTSTRAP_TEST_EUID:-$EUID}"
  local unit source extra template_dir template staged backup_dir count=0 publication_rc=0
  local -a units=() templates=()
  local -A manifest_units=()
  local -A destination_existed=()
  ((effective_euid == 0)) || { echo 'ERROR: system unit rendering requires root' >&2; return 1; }
  if [[ ! -f "$EXPECTED_UNITS_FILE" || ! -r "$EXPECTED_UNITS_FILE" ]]; then
    echo "ERROR: expected-units manifest is missing or unreadable: $EXPECTED_UNITS_FILE" >&2
    return 1
  fi
  command -v envsubst >/dev/null 2>&1 || { echo 'ERROR: envsubst is required to render units' >&2; return 1; }
  unit_render_require_env || { echo 'ERROR: unit render environment is incomplete' >&2; return 1; }

  # Preflight the complete manifest before creating the destination or writing
  # a single unit. In particular, pin the four units independently named by
  # the 2026-08-01 incident regression lock in check-unit-drift.test.ts: a
  # truncated manifest must not redefine a smaller fleet as complete.
  while IFS=$'\t' read -r unit source extra || [[ -n "${unit:-}" ]]; do
    [[ -z "$unit" || "$unit" == \#* ]] && continue
    if [[ -n "${extra:-}" || ( "$unit" != *.service && "$unit" != *.timer ) ]]; then
      echo "ERROR: invalid expected-units entry: $unit" >&2
      return 1
    fi
    case "$source" in
      generic) template_dir="$INSTALL_ROOT/bootstrap/units" ;;
      instance) template_dir="$INSTALL_ROOT/instance/units" ;;
      *) echo "ERROR: invalid expected-units source for $unit: $source" >&2; return 1 ;;
    esac
    template="$template_dir/$unit.in"
    if [[ ! -f "$template" || ! -r "$template" ]]; then
      echo "ERROR: expected unit template is missing or unreadable: $template" >&2
      return 1
    fi
    if [[ -n "${manifest_units[$unit]+x}" ]]; then
      echo "ERROR: duplicate expected-units entry: $unit" >&2
      return 1
    fi
    manifest_units["$unit"]=1
    units+=("$unit")
    templates+=("$template")
    ((count += 1))
  done < "$EXPECTED_UNITS_FILE"
  if ((count == 0)); then
    echo "ERROR: expected-units manifest is empty: $EXPECTED_UNITS_FILE" >&2
    return 1
  fi
  for unit in bpa-orchestrator.service bpa-orchestrator-watchdog.service \
    bpa-orchestrator-watchdog.timer bpa-telegram-daemon.service; do
    if [[ -z "${manifest_units[$unit]+x}" ]]; then
      echo "ERROR: required incident unit is missing from expected-units manifest: $unit" >&2
      return 1
    fi
  done

  # Render the whole set away from the destination. A malformed template or
  # envsubst failure therefore cannot leave a half-rendered deployed set.
  #
  # unit_render_template is the SAME function bootstrap/check-unit-drift.sh
  # calls, with the same variable list from unit-render-lib.sh, so what is
  # deployed here and what the drift checker validates cannot diverge. It also
  # refuses its own output when a key lost its value or a `$` survived, which
  # is the check that was missing when `OnCalendar=` shipped disarmed.
  staged="$(mktemp -d "${TMPDIR:-/tmp}/bpa-render-units.XXXXXX")"
  trap 'rm -rf "$staged"' RETURN
  for ((count = 0; count < ${#units[@]}; count += 1)); do
    if ! unit_render_template "${templates[$count]}" "$staged/${units[$count]}" "${units[$count]}"; then
      echo "ERROR: unit render rejected: ${units[$count]} (nothing installed)" >&2
      return 1
    fi
    chmod 644 "$staged/${units[$count]}"
  done

  # systemd's own parser, on the staged set, before the destination directory
  # is touched. Weaker than the assertions above -- it exits 0 on an
  # unparsable timer value -- so it is an addition to them, never a substitute.
  if ! unit_render_verify_staged "$staged"; then
    echo 'ERROR: systemd-analyze rejected the staged units (nothing installed)' >&2
    return 1
  fi

  install -d -m 755 "$SYSTEMD_SYSTEM_DIR"
  backup_dir="$staged/prior"
  install -d -m 700 "$backup_dir"
  for unit in "${units[@]}"; do
    if [[ -e "$SYSTEMD_SYSTEM_DIR/$unit" || -L "$SYSTEMD_SYSTEM_DIR/$unit" ]]; then
      if [[ ! -f "$SYSTEMD_SYSTEM_DIR/$unit" || -L "$SYSTEMD_SYSTEM_DIR/$unit" ]]; then
        echo "ERROR: unit destination is not a regular file: $SYSTEMD_SYSTEM_DIR/$unit" >&2
        return 1
      fi
      cp -p -- "$SYSTEMD_SYSTEM_DIR/$unit" "$backup_dir/$unit"
      destination_existed["$unit"]=1
    else
      destination_existed["$unit"]=0
    fi
  done

  rollback_unit_publication() {
    local rollback_unit rollback_failed=0 rollback_operation_pid rollback_operation_rc
    for rollback_unit in "${units[@]}"; do
      if [[ "${destination_existed[$rollback_unit]}" == 1 ]]; then
        timeout --kill-after="${UNIT_ROLLBACK_KILL_AFTER_SECONDS:-1}" \
          "${UNIT_ROLLBACK_TIMEOUT_SECONDS:-5}" \
          env BPA_UNIT_ROLLBACK=1 \
          cp -p -- "$backup_dir/$rollback_unit" "$SYSTEMD_SYSTEM_DIR/$rollback_unit" &
      else
        timeout --kill-after="${UNIT_ROLLBACK_KILL_AFTER_SECONDS:-1}" \
          "${UNIT_ROLLBACK_TIMEOUT_SECONDS:-5}" \
          env BPA_UNIT_ROLLBACK=1 \
          rm -f -- "$SYSTEMD_SYSTEM_DIR/$rollback_unit" &
      fi
      rollback_operation_pid=$!
      while :; do
        if wait "$rollback_operation_pid"; then
          rollback_operation_rc=0
          break
        else
          rollback_operation_rc=$?
        fi
        # A trapped operator signal interrupts wait without ending its child.
        # Keep supervising until timeout has reaped the operation.
        if kill -0 "$rollback_operation_pid" 2>/dev/null; then
          continue
        fi
        break
      done
      if ((rollback_operation_rc != 0)); then
        rollback_failed=1
      fi
    done
    if ((rollback_failed != 0)); then
      echo 'verdict=rollback-failed: unit publication prior state could not be restored' >&2
      return 1
    fi
    echo 'verdict=rolled-back: unit publication prior state restored' >&2
  }

  unit_rollback_signal() {
    echo "ERROR: termination requested by $1 while bounded unit rollback is in progress" >&2
  }

  unit_publication_signal() {
    local signal_name="$1" signal_rc="$2"
    # Rollback is the terminal state transition. Record further termination
    # requests while the individually bounded restore operations finish and
    # emit their single truthful verdict.
    trap 'unit_rollback_signal HUP' HUP
    trap 'unit_rollback_signal INT' INT
    trap 'unit_rollback_signal TERM' TERM
    if ! rollback_unit_publication; then
      rm -rf "$staged"
      trap - RETURN
      trap - HUP INT TERM
      return 125
    fi
    rm -rf "$staged"
    trap - RETURN
    echo "ERROR: unit publication interrupted by $signal_name" >&2
    trap - HUP INT TERM
    return "$signal_rc"
  }

  trap 'unit_publication_signal HUP 129; return $?' HUP
  trap 'unit_publication_signal INT 130; return $?' INT
  trap 'unit_publication_signal TERM 143; return $?' TERM
  for unit in "${units[@]}"; do
    if ! mv -f "$staged/$unit" "$SYSTEMD_SYSTEM_DIR/$unit"; then
      publication_rc=$?
      trap 'unit_rollback_signal HUP' HUP
      trap 'unit_rollback_signal INT' INT
      trap 'unit_rollback_signal TERM' TERM
      # `!` normalizes `$?`; preserve a stable non-zero publication verdict.
      ((publication_rc != 0)) || publication_rc=1
      if ! rollback_unit_publication; then
        trap - HUP INT TERM
        return 125
      fi
      trap - HUP INT TERM
      return "$publication_rc"
    fi
  done
  trap - HUP INT TERM
  rm -rf "$staged"
  trap - RETURN
}

if [[ "${BOOTSTRAP_LIB_ONLY:-false}" != true ]]; then
  ensure_prerequisites
  install_bun
  sync_repository
  render_environment
  initialize_state_db
  install_hygiene_cron
  run_install_test_gate
  render_units
  echo "Bootstrap stage 2 completed: prerequisites, Bun, repository, environment, state database, hygiene cron, test gate, and unit rendering."
  echo "Remaining before a full install: unit activation and the watchdog arm/disarm pair (later rows)."
fi
