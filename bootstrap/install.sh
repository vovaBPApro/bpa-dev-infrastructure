#!/usr/bin/env bash
# Install or refresh the BPA development infrastructure for the current user.
# Secrets are never accepted on the command line; edit INSTALL_ROOT/.env locally.
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.14}"
INSTALL_ROOT="${INSTALL_ROOT:-/home/bpa-dev-infrastructure}"
DRY_RUN=false
VERIFY=false
NO_CRON=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$INSTALL_ROOT/.env}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"
RUNTIME_DIR="${RUNTIME_DIR:-$INSTALL_ROOT/runtime}"
STATE_DB="${INFRA_STATE_DB:-$RUNTIME_DIR/state.db}"
CRONTAB_CMD="${CRONTAB_CMD:-crontab}"
HYGIENE_CRON_SKIP_FILE="$RUNTIME_DIR/hygiene-cron.skip"
FULL_SUITE_ON_CALENDAR="${FULL_SUITE_ON_CALENDAR:-}"

usage() {
  cat <<'EOF'
Usage: bootstrap/install.sh [--dry-run | --verify] [--no-cron]

Environment overrides: INSTALL_ROOT, REPO_URL, BUN_VERSION, ENV_FILE, BUN_BIN,
RUNTIME_DIR, INFRA_STATE_DB, and CRONTAB_CMD.
The Telegram token is never accepted as an argument. Paste it into .env locally.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --verify) VERIFY=true ;;
    --no-cron) NO_CRON=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if "$DRY_RUN" && { "$VERIFY" || "$NO_CRON"; }; then
  echo "ERROR: --dry-run cannot be combined with --verify or --no-cron" >&2
  exit 2
fi

if "$VERIFY" && "$NO_CRON"; then
  echo "ERROR: --verify and --no-cron cannot be combined" >&2
  exit 2
fi

plan() { printf 'PLAN %-12s %s\n' "$1" "$2"; }

systemd_user_available() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

print_plan() {
  plan "apt" "check git, curl, tmux, envsubst, unzip, and xz; install cron unless --no-cron is set"
  plan "bun" "install Bun ${BUN_VERSION} if $BUN_BIN is absent"
  plan "repository" "clone or fast-forward update $INSTALL_ROOT from REPO_URL"
  plan "environment" "create $ENV_FILE from bootstrap/env.template if absent, reject symlinks, and enforce mode 0600"
  plan "state-db" "initialize $STATE_DB with core/mission-cli.ts status"
  plan "workspace" "make workspace/workspace.sh sync capability available"
  plan "hygiene" "install hygiene cron unless --no-cron is set"
  plan "test-gate" "run the full daemon, core, gate, stand, and workspace test sweep"
  plan "units" "render daemon, watchdog, full-suite, and morning-report systemd --user units in $SYSTEMD_USER_DIR"
  plan "activate" "reload user systemd and enable units when available; otherwise print VM activation instructions"
}

if "$DRY_RUN"; then
  print_plan
  exit 0
fi

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

skip() {
  printf 'SKIP %-24s %s\n' "$1" "$2"
}

has_configured_token() {
  [[ -f "$ENV_FILE" ]] && ! grep -q '^TELEGRAM_BOT_TOKEN=__OPERATOR_' "$ENV_FILE"
}

state_db_status() {
  INFRA_STATE_DB="$STATE_DB" "$BUN_BIN" "$INSTALL_ROOT/core/mission-cli.ts" status >/dev/null
}

workspace_status() {
  "$INSTALL_ROOT/workspace/workspace.sh" ls >/dev/null
}

hygiene_cron_status() {
  "$CRONTAB_CMD" -l 2>/dev/null | grep -Fxq '# BEGIN bpa-dev-infrastructure hygiene'
}

linger_enabled() {
  loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -Fxq 'Linger=yes'
}

