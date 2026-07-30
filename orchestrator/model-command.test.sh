#!/usr/bin/env bash
# Regression lock for the /model switch surface.
#
# The Telegram daemon owns the vocabulary and the runtime.env write; this test
# locks the half that actually decides what the orchestrator runs on:
#
#   launch.sh model                    machine-readable resolved state, so the
#                                      daemon reports the REAL model instead of
#                                      a second copy of the defaults
#   claude --model <pinned>            a claude launch with no --model silently
#                                      takes whatever the account defaults to,
#                                      exactly the codex bug fixed in HR-11573
#   ORCH_CLAUDE_MODEL wins over pin    the /model write lands in runtime.env
#   pin survives a relaunch            the whole point of persisting it
#   ORCH_PROVIDER is never implied     a model pin must not hijack the daemon's
#                                      per-launch `ORCH_PROVIDER=… launch.sh start`
#
# The launcher is exercised for real: `claude`/`codex` shims on PATH record
# their argv, and a `tmux` shim confines every session to a private tmux socket
# so the live orchestrator session is never touched.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH="$(mktemp -d)"
TMUX_SOCKET="model-command-$$"
cleanup() {
  tmux -L "$TMUX_SOCKET" kill-server 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

mkdir -p "$SCRATCH/bin" "$SCRATCH/runtime"
cat > "$SCRATCH/bin/tmux" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/tmux -L "${ORCH_TEST_TMUX_SOCKET:?}" "$@"
EOF
cat > "$SCRATCH/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${ORCH_TEST_PROVIDER_ARGS:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${ORCH_TEST_PROVIDER_ARGS:?}"
exec sleep 1000
EOF
cat > "$SCRATCH/preflight.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$SCRATCH/bin/tmux" "$SCRATCH/bin/claude" "$SCRATCH/bin/codex" \
  "$SCRATCH/preflight.sh"

export PATH="$SCRATCH/bin:$PATH"
export ORCH_TEST_TMUX_SOCKET="$TMUX_SOCKET"
export ORCH_TEST_PROVIDER_ARGS="$SCRATCH/provider-args"
export ORCH_RUNTIME_DIR="$SCRATCH/runtime"
export ORCH_SINGLETON_LOCK_FILE="$SCRATCH/orchestrator.singleton.lock"
export ORCH_STATE_DB="$SCRATCH/absent-state.db"
# ── Live-state isolation ────────────────────────────────────────────────────
# A coder lane runs inside the orchestrator's own process tree and inherits its
# environment, and every one of these paths is env-derived inside launch.sh, so
# an unset here resolves to the operator's REAL file. `stop` deletes the
# instance lock and the lease file; a launch writes the heartbeat. Copied from
# orchestrator/codex-notify-wiring.test.sh — see the reasoning there.
export ORCH_INSTANCE_LOCK_FILE="$SCRATCH/instance.lock"
export ORCH_LEASE_FILE="$SCRATCH/orchestrator.lease"
export ORCH_HEARTBEAT_FILE="$SCRATCH/runtime/orchestrator.heartbeat"
export ORCH_LOCK_FILE="$SCRATCH/launch.lock"
export ORCH_CLAUDE_RELAY_SETTINGS="$SCRATCH/claude-relay-settings.json"
export ORCH_CLAUDE_MCP_CONFIG="$SCRATCH/claude-mcp-config.json"
export ORCH_INSTALL_ROOT="$SCRATCH"
# The assertions below are about the launcher's OWN defaults (the fresh-clone
# path). An ambient value for any of these would quietly rewrite what is being
# tested, so they are cleared rather than trusted.
unset ORCH_MODEL ORCH_CLAUDE_MODEL ORCH_CODEX_MODEL ORCH_CODEX_REASONING_EFFORT
unset ORCH_CODEX_SESSION_HOOK ORCH_TURNEND_RELAY ORCH_SKIP_TRUST_CHECK
unset ORCH_CLAUDE_STOP_RELAY ORCH_CLAUDE_MCP_URL
unset TELEGRAM_BOUND_CHAT_ID TELEGRAM_CHAT_ID
export ORCH_AUTH_PREFLIGHT="$SCRATCH/preflight.sh"
export ORCH_SESSION="model-command-test"
export ORCH_WORK_DIR="$REPO_DIR"

# Fail closed if the isolation block above ever regresses: not one live path
# may be reachable from this test's environment.
for guard in ORCH_INSTANCE_LOCK_FILE ORCH_LEASE_FILE ORCH_HEARTBEAT_FILE \
             ORCH_LOCK_FILE ORCH_STATE_DB ORCH_RUNTIME_DIR \
             ORCH_SINGLETON_LOCK_FILE ORCH_INSTALL_ROOT; do
  value="${!guard}"
  [[ "$value" == "$SCRATCH"* ]] || {
    printf 'isolation breach: %s=%s is outside the scratch dir\n' \
      "$guard" "$value" >&2
    exit 1
  }
done

arg_after() { sed -n "/^$1\$/{n;p;q;}" "$ORCH_TEST_PROVIDER_ARGS"; }
field() { sed -n "s/^$1=//p" <<<"$2"; }

# A trusted work dir for both providers; without it the TUI stops on a prompt
# in a pane nobody can answer.
export CODEX_HOME="$SCRATCH/codex-home"
mkdir -p "$CODEX_HOME"
printf '[projects."%s"]\ntrust_level = "trusted"\n' "$(cd "$REPO_DIR" && pwd -P)" \
  > "$CODEX_HOME/config.toml"
export ORCH_SKIP_TRUST_CHECK=1

# ── 1. `launch.sh model` reports resolved state, defaults only ──────────────
export ORCH_CONFIG_FILE="$SCRATCH/no-runtime.env"
export ORCH_PROVIDER=claude
report="$("$SCRIPT_DIR/launch.sh" model)"

[[ "$(field provider "$report")" == 'claude' ]] || {
  printf 'model report lost the provider: %s\n' "$report" >&2; exit 1; }
[[ "$(field config_file "$report")" == "$SCRATCH/no-runtime.env" ]] || {
  printf 'model report lost the config file: %s\n' "$report" >&2; exit 1; }

default_claude="$(field claude_model "$report")"
default_codex="$(field codex_model "$report")"
[[ -n "$default_claude" ]] || {
  printf 'claude model is UNPINNED — a launch would take the account default\n' >&2
  exit 1; }
[[ "$default_codex" == 'gpt-5.6-sol' ]] || {
  printf 'codex pin regressed: %s\n' "${default_codex:-<absent>}" >&2; exit 1; }
# instance/params.yaml orchestrator.top_model — the value that survives a fresh
# clone with no runtime.env at all.
[[ "$default_claude" == 'claude-opus-5' ]] || {
  printf 'claude pin is not the recorded instance fact: %s\n' "$default_claude" >&2
  exit 1; }

# ── 2. The reported claude model is the one actually launched ───────────────
"$SCRIPT_DIR/launch.sh" start >/dev/null
"$SCRIPT_DIR/launch.sh" stop >/dev/null
launched="$(arg_after '--model')"
[[ "$launched" == "$default_claude" ]] || {
  printf 'report says %s but claude was launched with %s\n' \
    "$default_claude" "${launched:-<no --model at all>}" >&2
  exit 1
}
grep -Fxq -- '--dangerously-skip-permissions' "$ORCH_TEST_PROVIDER_ARGS"

# ── 3. A /model pin in runtime.env wins over the source pin ─────────────────
# This is exactly the file the daemon's /model handler writes.
printf 'ORCH_CLAUDE_MODEL=claude-fable-5\n' > "$SCRATCH/pinned.env"
export ORCH_CONFIG_FILE="$SCRATCH/pinned.env"
report="$("$SCRIPT_DIR/launch.sh" model)"
[[ "$(field claude_model "$report")" == 'claude-fable-5' ]] || {
  printf 'runtime.env pin not reflected in the report: %s\n' "$report" >&2; exit 1; }
"$SCRIPT_DIR/launch.sh" start >/dev/null
"$SCRIPT_DIR/launch.sh" stop >/dev/null
[[ "$(arg_after '--model')" == 'claude-fable-5' ]] || {
  printf 'runtime.env pin did not reach the launch command: %s\n' \
    "$(arg_after '--model')" >&2
  exit 1
}
# The escalation tier must not bleed into codex.
[[ "$(field codex_model "$report")" == 'gpt-5.6-sol' ]] || {
  printf 'a claude pin leaked into the codex model: %s\n' "$report" >&2; exit 1; }

# ── 4. The pin survives a relaunch (simulated daemon restart) ───────────────
# Fresh process, same config file, nothing carried in the environment.
unset ORCH_CLAUDE_MODEL
relaunch="$(env -u ORCH_CLAUDE_MODEL "$SCRIPT_DIR/launch.sh" model)"
[[ "$(field claude_model "$relaunch")" == 'claude-fable-5' ]] || {
  printf 'pin did not survive the relaunch: %s\n' "$relaunch" >&2; exit 1; }

# ── 5. A model pin must NOT imply or move ORCH_PROVIDER ────────────────────
# runtime.env is SOURCED, so a provider written there would override the
# daemon's per-launch `ORCH_PROVIDER='codex' launch.sh start` and desynchronise
# binding.provider — decideRelay then rejects every turn as provider_mismatch
# and the operator's only channel goes silent.
grep -q '^ORCH_PROVIDER=' "$SCRATCH/pinned.env" && {
  printf 'the pin file carries ORCH_PROVIDER\n' >&2; exit 1; }
grep -q '^ORCH_MODEL=' "$SCRATCH/pinned.env" && {
  printf 'the pin file carries the provider-agnostic ORCH_MODEL\n' >&2; exit 1; }
# Prove it end to end: with a claude pin on disk, a codex launch still starts
# codex, on the codex model.
ORCH_PROVIDER=codex "$SCRIPT_DIR/launch.sh" start >/dev/null
ORCH_PROVIDER=codex "$SCRIPT_DIR/launch.sh" stop >/dev/null
[[ "$(arg_after '--model')" == 'gpt-5.6-sol' ]] || {
  printf 'a claude pin hijacked the codex launch: %s\n' "$(arg_after '--model')" >&2
  exit 1
}
codex_report="$(ORCH_PROVIDER=codex "$SCRIPT_DIR/launch.sh" model)"
[[ "$(field provider "$codex_report")" == 'codex' ]] || {
  printf 'per-launch ORCH_PROVIDER was overridden by runtime.env: %s\n' \
    "$codex_report" >&2
  exit 1
}

# ── 6. `model` is read-only: it must never start, stop, or write state ─────
before="$(find "$SCRATCH/runtime" -mindepth 1 -printf '%P\n' | sort)"
"$SCRIPT_DIR/launch.sh" model >/dev/null
after="$(find "$SCRATCH/runtime" -mindepth 1 -printf '%P\n' | sort)"
[[ "$before" == "$after" ]] || {
  printf 'launch.sh model mutated the runtime dir\n%s\n---\n%s\n' \
    "$before" "$after" >&2
  exit 1
}
tmux has-session -t "$ORCH_SESSION" 2>/dev/null && {
  printf 'launch.sh model started a session\n' >&2; exit 1; }

# ── 7. The legacy provider-agnostic ORCH_MODEL still works, and still loses ─
# Precedence: ORCH_CLAUDE_MODEL > ORCH_MODEL > pin. Same shape as codex.
printf 'ORCH_MODEL=legacy-model\n' > "$SCRATCH/legacy.env"
legacy="$(ORCH_CONFIG_FILE="$SCRATCH/legacy.env" "$SCRIPT_DIR/launch.sh" model)"
[[ "$(field claude_model "$legacy")" == 'legacy-model' ]] || {
  printf 'legacy ORCH_MODEL stopped applying to claude: %s\n' "$legacy" >&2; exit 1; }
printf 'ORCH_MODEL=legacy-model\nORCH_CLAUDE_MODEL=claude-sonnet-5\n' \
  > "$SCRATCH/both.env"
both="$(ORCH_CONFIG_FILE="$SCRATCH/both.env" "$SCRIPT_DIR/launch.sh" model)"
[[ "$(field claude_model "$both")" == 'claude-sonnet-5' ]] || {
  printf 'ORCH_CLAUDE_MODEL did not win over the legacy key: %s\n' "$both" >&2
  exit 1
}

printf 'model command regression: PASS\n'
