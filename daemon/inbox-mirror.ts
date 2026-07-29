// Daemon-side inbox auto-mirror (INSTRUCTIONS_CONSILIUM_FINAL.md §2.4, the B276
// fix). On every inbound Human message the daemon appends one JSON line to
// `instance/decisions/inbox.jsonl` so capture no longer depends on orchestrator
// diligence or on surviving until the next session — a directive received five
// minutes before an OOM-kill is already on disk.
//
// The file is APPEND-ONLY and never rewritten: each call adds exactly one line
// and touches nothing already written. It is a runtime artifact and MUST stay
// out of git — it carries raw chat text (see instance/README.md + .gitignore).
//
// Hard constraint: this line carries {msg_id, chat_id, ts, text} and NOTHING
// else. No bot token, no env value, no secret ever enters a mirror row — the
// caller passes only the four fields below and this module serializes only them.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// One raw inbound row. `text` may contain newlines, emoji, or other Human input;
// JSON.stringify escapes all of it into a single safe line.
export type InboxRecord = {
  msg_id: number | string;
  chat_id: number | string;
  ts: string;
  text: string;
};

// Default path, relative to the repo root. Overridable via ORCH_INBOX_JSONL
// (used in tests and when the state dir is relocated).
export const DEFAULT_INBOX_RELATIVE = join("instance", "decisions", "inbox.jsonl");

// Resolves the mirror file path. An absolute ORCH_INBOX_JSONL wins; a relative
// one is taken from repoRoot; with neither, the default under repoRoot is used.
export function resolveInboxPath(
  repoRoot: string,
  override: string | undefined = process.env.ORCH_INBOX_JSONL,
): string {
  if (override && override.trim() !== "") {
    return isAbsolute(override) ? override : join(repoRoot, override);
  }
  return join(repoRoot, DEFAULT_INBOX_RELATIVE);
}

// Pure function: record -> exactly one serialized JSON line terminated by "\n".
// The key order is fixed so rows are stable/diffable. Only the four whitelisted
// fields are emitted; any extra property on the input is ignored, so a caller
// cannot accidentally leak a token by over-passing.
export function serializeInboxLine(record: InboxRecord): string {
  const row = {
    msg_id: record.msg_id,
    chat_id: record.chat_id,
    ts: record.ts,
    text: record.text,
  };
  return JSON.stringify(row) + "\n";
}

// Appends one mirror row to the inbox file, creating the file (and its parent
// directory) if missing. Append-only: existing content is never read or
// rewritten. Returns the path written. Best-effort by contract of the caller —
// the daemon wraps this in try/catch so mirroring never blocks delivery.
export function appendInboxLine(
  repoRoot: string,
  record: InboxRecord,
  override?: string,
): string {
  const path = resolveInboxPath(repoRoot, override);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, serializeInboxLine(record));
  return path;
}
