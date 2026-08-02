#!/usr/bin/env bash
# Shared runtime executable discovery for scripts invoked by user systemd.
# An explicit BUN_BIN wins; then use the normal Bun install location; only then
# fall back to PATH for developer checkouts.
resolve_bun_bin() {
  if [[ -n "${BUN_BIN:-}" ]]; then
    printf '%s\n' "$BUN_BIN"
  elif [[ -x "$HOME/.bun/bin/bun" ]]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
  else
    command -v bun
  fi
}

BUN_BIN="$(resolve_bun_bin)"
