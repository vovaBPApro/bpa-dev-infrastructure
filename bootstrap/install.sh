#!/usr/bin/env bash
# Install or refresh the BPA development infrastructure as the root system account.
# Secrets are never accepted on the command line; edit INSTALL_ROOT/.env locally.
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.3.14}"
INSTALL_ROOT="${INSTALL_ROOT:-/root/bpa-dev-infrastructure}"
DRY_RUN=false
VERIFY=false
VERIFY_SOURCE=false
NO_CRON=false
ARM_WATCHDOG=false
DISARM_WATCHDOG=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-/root/.config/bpa/orchestrator.env}"
SYSTEMD_SYSTEM_DIR="${SYSTEMD_SYSTEM_DIR:-/etc/systemd/system}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
BASH_BIN="${BASH_BIN:-/usr/bin/bash}"
WHISPER_BIN="${WHISPER_BIN:-/opt/whisper.cpp/bin/whisper-cli}"
RUNTIME_DIR="${RUNTIME_DIR:-$INSTALL_ROOT/runtime}"
STATE_DB="${INFRA_STATE_DB:-$RUNTIME_DIR/state.db}"
CRONTAB_CMD="${CRONTAB_CMD:-crontab}"
HYGIENE_CRON_SKIP_FILE="$RUNTIME_DIR/hygiene-cron.skip"
FULL_SUITE_ON_CALENDAR="${FULL_SUITE_ON_CALENDAR:-}"

usage() {
  cat <<'EOF'
Usage: bootstrap/install.sh [--dry-run | --verify | --verify-source] [--no-cron] [--arm-watchdog|--disarm-watchdog]

Environment overrides: INSTALL_ROOT, REPO_URL, BUN_VERSION, ENV_FILE, BUN_BIN,
RUNTIME_DIR, INFRA_STATE_DB, CRONTAB_CMD, SYSTEMD_SYSTEM_DIR, BASH_BIN, and WHISPER_BIN
(the last two are test/rehearsal overrides).
--verify is the fail-closed deployed-host check. --verify-source checks only the
boundaries supported by a source/container test and may report explicit SKIPs.
The Telegram token is never accepted as an argument. Paste it into .env locally.
The watchdog timer is installed INERT; a configured token never arms it. Only
the explicit --arm-watchdog flag enables bpa-orchestrator-watchdog.timer.
--disarm-watchdog reversibly disables the system timer and leaves its units installed.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --verify) VERIFY=true ;;
    --verify-source) VERIFY_SOURCE=true ;;
    --no-cron) NO_CRON=true ;;
    --arm-watchdog) ARM_WATCHDOG=true ;;
    --disarm-watchdog) DISARM_WATCHDOG=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if "$ARM_WATCHDOG" && "$DISARM_WATCHDOG"; then
  echo "ERROR: --arm-watchdog and --disarm-watchdog are mutually exclusive" >&2
  exit 2
fi

if "$DRY_RUN" && { "$VERIFY" || "$VERIFY_SOURCE" || "$NO_CRON"; }; then
  echo "ERROR: --dry-run cannot be combined with --verify or --no-cron" >&2
  exit 2
fi

if { "$VERIFY" || "$VERIFY_SOURCE"; } && "$NO_CRON"; then
  echo "ERROR: --verify and --no-cron cannot be combined" >&2
  exit 2
fi

if "$VERIFY" && "$VERIFY_SOURCE"; then
  echo "ERROR: --verify and --verify-source are mutually exclusive" >&2
  exit 2
fi

if { "$ARM_WATCHDOG" || "$DISARM_WATCHDOG"; } && { "$DRY_RUN" || "$VERIFY" || "$VERIFY_SOURCE"; }; then
  echo "ERROR: watchdog arm/disarm applies only to a real install run" >&2
  exit 2
fi

plan() { printf 'PLAN %-12s %s\n' "$1" "$2"; }

