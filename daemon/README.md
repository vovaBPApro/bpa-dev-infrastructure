# Telegram daemon

## Message history

The daemon writes bidirectional delivery metadata to
`$TELEGRAM_STATE_DIR/history/messages-YYYY-MM.jsonl`. Each record includes its
timestamp, direction, delivery outcome, Telegram identifiers, content byte
length, and a SHA-256 fingerprint. It deliberately never stores message text,
captions, attachment bytes, or Telegram error text because any of those may
contain credentials. The fingerprint supports incident correlation without
turning the forensic log into another secret store.

Retention is bounded twice:

- `TELEGRAM_HISTORY_RETENTION_DAYS` controls file age (default: 30 days).
- `TELEGRAM_HISTORY_MAX_BYTES` caps the active monthly file (default: 10 MiB);
  oldest complete records are removed first.

Both values must be positive integers. Invalid values fail closed to the bounded
defaults. History writes are best-effort and stay off the message-delivery
critical path.
