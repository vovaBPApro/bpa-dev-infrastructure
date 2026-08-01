#!/usr/bin/env bash
# Shared, non-destructive Telegram transport precondition for bootstrap arm and
# deployed verification. The secret is supplied to curl through stdin, never
# argv; response bodies are parsed from a private file and never printed.

telegram_environment_file_unicode_valid() { # <EnvironmentFile>
  local env_file="$1" bun_bin
  bun_bin="${TELEGRAM_PREFLIGHT_BUN_BIN:-${BUN_BIN:-bun}}"
  # systemd 255 accepts only UTF-8 scalar values and excludes U+FEFF plus every
  # Unicode noncharacter. Decode the whole byte stream before Bash can split or
  # discard any physical-line content. U+0000 remains a separate exact-byte
  # guard below so its regression lock cannot be masked by this validator.
  "$bun_bin" -e '
    const bytes = new Uint8Array(await Bun.stdin.arrayBuffer());
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      process.exit(1);
    }
    for (const character of text) {
      const point = character.codePointAt(0);
      if (point === 0xfeff ||
          (point >= 0xfdd0 && point <= 0xfdef) ||
          (point & 0xffff) === 0xfffe ||
          (point & 0xffff) === 0xffff) {
        process.exit(1);
      }
    }
  ' < "$env_file" >/dev/null 2>&1
}

telegram_read_bot_token() { # sets TELEGRAM_EFFECTIVE_BOT_TOKEN
  local env_file="$1" line trimmed token assignments=0
  TELEGRAM_EFFECTIVE_BOT_TOKEN=
  [[ -f "$env_file" && ! -L "$env_file" ]] || return 1
  # Parse only a deliberately smaller EnvironmentFile language whose effective
  # values are identical under this reader and systemd. Backslashes can join
  # physical lines and quotes can span them, so neither is supported anywhere
  # in the file. NUL, CR and the remaining non-tab control bytes are likewise
  # rejected before Bash physical-line parsing can disagree with systemd.
  telegram_environment_file_unicode_valid "$env_file" || return 1
  LC_ALL=C tr -d '\000' < "$env_file" | LC_ALL=C cmp -s "$env_file" - || return 1
  LC_ALL=C grep -q $'[\001-\010\013-\037\177]' "$env_file" && return 1
  LC_ALL=C grep -q '["'"'"'\\]' "$env_file" && return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="${line#"${line%%[!$' \t']*}"}"
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
    if [[ "$trimmed" == TELEGRAM_BOT_TOKEN* || "$trimmed" == export[[:space:]]TELEGRAM_BOT_TOKEN* ]]; then
      ((assignments += 1))
      # Supported EnvironmentFile subset: exactly one unquoted assignment at
      # column zero. Reject whitespace, export, duplicates and ambiguous forms.
      [[ "$line" == TELEGRAM_BOT_TOKEN=* ]] || return 1
      token="${line#TELEGRAM_BOT_TOKEN=}"
      [[ "$token" =~ ^[0-9]{6,15}:[A-Za-z0-9_-]{20,128}$ ]] || return 1
      [[ "$token" != *'__OPERATOR_'* ]] || return 1
      TELEGRAM_EFFECTIVE_BOT_TOKEN="$token"
    fi
  done < "$env_file"
  [[ "$assignments" == 1 && -n "$TELEGRAM_EFFECTIVE_BOT_TOKEN" ]]
}

telegram_transport_preflight() { # <EnvironmentFile>
  local env_file="$1" token bot_id api_root response status=0 max_time failure_reason=transport
  telegram_read_bot_token "$env_file" || { printf '%s\n' 'ERROR Telegram alert transport preflight failed reason=config' >&2; return 1; }
  token="$TELEGRAM_EFFECTIVE_BOT_TOKEN"
  bot_id="${token%%:*}"
  api_root="${TELEGRAM_API_ROOT:-https://api.telegram.org}"
  max_time="${TELEGRAM_PREFLIGHT_TIMEOUT_SECONDS:-10}"
  [[ "$api_root" =~ ^https?://[^[:space:]\"]+$ ]] || { printf '%s\n' 'ERROR Telegram alert transport preflight failed reason=endpoint' >&2; return 1; }
  [[ "$max_time" =~ ^[1-9]$|^10$ ]] || { printf '%s\n' 'ERROR Telegram alert transport preflight failed reason=timeout-config' >&2; return 1; }
  response="$(mktemp)" || return 1
  chmod 600 "$response"
  # POST getMe is read-only. curl receives the token-bearing URL only through
  # its stdin config and emits neither headers nor provider error bodies.
  {
    printf 'url = "%s/bot%s/getMe"\nrequest = "POST"\noutput = "%s"\nsilent\nshow-error = false\nfail-with-body\nmax-time = %s\nconnect-timeout = %s\n' \
      "$api_root" "$token" "$response" "$max_time" "$max_time"
    if [[ "$api_root" == http://127.0.0.1:* || "$api_root" == http://localhost:* ]]; then
      printf 'noproxy = "*"\n'
    fi
  } |
    "${CURL_BIN:-curl}" --config - >/dev/null 2>&1 || status=$?
  if ((status == 0)); then
    failure_reason=response
    TELEGRAM_EXPECTED_BOT_ID="$bot_id" "${TELEGRAM_PREFLIGHT_BUN_BIN:-${BUN_BIN:-bun}}" -e '
      const text = await Bun.stdin.text();
      let value; try { value = JSON.parse(text); } catch { process.exit(1); }
      const expected = Number(process.env.TELEGRAM_EXPECTED_BOT_ID);
      if (value?.ok !== true || value?.result?.is_bot !== true ||
          !Number.isSafeInteger(value?.result?.id) || value.result.id !== expected) process.exit(1);
    ' < "$response" >/dev/null 2>&1 || status=$?
  fi
  rm -f "$response"
  unset TELEGRAM_EFFECTIVE_BOT_TOKEN
  if ((status != 0)); then
    printf 'ERROR Telegram alert transport preflight failed reason=%s\n' "$failure_reason" >&2
    return 1
  fi
}