systemd_system_available() {
  command -v systemctl >/dev/null 2>&1 && systemctl show-environment >/dev/null 2>&1
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
  plan "units" "render orchestrator, daemon, watchdog, full-suite, and morning-report SYSTEM units in $SYSTEMD_SYSTEM_DIR"
  plan "activate" "reload systemd and enable the deployment units; the watchdog timer stays INERT unless --arm-watchdog is passed"
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
  local line token
  [[ -f "$ENV_FILE" ]] || return 1
  line="$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" 2>/dev/null)" || return 1
  [[ "$(grep -Ec '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE")" == 1 ]] || return 1
  token="${line#TELEGRAM_BOT_TOKEN=}"
  # BotFather tokens are an unsigned decimal bot id, a colon, and a bounded
  # URL-safe secret. Reject shell syntax, quoting, whitespace and documented
  # operator placeholders instead of treating an env file's existence as proof.
  [[ "$token" =~ ^[0-9]{6,15}:[A-Za-z0-9_-]{20,}$ ]] || return 1
  [[ "$token" != *'__OPERATOR_'* ]]
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

gate_status() {
  "$BUN_BIN" "$INSTALL_ROOT/gate/completion-guard.ts" --help >/dev/null
}

rendered_unit_exec_paths_status() {
  local unit line command exec_path
  local -a units=("$SYSTEMD_SYSTEM_DIR"/*.service "$SYSTEMD_SYSTEM_DIR"/*.timer)

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
      if [[ "$exec_path" != "$BUN_BIN" && "$exec_path" != "$BASH_BIN" && "$exec_path" != "$INSTALL_ROOT"/* ]]; then
        return 1
      fi
    done < "$unit"
  done
}

verify() {
  local source_only="${1:-false}"
  printf '%-6s %-24s\n' 'STATUS' 'CHECK'
  printf '%-6s %-24s\n' '------' '------------------------'
  check "git" command -v git
  check "curl" command -v curl
  check "tmux" command -v tmux
  check "bun" test -x "$BUN_BIN"
  check "repository" test -d "$INSTALL_ROOT/.git"
  check "environment file" test -f "$ENV_FILE"
  check "environment permissions" test "$(stat -c '%a' "$ENV_FILE" 2>/dev/null || true)" = 600
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
  check "docker" docker version
  check "codex login" codex login status
  check "claude" claude --version
  check "whisper" "$WHISPER_BIN" --version
  if has_configured_token; then
    check "token configured" true
  else
    if "$source_only"; then skip "token configured" "token placeholder remains (source mode)"; else check "token configured" false; fi
  fi
  check "orchestrator unit" test -f "$SYSTEMD_SYSTEM_DIR/bpa-orchestrator.service"
  check "daemon unit" test -f "$SYSTEMD_SYSTEM_DIR/bpa-telegram-daemon.service"
  check "full-suite service" test -f "$SYSTEMD_SYSTEM_DIR/bpa-full-suite.service"
  check "full-suite timer" test -f "$SYSTEMD_SYSTEM_DIR/bpa-full-suite.timer"
  check "morning service" test -f "$SYSTEMD_SYSTEM_DIR/orch-morning-report.service"
  check "morning timer" test -f "$SYSTEMD_SYSTEM_DIR/orch-morning-report.timer"
  check "deploy drift service" test -f "$SYSTEMD_SYSTEM_DIR/bpa-deploy-drift-guard.service"
  check "deploy drift timer" test -f "$SYSTEMD_SYSTEM_DIR/bpa-deploy-drift-guard.timer"
  check "stand staleness service" test -f "$SYSTEMD_SYSTEM_DIR/agentic-bpa-staleness.service"
  check "stand staleness timer" test -f "$SYSTEMD_SYSTEM_DIR/agentic-bpa-staleness.timer"
  check "database grants service" test -f "$SYSTEMD_SYSTEM_DIR/agentic-bpa-db-grants.service"
  check "database grants timer" test -f "$SYSTEMD_SYSTEM_DIR/agentic-bpa-db-grants.timer"
  check "stand verifier service" test -f "$SYSTEMD_SYSTEM_DIR/agentic-bpa-stand-verifier.service"
  check "meteorite service" test -f "$SYSTEMD_SYSTEM_DIR/bpa-meteorite.service"
  check "meteorite timer" test -f "$SYSTEMD_SYSTEM_DIR/bpa-meteorite.timer"
  check "unit Exec paths" rendered_unit_exec_paths_status
  check "deployed unit drift" env \
    INSTALL_ROOT="$INSTALL_ROOT" ENV_FILE="$ENV_FILE" BUN_BIN="$BUN_BIN" \
    SYSTEMD_SYSTEM_DIR="$SYSTEMD_SYSTEM_DIR" \
    FULL_SUITE_ON_CALENDAR="${FULL_SUITE_ON_CALENDAR:-*-*-* 03:30:00}" \
    ORCH_WATCHDOG_INTERVAL="${ORCH_WATCHDOG_INTERVAL:-60}" \
    "$SCRIPT_DIR/check-unit-drift.sh"
  if ! systemd_system_available; then
    if "$source_only"; then
      skip "system systemd" "system manager unavailable (source mode)"
    else
      check "system systemd" false
    fi
  else
    check "system systemd" true
    check "orchestrator enabled" systemctl is-enabled --quiet bpa-orchestrator.service
    check "orchestrator active" systemctl is-active --quiet bpa-orchestrator.service
    check "daemon enabled" systemctl is-enabled --quiet bpa-telegram-daemon.service
    check "daemon active" systemctl is-active --quiet bpa-telegram-daemon.service
    # Unarmed is the ruled deploy default, never a failure: report the state.
    if systemctl is-enabled --quiet bpa-orchestrator-watchdog.timer; then
      check "watchdog armed" true
    else
      skip "watchdog armed" "unarmed by default; arm with bootstrap/install.sh --arm-watchdog"
    fi
    check "full-suite enabled" systemctl is-enabled --quiet bpa-full-suite.timer
    check "morning enabled" systemctl is-enabled --quiet orch-morning-report.timer
    check "deploy drift enabled" systemctl is-enabled --quiet bpa-deploy-drift-guard.timer
    check "stand staleness enabled" systemctl is-enabled --quiet agentic-bpa-staleness.timer
    check "database grants enabled" systemctl is-enabled --quiet agentic-bpa-db-grants.timer
    check "stand verifier enabled" systemctl is-enabled --quiet agentic-bpa-stand-verifier.service
    check "meteorite enabled" systemctl is-enabled --quiet bpa-meteorite.timer
  fi
  return "$result"
}

if "$VERIFY"; then
  verify false
  exit $?
fi
if "$VERIFY_SOURCE"; then
  verify true
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
  ((EUID == 0)) || { echo 'ERROR: SYSTEM unit installation requires root' >&2; return 1; }
  install -d -m 755 "$SYSTEMD_SYSTEM_DIR"
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
    destination="$SYSTEMD_SYSTEM_DIR/$(basename "${source%.in}")"
    if awk -F '\t' -v unit="$(basename "${source%.in}")" \
      '$1 == unit && $2 == "deliberately-absent" { found=1 } END { exit !found }' \
      "$SOURCE_ROOT/instance/unit-drift-exemptions.tsv"; then
      echo "Unit deliberately absent; not installing $(basename "${source%.in}")."
      continue
    fi
    INSTALL_ROOT="$INSTALL_ROOT" ENV_FILE="$ENV_FILE" BUN_BIN="$BUN_BIN" BASH_BIN="$BASH_BIN" \
      FULL_SUITE_ON_CALENDAR="$FULL_SUITE_ON_CALENDAR" ORCH_WATCHDOG_INTERVAL="$ORCH_WATCHDOG_INTERVAL" \
      envsubst < "$source" > "$destination"
    chmod 644 "$destination"
  done
  if systemd_system_available; then
    systemctl daemon-reload
  else
    echo "ERROR: system systemd is unavailable; SYSTEM units cannot be activated." >&2
    return 1
  fi
}

query_timer_state() { # <system|user> <unit> <enabled-var> <active-var>
  local scope="$1" unit="$2" enabled_var="$3" active_var="$4"
  local queried_enabled queried_active enabled_rc active_rc
  local -a prefix=()
  [[ "$scope" == system ]] || prefix=(--user)
  if queried_enabled="$(systemctl "${prefix[@]}" is-enabled "$unit")"; then
    enabled_rc=0
  else
    enabled_rc=$?
  fi
  if queried_active="$(systemctl "${prefix[@]}" is-active "$unit")"; then
    active_rc=0
  else
    active_rc=$?
  fi
  # Preserve every independently resolved value for the caller's terminal
  # report even when its companion query fails validation.
  printf -v "$enabled_var" '%s' "${queried_enabled:-unknown}"
  printf -v "$active_var" '%s' "${queried_active:-unknown}"
  case "$queried_enabled/$enabled_rc" in
    enabled/0|static/0|disabled/1|not-found/4) ;;
    *) return 1 ;;
  esac
  case "$queried_active/$active_rc" in
    active/0|inactive/3) ;;
    *) return 1 ;;
  esac
}

prove_watchdog_disarmed() { # <system|user> <unit>
  local enabled active
  query_timer_state "$1" "$2" enabled active &&
    [[ "$enabled" == disabled ]] &&
    [[ "$active" == inactive ]]
}

disarm_watchdogs() {
  local system_disable_rc=0 legacy_disable_rc=0
  local system_query_rc=0 legacy_query_rc=0
  local system_enabled=unknown system_active=unknown
  local legacy_enabled=unknown legacy_active=unknown

  systemctl disable --now bpa-orchestrator-watchdog.timer ||
    system_disable_rc=$?
  systemctl --user disable --now orch-runtime-watchdog.timer ||
    legacy_disable_rc=$?

  query_timer_state system bpa-orchestrator-watchdog.timer \
    system_enabled system_active || system_query_rc=$?
  query_timer_state user orch-runtime-watchdog.timer \
    legacy_enabled legacy_active || legacy_query_rc=$?

  printf 'WATCHDOG DISARM system=%s/%s legacy=%s/%s\n' \
    "$system_enabled" "$system_active" "$legacy_enabled" "$legacy_active"

  if (( system_disable_rc != 0 || legacy_disable_rc != 0 ||
        system_query_rc != 0 || legacy_query_rc != 0 )) ||
     [[ "$system_enabled/$system_active" != disabled/inactive ||
        "$legacy_enabled/$legacy_active" != disabled/inactive ]]; then
    echo 'ERROR: watchdog disarm failed or terminal state is unproven' >&2
    return 1
  fi
  echo 'Watchdog timers disarmed; rendered system units retained.'
}

restore_legacy_watchdog_armed() {
  local enabled active
  systemctl --user enable --now orch-runtime-watchdog.timer &&
    query_timer_state user orch-runtime-watchdog.timer enabled active &&
    [[ "$enabled/$active" == enabled/active ]]
}

rollback_watchdog_arm() { # <legacy-was-armed>
  local legacy_was_armed="$1"
  systemctl disable --now bpa-orchestrator-watchdog.timer || return 1
  prove_watchdog_disarmed system bpa-orchestrator-watchdog.timer || return 1
  if "$legacy_was_armed"; then
    restore_legacy_watchdog_armed || return 1
  fi
}

activate_units() {
  systemd_system_available || { echo 'ERROR: system systemd is unavailable' >&2; return 1; }
  if "$DISARM_WATCHDOG"; then
    disarm_watchdogs
    return
  fi
  if has_configured_token; then
    systemctl enable --now bpa-telegram-daemon.service
    systemctl enable --now bpa-orchestrator.service
    systemctl enable --now bpa-full-suite.timer
    systemctl enable --now orch-morning-report.timer
    systemctl enable --now bpa-deploy-drift-guard.timer
    systemctl enable --now agentic-bpa-staleness.timer
    systemctl enable --now agentic-bpa-db-grants.timer
    systemctl enable --now agentic-bpa-stand-verifier.service
    systemctl enable --now bpa-meteorite.timer
    if "$ARM_WATCHDOG"; then
      local legacy_enabled legacy_active legacy_was_armed=false
      query_timer_state user orch-runtime-watchdog.timer legacy_enabled legacy_active || {
        echo "ERROR: legacy user watchdog state is unverifiable; refusing system watchdog arm" >&2
        return 1
      }
      if [[ "$legacy_enabled/$legacy_active" == enabled/active ]]; then
        legacy_was_armed=true
        if ! systemctl --user disable --now orch-runtime-watchdog.timer; then
          echo 'ERROR: legacy user watchdog retirement command failed' >&2
          return 1
        fi
        if ! prove_watchdog_disarmed user orch-runtime-watchdog.timer; then
          restore_legacy_watchdog_armed ||
            echo 'ERROR: legacy watchdog retirement failed and prior state restoration is unproven' >&2
          echo 'ERROR: legacy user watchdog remains armed; refusing system watchdog arm' >&2
          return 1
        fi
      elif [[ "$legacy_enabled/$legacy_active" != disabled/inactive &&
              "$legacy_enabled/$legacy_active" != not-found/inactive &&
              "$legacy_enabled/$legacy_active" != static/inactive ]]; then
        echo "ERROR: legacy user watchdog state is inconsistent enabled=$legacy_enabled active=$legacy_active" >&2
        return 1
      fi
      local watchdog_enabled watchdog_active watchdog_next
      if ! systemctl enable --now bpa-orchestrator-watchdog.timer ||
         ! query_timer_state system bpa-orchestrator-watchdog.timer watchdog_enabled watchdog_active ||
         [[ "$watchdog_enabled/$watchdog_active" != enabled/active ]] ||
         ! watchdog_next="$(systemctl show bpa-orchestrator-watchdog.timer --property=NextElapseUSecRealtime --value)" ||
         ! finite_future_systemd_trigger "$watchdog_next" "${ORCH_WATCHDOG_NOW:-$(date +%s)}" ||
         ! systemctl start bpa-orchestrator-watchdog.service; then
        rollback_watchdog_arm "$legacy_was_armed" || {
          echo 'ERROR: watchdog arm failed and rollback could not be proven' >&2
          return 1
        }
        echo "ERROR: watchdog arm unproven enabled=${watchdog_enabled:-unknown} active=${watchdog_active:-unknown} next=${watchdog_next:-none}" >&2
        return 1
      fi
    else
      echo 'Watchdog timer installed but remains unarmed.'
    fi
  else
    echo "Telegram bot token is missing or invalid; units installed but not enabled. Edit $ENV_FILE, then re-run this installer."
    if "$ARM_WATCHDOG"; then
      echo 'ERROR: refusing watchdog arm without a configured Telegram alert channel' >&2
      return 1
    fi
  fi
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
  activate_units
  if "$DISARM_WATCHDOG"; then
    echo "Bootstrap watchdog disarm completed and verified."
    exit 0
  fi
  verify false
  echo "Bootstrap completed and deployment verification passed."
fi
