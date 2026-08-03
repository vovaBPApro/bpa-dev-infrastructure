#!/usr/bin/env bash
# Install or refresh the BPA development infrastructure checkout as the root
# system account -- STAGE 1 ONLY.
#
# Ported from v2-deprecated (bootstrap/install.sh, 598 lines, ten stages) for
# workboard row S2-3 / V3-1.1. This file carries exactly five of the donor's
# functions: ensure_prerequisites, install_bun, sync_repository,
# render_environment, initialize_state_db. Everything else the donor did --
# the daemon/core/gate/stand test gate, hygiene cron install, systemd unit
# rendering, and unit activation including the watchdog arm/disarm pair -- is
# explicitly NOT here. activate_units in particular runs
# `systemctl enable --now bpa-orchestrator.service`, which would restart the
# live orchestrator on this host; HR-1720 defers all host deployment, and that
# hazard is exactly what stage 1 stays clear of. Later rows add the rest.
#
# workspace_status (donor) is dropped outright: v3 has no workspace/ tree.
# telegram-transport-preflight.sh is not sourced: every donor check that used
# it (token-gated verify rows, activate_units' watchdog arm) belongs to a
# later stage.
#
# Modes: --dry-run (print the stage-1 plan and exit) and --verify-source
# (check only boundaries a source/container test can prove, no live host
# required). There is no --verify yet -- the donor's --verify checks systemd
# unit state and Docker/codex/claude/whisper tooling this row does not touch.
#
# Secrets are never accepted on the command line; edit ENV_FILE locally.
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.14}"
INSTALL_ROOT="${INSTALL_ROOT:-/srv/bpa-dev-infrastructure}"
DRY_RUN=false
VERIFY_SOURCE=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LANE_RUNTIME_CONFIG="${LANE_RUNTIME_CONFIG:-$SOURCE_ROOT/instance/lane-runtime.conf}"
runtime_value() {
  local key="$1" value
  value="$(sed -n "s/^${key}=//p" "$LANE_RUNTIME_CONFIG")"
  [[ -n "$value" && "$(printf '%s\n' "$value" | wc -l)" -eq 1 ]] || {
    echo "ERROR: missing or duplicate $key in $LANE_RUNTIME_CONFIG" >&2
    exit 1
  }
  printf '%s\n' "$value"
}
LANE_USER="$(runtime_value lane_user)"
LANE_GROUP="$(runtime_value lane_group)"
LANE_HOME="$(runtime_value lane_home)"
LANES_DIR="$(runtime_value lanes_dir)"
ENV_FILE="${ENV_FILE:-/root/.config/bpa/orchestrator.env}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
RUNTIME_DIR="${RUNTIME_DIR:-$INSTALL_ROOT/runtime}"
STATE_DB="${INFRA_STATE_DB:-$RUNTIME_DIR/state.db}"

usage() {
  cat <<'EOF'
Usage: bootstrap/install.sh [--dry-run | --verify-source]

Stage 1 only: prerequisites, Bun, repository sync, the environment file, and
the durable state database. Later rows add the daemon/core/gate/stand test
gate, hygiene cron, systemd unit rendering and activation, and the watchdog
arm/disarm pair -- none of that runs from this script yet.

Environment overrides: INSTALL_ROOT, REPO_URL, REPO_BRANCH (default: main),
BUN_VERSION, ENV_FILE, BUN_BIN, RUNTIME_DIR, INFRA_STATE_DB.
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
  plan "lane-user" "create the locked $LANE_USER system account with private home $LANE_HOME and $LANES_DIR"
  plan "apt" "check git, curl, tmux, flock, findmnt, and unzip; install any missing packages"
  plan "bun" "install Bun ${BUN_VERSION} if $BUN_BIN is absent"
  plan "repository" "clone \$INSTALL_ROOT from REPO_URL on REPO_BRANCH, or fast-forward it -- refusing if it is checked out on any other branch"
  plan "environment" "create $ENV_FILE from bootstrap/env.template if absent, reject symlinks, and enforce mode 0600"
  plan "state-db" "initialize $STATE_DB with core/mission-cli.ts status"
}

ensure_lane_user() {
  if ! getent group "$LANE_GROUP" >/dev/null; then
    groupadd --system "$LANE_GROUP"
  fi
  if ! id "$LANE_USER" >/dev/null 2>&1; then
    useradd --system --gid "$LANE_GROUP" --home-dir "$LANE_HOME" --create-home --shell /usr/sbin/nologin "$LANE_USER"
  fi
  install -d -o "$LANE_USER" -g "$LANE_GROUP" -m 0700 "$LANE_HOME" "$LANES_DIR"
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

# Fail-closed by construction: every row is an explicit named check against a
# real predicate (command presence, file mode, a real mission-cli invocation).
# There is no directory-enumeration step here to blind-spot an absent item --
# that failure class (a checker that only sees what a glob finds) belongs to
# bootstrap/check-unit-drift.sh, not to this stage.
verify_source() {
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
  return "$result"
}

if "$DRY_RUN"; then
  print_plan
  exit 0
fi
if "$VERIFY_SOURCE"; then
  verify_source
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
    # Review round 2, defect 2: dropped on the UNVERIFIED reasoning that it
    # was only needed by out-of-scope render_units/install_hygiene_cron.
    # install_bun (in scope) calls the real bun.sh/install, which hard-fails
    # with `error 'unzip is required to install bun'` and uses it to unpack
    # the release archive -- on exactly the clean-machine case this row
    # targets ($BUN_BIN absent). envsubst/xz/cron stay dropped; they are
    # genuinely unused by any in-scope function.
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

if [[ "${BOOTSTRAP_LIB_ONLY:-false}" != true ]]; then
  ensure_prerequisites
  ensure_lane_user
  install_bun
  sync_repository
  render_environment
  initialize_state_db
  echo "Bootstrap stage 1 completed: prerequisites, Bun, repository, environment file, and state database."
  echo "Remaining before a full install: hygiene cron, the daemon/core/gate/stand test gate, systemd unit rendering and activation, and the watchdog arm/disarm pair (later rows)."
fi
