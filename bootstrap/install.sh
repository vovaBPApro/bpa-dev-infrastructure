#!/usr/bin/env bash
# Install or refresh the BPA development infrastructure for the current user.
# Secrets are never accepted on the command line; edit INSTALL_ROOT/.env locally.
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.2.20}"
INSTALL_ROOT="${INSTALL_ROOT:-/home/bpa-dev-infrastructure}"
DRY_RUN=false
VERIFY=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$INSTALL_ROOT/.env}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"

usage() {
  cat <<'EOF'
Usage: bootstrap/install.sh [--dry-run | --verify]

Environment overrides: INSTALL_ROOT, REPO_URL, BUN_VERSION, ENV_FILE, BUN_BIN.
The Telegram token is never accepted as an argument. Paste it into .env locally.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --verify) VERIFY=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if "$DRY_RUN" && "$VERIFY"; then
  echo "ERROR: --dry-run and --verify cannot be combined" >&2
  exit 2
fi

plan() { printf 'PLAN %-12s %s\n' "$1" "$2"; }

systemd_user_available() {
  command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1
}

print_plan() {
  plan "apt" "check git, curl, tmux, envsubst, unzip, and xz; install missing Ubuntu packages"
  plan "bun" "install Bun ${BUN_VERSION} if $BUN_BIN is absent"
  plan "repository" "clone or fast-forward update $INSTALL_ROOT from REPO_URL"
  plan "environment" "create $ENV_FILE from bootstrap/env.template if absent (operator edits token locally)"
  plan "units" "render daemon and watchdog systemd --user units in $SYSTEMD_USER_DIR"
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
  if has_configured_token; then
    check "token configured" true
  else
    skip "token configured" "token placeholder remains"
  fi
  check "daemon unit" test -f "$SYSTEMD_USER_DIR/bpa-telegram-daemon.service"
  check "watchdog service" test -f "$SYSTEMD_USER_DIR/bpa-orchestrator-watchdog.service"
  check "watchdog timer" test -f "$SYSTEMD_USER_DIR/bpa-orchestrator-watchdog.timer"
  if ! systemd_user_available; then
    skip "user systemd" "no user-systemd session"
    skip "daemon enabled" "user-systemd unavailable"
    skip "watchdog enabled" "user-systemd unavailable"
  elif ! has_configured_token; then
    skip "daemon enabled" "token placeholder remains"
    skip "watchdog enabled" "token placeholder remains"
  else
    check "daemon enabled" systemctl --user is-enabled --quiet bpa-telegram-daemon.service
    check "watchdog enabled" systemctl --user is-enabled --quiet bpa-orchestrator-watchdog.timer
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
  if [[ ! -x "$BUN_BIN" ]]; then
    BUN_INSTALL="$HOME/.bun" curl -fsSL https://bun.sh/install | bash -s "bun-v$BUN_VERSION"
  fi
  "$BUN_BIN" --version >/dev/null
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
  if [[ ! -e "$ENV_FILE" ]]; then
    install -d -m 700 "$(dirname "$ENV_FILE")"
    install -m 600 "$SOURCE_ROOT/bootstrap/env.template" "$ENV_FILE"
  fi
}

render_units() {
  install -d -m 700 "$SYSTEMD_USER_DIR"
  local source destination
  for source in "$SOURCE_ROOT"/bootstrap/units/*.in; do
    destination="$SYSTEMD_USER_DIR/$(basename "${source%.in}")"
    INSTALL_ROOT="$INSTALL_ROOT" ENV_FILE="$ENV_FILE" BUN_BIN="$BUN_BIN" envsubst < "$source" > "$destination"
    chmod 600 "$destination"
  done
  if systemd_user_available; then
    systemctl --user daemon-reload
  else
    echo "User systemd is unavailable; units were rendered only. On a VM with a user session, run:"
    echo "  systemctl --user daemon-reload"
    echo "  systemctl --user enable --now bpa-telegram-daemon.service bpa-orchestrator-watchdog.timer"
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
  else
    echo "Token remains a placeholder; units installed but not enabled. Edit $ENV_FILE, then re-run this installer."
  fi
}

ensure_prerequisites
install_bun
sync_repository
render_environment
render_units
activate_units
echo "Bootstrap completed. Run '$SCRIPT_DIR/install.sh --verify' after configuring the local token."