gate_status() {
  "$BUN_BIN" "$INSTALL_ROOT/gate/completion-guard.ts" --help >/dev/null
}

rendered_unit_exec_paths_status() {
  local unit line command exec_path
  local -a units=("$SYSTEMD_USER_DIR"/*.service "$SYSTEMD_USER_DIR"/*.timer)

  for unit in "${units[@]}"; do
    [[ -f "$unit" ]] || continue
    while IFS= read -r line; do
      [[ "$line" == Exec*=* ]] || continue
      command="${line#*=}"
      while [[ "$command" == [@!+:-]* ]]; do
        command="${command:1}"
      done
      read -r exec_path _ <<<"$command"
      [[ "$exec_path" == /* && -x "$exec_path" ]] || return 1
      if [[ "$exec_path" != "$BUN_BIN" && "$exec_path" != "$INSTALL_ROOT"/* ]]; then
        return 1
      fi
    done < "$unit"
  done
}

verify() {
  printf '%-6s %-24s\n' 'STATUS' 'CHECK'
  printf '%-6s %-24s\n' '------' '------------------------'
  check "git" command -v git
  check "curl" command -v curl
  check "tmux" command -v tmux
  check "bun" test -x "$BUN_BIN"
  check "repository" test -d "$INSTALL_ROOT/.git"
  check "environment file" test -f "$ENV_FILE"
  check "environment permissions" test "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)" = 600
  if command -v loginctl >/dev/null 2>&1; then
    check "linger" linger_enabled
  else
    skip "linger" "loginctl command unavailable"
  fi
  check "state-db" state_db_status
  check "workspace" workspace_status
  if [[ -f "$HYGIENE_CRON_SKIP_FILE" ]]; then
    skip "hygiene-cron" "$(<"$HYGIENE_CRON_SKIP_FILE")"
  elif ! command -v "$CRONTAB_CMD" >/dev/null 2>&1; then
    skip "hygiene-cron" "crontab command unavailable"
  else
    check "hygiene-cron" hygiene_cron_status
  fi
  check "gate" gate_status
  if command -v docker >/dev/null 2>&1; then
    check "stand" docker --version
  else
    skip "stand" "docker command unavailable"
  fi
  if has_configured_token; then
    check "token configured" true
  else
    skip "token configured" "token placeholder remains"
  fi
  check "daemon unit" test -f "$SYSTEMD_USER_DIR/bpa-telegram-daemon.service"
  check "watchdog service" test -f "$SYSTEMD_USER_DIR/bpa-orchestrator-watchdog.service"
  check "watchdog timer" test -f "$SYSTEMD_USER_DIR/bpa-orchestrator-watchdog.timer"
  check "full-suite service" test -f "$SYSTEMD_USER_DIR/bpa-full-suite.service"
  check "full-suite timer" test -f "$SYSTEMD_USER_DIR/bpa-full-suite.timer"
  check "morning service" test -f "$SYSTEMD_USER_DIR/orch-morning-report.service"
  check "morning timer" test -f "$SYSTEMD_USER_DIR/orch-morning-report.timer"
  check "unit Exec paths" rendered_unit_exec_paths_status
  if ! systemd_user_available; then
    skip "user systemd" "no user-systemd session"
    skip "daemon enabled" "user-systemd unavailable"
    skip "watchdog enabled" "user-systemd unavailable"
    skip "full-suite enabled" "user-systemd unavailable"
    skip "morning enabled" "user-systemd unavailable"
  elif ! has_configured_token; then
    skip "daemon enabled" "token placeholder remains"
    skip "watchdog enabled" "token placeholder remains"
  else
    check "daemon enabled" systemctl --user is-enabled --quiet bpa-telegram-daemon.service
    check "watchdog enabled" systemctl --user is-enabled --quiet bpa-orchestrator-watchdog.timer
    check "full-suite enabled" systemctl --user is-enabled --quiet bpa-full-suite.timer
    check "morning enabled" systemctl --user is-enabled --quiet orch-morning-report.timer
  fi
  return "$result"
}

if "$VERIFY"; then
  verify
  exit $?
fi

ensure_prerequisites() {
  local missing=() command_name
  local -A packages=(
    [git]=git
    [curl]=curl
    [tmux]=tmux
    [envsubst]=gettext-base
    [unzip]=unzip
    [xz]=xz-utils
  )
  for command_name in "${!packages[@]}"; do
    command -v "$command_name" >/dev/null 2>&1 || missing+=("${packages[$command_name]}")
  done
  if ! "$NO_CRON" && ! command -v crontab >/dev/null 2>&1; then
    missing+=(cron)
  fi
  if ((${#missing[@]})); then
    if ((EUID == 0)); then
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
  local repo_url
  repo_url="$(repository_url)"
  if [[ -d "$INSTALL_ROOT/.git" ]]; then
    git -C "$INSTALL_ROOT" fetch --prune origin
    git -C "$INSTALL_ROOT" pull --ff-only
  elif [[ -e "$INSTALL_ROOT" ]]; then
    echo "ERROR: INSTALL_ROOT exists but is not a git checkout: $INSTALL_ROOT" >&2
    exit 1
  else
    git clone "$repo_url" "$INSTALL_ROOT"
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
  if "$NO_CRON"; then
    install -d -m 700 "$RUNTIME_DIR"
    printf '%s\n' 'disabled by --no-cron' > "$HYGIENE_CRON_SKIP_FILE"
    chmod 600 "$HYGIENE_CRON_SKIP_FILE"
    echo 'Hygiene cron skipped: --no-cron.'
    return
  fi
  rm -f "$HYGIENE_CRON_SKIP_FILE"
  CRONTAB_CMD="$CRONTAB_CMD" "$INSTALL_ROOT/hygiene/install-cron.sh"
}

run_install_test_gate() {
  echo 'INSTALL GATE: installing daemon dependencies'
  (
    cd "$INSTALL_ROOT/daemon"
    "$BUN_BIN" install --frozen-lockfile
  )
  echo 'INSTALL GATE: daemon tests'
  (cd "$INSTALL_ROOT/daemon" && "$BUN_BIN" test)
  echo 'INSTALL GATE: core tests'
  (cd "$INSTALL_ROOT" && "$BUN_BIN" test core/state.test.ts core/mission-cli.test.ts)
  echo 'INSTALL GATE: gate tests'
  (cd "$INSTALL_ROOT" && "$BUN_BIN" test gate/completion-guard.test.ts)
  echo 'INSTALL GATE: stand tests'
  (cd "$INSTALL_ROOT" && "$BUN_BIN" test stand/matrix.test.ts stand/stand.test.ts)
  echo 'INSTALL GATE: workspace tests'
  (cd "$INSTALL_ROOT" && bash workspace/workspace.test.sh)
  echo 'INSTALL GATE: PASS full sweep'
}

render_units() {
  install -d -m 700 "$SYSTEMD_USER_DIR"
  local source destination configured_calendar configured_interval
  if [[ -z "$FULL_SUITE_ON_CALENDAR" && -f "$ENV_FILE" ]]; then
    configured_calendar="$(sed -n 's/^FULL_SUITE_ON_CALENDAR=//p' "$ENV_FILE" | tail -n 1)"
    [[ -n "$configured_calendar" ]] && FULL_SUITE_ON_CALENDAR="$configured_calendar"
  fi
  FULL_SUITE_ON_CALENDAR="${FULL_SUITE_ON_CALENDAR:-*-*-* 03:30:00}"
  # The watchdog cadence has to come from the SAME knob watchdog.sh reads, or the
  # installed timer and the tick's own lease-fence arithmetic describe different
  # intervals. Before this, the timer carried a hard-coded 10min while .env
  # carried a name nothing read and watchdog.sh assumed 60s — three numbers, no
  # agreement. The deprecated ORCH_WATCHDOG_INTERVAL_SECONDS spelling is still
  # honoured here so an .env written by the old template keeps working.
  if [[ -z "${ORCH_WATCHDOG_INTERVAL:-}" && -f "$ENV_FILE" ]]; then
    configured_interval="$(sed -n 's/^ORCH_WATCHDOG_INTERVAL=//p' "$ENV_FILE" | tail -n 1)"
    [[ -z "$configured_interval" ]] &&
      configured_interval="$(sed -n 's/^ORCH_WATCHDOG_INTERVAL_SECONDS=//p' "$ENV_FILE" | tail -n 1)"
    [[ -n "$configured_interval" ]] && ORCH_WATCHDOG_INTERVAL="$configured_interval"
  fi
  ORCH_WATCHDOG_INTERVAL="${ORCH_WATCHDOG_INTERVAL:-60}"
  # Same central bounded parser the tick (watchdog.sh) and the user-timer
  # installer (install-watchdog.sh) use: the value is rendered into a systemd
  # unit verbatim, so empty/non-numeric/newline-carrying/out-of-range values
  # must fail BEFORE any unit file is written. The reason is printed instead of
  # the raw value so a hostile value cannot reach the terminal.
  # shellcheck disable=SC1091
  source "$SOURCE_ROOT/orchestrator/knobs.sh"
  if ! knob_check "$ORCH_WATCHDOG_INTERVAL" 10 86400; then
    echo "ERROR: invalid ORCH_WATCHDOG_INTERVAL (reason=$KNOB_REASON, allowed=10..86400 integer seconds); refusing to render units" >&2
    return 1
  fi
  for source in "$SOURCE_ROOT"/bootstrap/units/*.in; do
    destination="$SYSTEMD_USER_DIR/$(basename "${source%.in}")"
    INSTALL_ROOT="$INSTALL_ROOT" ENV_FILE="$ENV_FILE" BUN_BIN="$BUN_BIN" \
      FULL_SUITE_ON_CALENDAR="$FULL_SUITE_ON_CALENDAR" ORCH_WATCHDOG_INTERVAL="$ORCH_WATCHDOG_INTERVAL" \
      envsubst < "$source" > "$destination"
    chmod 600 "$destination"
  done
  if systemd_user_available; then
    systemctl --user daemon-reload
  else
    echo "User systemd is unavailable; units were rendered only. On a VM with a user session, run:"
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable --now bpa-telegram-daemon.service bpa-orchestrator-watchdog.timer bpa-full-suite.timer orch-morning-report.timer"
  fi
}

activate_units() {
  if ! systemd_user_available; then
    echo "Activation skipped: no user-systemd session is available."
    return
  fi
  if has_configured_token; then
    systemctl --user enable --now bpa-telegram-daemon.service
    systemctl --user enable --now bpa-orchestrator-watchdog.timer
    systemctl --user enable --now bpa-full-suite.timer
    systemctl --user enable --now orch-morning-report.timer
  else
    echo "Token remains a placeholder; units installed but not enabled. Edit $ENV_FILE, then re-run this installer."
  fi
}

warn_if_linger_disabled() {
  if command -v loginctl >/dev/null 2>&1 && ! linger_enabled; then
    echo "WARNING: user lingering is disabled; user-systemd automation will stop after logout or reboot." >&2
    echo "WARNING: enable it with: loginctl enable-linger $USER" >&2
  fi
}

if [[ "${BOOTSTRAP_LIB_ONLY:-false}" != true ]]; then
  ensure_prerequisites
  install_bun
  sync_repository
  render_environment
  warn_if_linger_disabled
  initialize_state_db
  install_hygiene_cron
  run_install_test_gate
  render_units
  activate_units
  echo "Bootstrap completed. Run '$SCRIPT_DIR/install.sh --verify' after configuring the local token."
fi
