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
// Hard constraint: a mirror row carries only the whitelisted fields serialized
// below — message identity, text, attachment identity (W-15: without the
// Telegram file_id a lost attachment delivery was unrecoverable), and the
// voice transcript. No bot token, no env value, no secret ever enters a row —
// serializeInboxLine emits ONLY the whitelist, so a caller cannot leak a token
// by over-passing.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { maskSecrets } from "./secret-masker";

// One raw inbound row. `text` may contain newlines, emoji, or other Human input;
// JSON.stringify escapes all of it into a single safe line.
//
// The attachment fields (W-15) record the Telegram file identity for every
// attachment-bearing message so a delivery lost between daemon and session is
// recoverable later via download_attachment. `transcript` carries the local
// Whisper transcription of a voice/audio message (HR-146 §NI-3);
// `transcript_error` records WHY a transcription is absent — the row must
// never silently look like a plain text message when the audio could not be
// transcribed.
export type InboxRecord = {
  msg_id: number | string;
  chat_id: number | string;
  ts: string;
  text: string;
  attachment_kind?: string;
  attachment_file_id?: string;
  attachment_name?: string;
  attachment_mime?: string;
  attachment_size?: number;
  transcript?: string;
  transcript_error?: string;
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
// The key order is fixed so rows are stable/diffable. Only the whitelisted
// fields are emitted — any extra property on the input is ignored, so a caller
// cannot accidentally leak a token by over-passing. Optional fields are
// omitted (not emitted as null) so plain text rows keep their historical shape.
export function serializeInboxLine(record: InboxRecord): string {
  const row: Record<string, string | number> = {
    msg_id: record.msg_id,
    chat_id: record.chat_id,
    ts: record.ts,
    text: record.text,
  };
  if (record.attachment_kind !== undefined)
    row.attachment_kind = record.attachment_kind;
  if (record.attachment_file_id !== undefined)
    row.attachment_file_id = record.attachment_file_id;
  if (record.attachment_name !== undefined)
    row.attachment_name = record.attachment_name;
  if (record.attachment_mime !== undefined)
    row.attachment_mime = record.attachment_mime;
  if (record.attachment_size !== undefined)
    row.attachment_size = record.attachment_size;
  if (record.transcript !== undefined) row.transcript = record.transcript;
  if (record.transcript_error !== undefined)
    row.transcript_error = record.transcript_error;
  return maskSecrets(JSON.stringify(row)) + "\n";
}

// Appends one mirror row to the inbox file, creating the file (and its parent
// directory) if missing. Append-only: existing content is never read or
// rewritten. Returns the path written, and THROWS when the write fails — the
// failure is the caller's to act on. Do not wrap this in a bare `catch {}`:
// a swallowed mirror failure is exactly the defect mirrorInbound below exists
// to close (HR-2486). Use mirrorInbound unless you want the exception.
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

// ---------------------------------------------------------------------------
// The receipt contract (HR-2486)
// ---------------------------------------------------------------------------
// The Human ruled, verbatim:
//
//   «якщо на моєму повідомлені є реакція (очі) то я вважаю що ти його отримав
//    і зберіг»
//
// So the 👀 reaction on one of his messages is a RECEIPT, not decoration and
// not a delivery indicator: it asserts *received AND stored*. He audits the
// system by that belief — a message wearing 👀 is one he will not re-send.
//
// That makes the two failure directions wildly asymmetric:
//   • no reaction on a stored message  -> he re-sends; cost is a duplicate.
//   • a reaction on an UNSTORED message -> he never re-sends; cost is a lost
//     requirement, silently, with no one able to tell afterwards.
//
// Therefore the receipt is fail-closed: it is earned only by a mirror row that
// actually reached disk. Delivery, however, is NEVER gated on the mirror — he
// must not lose a message because storage broke. When the write fails the
// daemon still delivers, withholds the reaction, and pings him loudly with the
// message id so he knows which of his own messages to re-send.
//
// `mirrorInbound` is the only entry point that satisfies both halves: it never
// throws (so it cannot block delivery) and it never hides the outcome (so the
// reaction sites can obey the contract).

export type MirrorReceipt =
  | { stored: true; path: string }
  | { stored: false; error: string };

// Writes one mirror row and reports the outcome instead of swallowing it.
// Never throws: a caller on the delivery path can call this and keep going.
// On failure, `onFailure` receives the operator-facing notice so the caller
// only has to route it through whatever ping channel it already owns.
export function mirrorInbound(
  repoRoot: string,
  record: InboxRecord,
  onFailure?: (notice: string, error: string) => void,
  override?: string,
): MirrorReceipt {
  try {
    return { stored: true, path: appendInboxLine(repoRoot, record, override) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const receipt: MirrorReceipt = { stored: false, error };
    // The notice is built here, next to the contract it explains, so every
    // caller reports the same thing and names the message id.
    //
    // The sink is fenced: "never throws" is what lets a caller put this on the
    // delivery path, so a sink that blows up must not take delivery down with
    // it. Losing the notification is bad; losing his message is worse.
    try {
      if (onFailure) onFailure(mirrorFailureNotice(record.msg_id), error);
    } catch {
      /* a broken notifier still must not reach the delivery path */
    }
    return receipt;
  }
}

// The loud operator-facing notice for a mirror failure. It names the message id
// because that is the only thing that tells him WHICH of his messages to send
// again. Kept to three short lines (operator-feedback: chat is a notification,
// not a report) and free of the underlying error text — that goes to stderr,
// where it is durable and cannot echo a path or payload back into the chat.
export function mirrorFailureNotice(msgId: number | string): string {
  const id = msgId === "" || msgId == null ? "(без id)" : String(msgId);
  return (
    `⚠️ Повідомлення ${id} НЕ збережено на диск.\n` +
    `Доставив у сесію, але 👀 не поставлю — реакція означає «отримав і зберіг».\n` +
    `Перешли його ще раз.`
  );
}
