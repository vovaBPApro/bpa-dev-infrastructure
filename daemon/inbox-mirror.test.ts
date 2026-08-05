import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INBOX_RELATIVE,
  type InboxRecord,
  type MirrorReceipt,
  appendInboxLine,
  mirrorFailureNotice,
  mirrorInbound,
  resolveInboxPath,
  serializeInboxLine,
} from "./inbox-mirror";

test("raw inbox sink masks credential assignments", () => {
  const value = `left-${"z".repeat(24)}-right`;
  const line = serializeInboxLine({ msg_id: 1, chat_id: 2, ts: "now", text: `ACCESS_TOKEN=${value}` });
  expect(line).not.toContain(value);
  expect(line).toContain("********");
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "inbox-mirror-"));
  temporaryDirectories.push(repo);
  return repo;
}

describe("serializeInboxLine", () => {
  test("serializes the four fields in a stable order, one line", () => {
    const line = serializeInboxLine({
      msg_id: 42,
      chat_id: 1001,
      ts: "2026-07-29T10:00:00.000Z",
      text: "hello",
    });
    expect(line).toBe(
      '{"msg_id":42,"chat_id":1001,"ts":"2026-07-29T10:00:00.000Z","text":"hello"}\n',
    );
    // Exactly one trailing newline, no internal newline.
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
  });

  test("escapes newlines, tabs, and quotes into a single line", () => {
    const line = serializeInboxLine({
      msg_id: "m1",
      chat_id: "c1",
      ts: "2026-07-29T10:00:00.000Z",
      text: 'line one\nline two\twith "quotes"',
    });
    // The physical string has exactly one newline: the terminator.
    expect(line.split("\n").length).toBe(2);
    const parsed = JSON.parse(line);
    expect(parsed.text).toBe('line one\nline two\twith "quotes"');
  });

  test("round-trips emoji and multi-byte text", () => {
    const text = "привіт 👋 🎉 ретельно протестуй";
    const parsed = JSON.parse(
      serializeInboxLine({ msg_id: 7, chat_id: 9, ts: "t", text }),
    );
    expect(parsed.text).toBe(text);
  });

  test("records attachment identity for attachment-bearing rows (W-15)", () => {
    const line = serializeInboxLine({
      msg_id: 156,
      chat_id: 1001,
      ts: "2026-07-30T01:00:00.000Z",
      text: "(document: report.pdf)",
      attachment_kind: "document",
      attachment_file_id: "BQACAgIAAxkBAAIB",
      attachment_name: "report.pdf",
      attachment_mime: "application/pdf",
      attachment_size: 12345,
    });
    const parsed = JSON.parse(line);
    expect(parsed.attachment_kind).toBe("document");
    expect(parsed.attachment_file_id).toBe("BQACAgIAAxkBAAIB");
    expect(parsed.attachment_name).toBe("report.pdf");
    expect(parsed.attachment_mime).toBe("application/pdf");
    expect(parsed.attachment_size).toBe(12345);
    // Still exactly one physical line.
    expect(line.split("\n").length).toBe(2);
  });

  test("records voice transcript and, separately, an honest failure reason", () => {
    const good = JSON.parse(
      serializeInboxLine({
        msg_id: 1,
        chat_id: 2,
        ts: "t",
        text: "привіт, як справи?",
        attachment_kind: "voice",
        attachment_file_id: "VOICE1",
        transcript: "привіт, як справи?",
      }),
    );
    expect(good.transcript).toBe("привіт, як справи?");
    expect(good.transcript_error).toBeUndefined();

    const bad = JSON.parse(
      serializeInboxLine({
        msg_id: 2,
        chat_id: 2,
        ts: "t",
        text: "(voice message)",
        attachment_kind: "voice",
        attachment_file_id: "VOICE2",
        transcript_error: "whisper model missing: /opt/whisper.cpp/...",
      }),
    );
    expect(bad.transcript).toBeUndefined();
    expect(bad.transcript_error).toContain("whisper model missing");
  });

  test("plain text rows keep their historical four-field shape", () => {
    const parsed = JSON.parse(
      serializeInboxLine({ msg_id: 1, chat_id: 2, ts: "t", text: "hi" }),
    );
    expect(Object.keys(parsed).sort()).toEqual(["chat_id", "msg_id", "text", "ts"]);
  });

  test("ignores extra properties so a token cannot leak in", () => {
    // A fake credential-shaped value on a non-whitelisted key must never reach
    // the serialized line (kept pattern-free so the secret scan stays clean).
    const leakSentinel = "LEAK-" + "must-not-appear";
    const record = {
      msg_id: 1,
      chat_id: 2,
      ts: "t",
      text: "hi",
      token: leakSentinel,
      env: "TELEGRAM_TOKEN",
    };
    const parsed = JSON.parse(serializeInboxLine(record as never));
    expect(Object.keys(parsed).sort()).toEqual(["chat_id", "msg_id", "text", "ts"]);
    expect(JSON.stringify(parsed)).not.toContain(leakSentinel);
  });
});

describe("resolveInboxPath", () => {
  test("defaults to instance/decisions/inbox.jsonl under repo root", () => {
    expect(resolveInboxPath("/repo", "")).toBe(join("/repo", DEFAULT_INBOX_RELATIVE));
    // Also when the override is undefined.
    expect(resolveInboxPath("/repo", undefined)).toBe(
      join("/repo", DEFAULT_INBOX_RELATIVE),
    );
  });

  test("absolute override wins verbatim", () => {
    expect(resolveInboxPath("/repo", "/var/run/inbox.jsonl")).toBe(
      "/var/run/inbox.jsonl",
    );
  });

  test("relative override is taken from repo root", () => {
    expect(resolveInboxPath("/repo", "state/inbox.jsonl")).toBe(
      join("/repo", "state/inbox.jsonl"),
    );
  });
});

describe("appendInboxLine", () => {
  test("creates the file (and dir) if missing, then appends", () => {
    const repo = tempRepo();
    const path = appendInboxLine(repo, {
      msg_id: 1,
      chat_id: 100,
      ts: "2026-07-29T10:00:00.000Z",
      text: "first",
    });
    expect(path).toBe(join(repo, DEFAULT_INBOX_RELATIVE));
    const rows = readFileSync(path, "utf8").trim().split("\n");
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0]).text).toBe("first");
  });

  test("appends without rewriting prior lines", () => {
    const repo = tempRepo();
    appendInboxLine(repo, { msg_id: 1, chat_id: 1, ts: "t1", text: "one" });
    appendInboxLine(repo, { msg_id: 2, chat_id: 1, ts: "t2", text: "two" });
    appendInboxLine(repo, { msg_id: 3, chat_id: 1, ts: "t3", text: "three" });
    const rows = readFileSync(join(repo, DEFAULT_INBOX_RELATIVE), "utf8")
      .trim()
      .split("\n")
      .map((r) => JSON.parse(r));
    expect(rows.map((r) => r.msg_id)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.text)).toEqual(["one", "two", "three"]);
  });

  test("never mutates a line already on disk (append-only)", () => {
    const repo = tempRepo();
    const path = appendInboxLine(repo, {
      msg_id: 1,
      chat_id: 1,
      ts: "t1",
      text: "sacred",
    });
    const afterFirst = readFileSync(path, "utf8");
    appendInboxLine(repo, { msg_id: 2, chat_id: 1, ts: "t2", text: "next" });
    const afterSecond = readFileSync(path, "utf8");
    // The whole first write is a strict prefix of the file after the second.
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
  });

  test("respects an absolute ORCH_INBOX_JSONL override", () => {
    const repo = tempRepo();
    const custom = join(repo, "custom", "mirror.jsonl");
    const path = appendInboxLine(
      repo,
      { msg_id: 1, chat_id: 1, ts: "t", text: "x" },
      custom,
    );
    expect(path).toBe(custom);
    expect(readFileSync(custom, "utf8").trim().length).toBeGreaterThan(0);
  });

  test("weird text with embedded newlines stays one physical line per row", () => {
    const repo = tempRepo();
    appendInboxLine(repo, {
      msg_id: 1,
      chat_id: 1,
      ts: "t1",
      text: "multi\nline\ndirective",
    });
    appendInboxLine(repo, { msg_id: 2, chat_id: 1, ts: "t2", text: "plain" });
    const raw = readFileSync(join(repo, DEFAULT_INBOX_RELATIVE), "utf8");
    // Two rows -> exactly two physical lines (each JSON, newline-escaped).
    expect(raw.trim().split("\n").length).toBe(2);
  });

  test("appends onto a pre-existing file made by another writer", () => {
    const repo = tempRepo();
    const path = resolveInboxPath(repo, undefined);
    // Simulate a file that already exists (e.g. from a prior daemon run).
    const preline =
      serializeInboxLine({ msg_id: 0, chat_id: 1, ts: "t0", text: "prior" });
    require("node:fs").mkdirSync(require("node:path").dirname(path), {
      recursive: true,
    });
    writeFileSync(path, preline);
    appendInboxLine(repo, { msg_id: 1, chat_id: 1, ts: "t1", text: "new" });
    const rows = readFileSync(path, "utf8").trim().split("\n").map((r) => JSON.parse(r));
    expect(rows.map((r) => r.msg_id)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// HR-2486 — the reaction is a receipt meaning "received AND stored"
// ---------------------------------------------------------------------------
// The Human ruled: «якщо на моєму повідомлені є реакція (очі) то я вважаю що ти
// його отримав і зберіг». These locks encode the two halves of that contract
// together, because either one alone is wrong:
//   • a mirror failure must withhold the reaction and ping him loudly, AND
//   • it must never cost him the message — delivery happens either way.
//
// The failure is REAL, not stubbed: ORCH_INBOX_JSONL points at a path whose
// parent is an existing regular file, so mkdirSync throws EEXIST inside the
// production write. (Deliberately not a chmod: these suites run as root, where
// a 0o500 directory is still writable and the "failure" would silently pass.)

// Models handleInbound's real ordering: mirror first, then deliver
// unconditionally, then react ONLY on a stored receipt. Delivery is outside
// every mirror branch on purpose — that is requirement 2 made executable.
function inboundLikeServer(
  repoRoot: string,
  record: InboxRecord,
): {
  receipt: MirrorReceipt;
  delivered: string[];
  reacted: string[];
  pinged: string[];
} {
  const delivered: string[] = [];
  const reacted: string[] = [];
  const pinged: string[] = [];

  const receipt = mirrorInbound(repoRoot, record, (notice) => {
    pinged.push(notice);
  });

  delivered.push(record.text); // never gated on the mirror
  if (receipt.stored === true) reacted.push("👀");

  return { receipt, delivered, reacted, pinged };
}

function blockedInboxPath(repo: string): string {
  // A regular file where the mirror needs a directory.
  const wall = join(repo, "blocked");
  writeFileSync(wall, "not a directory");
  return join(wall, "inbox.jsonl");
}

describe("mirrorInbound — the HR-2486 receipt", () => {
  test("a successful write earns the receipt and pings nobody", () => {
    const repo = tempRepo();
    const result = inboundLikeServer(repo, {
      msg_id: 2486,
      chat_id: 1001,
      ts: "2026-08-05T09:00:00.000Z",
      text: "directive",
    });

    expect(result.receipt.stored).toBe(true);
    expect(result.reacted).toEqual(["👀"]);
    expect(result.pinged).toEqual([]);
    expect(result.delivered).toEqual(["directive"]);

    const rows = readFileSync(join(repo, DEFAULT_INBOX_RELATIVE), "utf8")
      .trim()
      .split("\n")
      .map((r) => JSON.parse(r));
    expect(rows.map((r) => r.msg_id)).toEqual([2486]);
  });

  test("REGRESSION HR-2486: a failed mirror write produces no 👀, pings loudly, and still delivers", () => {
    const repo = tempRepo();
    const previous = process.env.ORCH_INBOX_JSONL;
    process.env.ORCH_INBOX_JSONL = blockedInboxPath(repo);

    try {
      const result = inboundLikeServer(repo, {
        msg_id: 4242,
        chat_id: 1001,
        ts: "2026-08-05T09:01:00.000Z",
        text: "a requirement he must not lose",
      });

      // No receipt: the reaction is withheld.
      expect(result.receipt.stored).toBe(false);
      expect(result.reacted).toEqual([]);

      // Loud, and it names the message id so he knows which one to re-send.
      expect(result.pinged.length).toBe(1);
      expect(result.pinged[0]).toContain("4242");

      // ...and he did NOT lose the message.
      expect(result.delivered).toEqual(["a requirement he must not lose"]);

      // Nothing was written anywhere: no row, and no receipt claiming one.
      expect(existsSync(join(repo, DEFAULT_INBOX_RELATIVE))).toBe(false);
      if (result.receipt.stored === false) {
        expect(result.receipt.error.length).toBeGreaterThan(0);
      }
    } finally {
      if (previous === undefined) delete process.env.ORCH_INBOX_JSONL;
      else process.env.ORCH_INBOX_JSONL = previous;
    }
  });

  test("mirrorInbound never throws, so a caller on the delivery path keeps running", () => {
    const repo = tempRepo();
    const previous = process.env.ORCH_INBOX_JSONL;
    process.env.ORCH_INBOX_JSONL = blockedInboxPath(repo);

    try {
      // The bare call, with no failure sink at all, must still not throw:
      // nothing downstream of it may be skipped by an exception.
      expect(() =>
        mirrorInbound(repo, { msg_id: 1, chat_id: 1, ts: "t", text: "x" }),
      ).not.toThrow();
      // ...whereas the raw append still reports the failure to whoever wants it.
      expect(() =>
        appendInboxLine(repo, { msg_id: 1, chat_id: 1, ts: "t", text: "x" }),
      ).toThrow();
    } finally {
      if (previous === undefined) delete process.env.ORCH_INBOX_JSONL;
      else process.env.ORCH_INBOX_JSONL = previous;
    }
  });

  test("an attachment-only message with no caption still earns a row and a receipt", () => {
    // A photo with no caption is still something he sent, and the file_id
    // (W-15) is exactly what makes it recoverable. It must be storable, so the
    // receipt means the same thing for it as for a text directive.
    const repo = tempRepo();
    const result = inboundLikeServer(repo, {
      msg_id: 77,
      chat_id: 1001,
      ts: "2026-08-05T09:02:00.000Z",
      text: "",
      attachment_kind: "photo",
      attachment_file_id: "PHOTO-FILE-ID",
    });

    expect(result.receipt.stored).toBe(true);
    expect(result.reacted).toEqual(["👀"]);

    const row = JSON.parse(
      readFileSync(join(repo, DEFAULT_INBOX_RELATIVE), "utf8").trim(),
    );
    expect(row.attachment_file_id).toBe("PHOTO-FILE-ID");
    expect(row.msg_id).toBe(77);
  });

  test("the failure notice names the message id and stays short", () => {
    const notice = mirrorFailureNotice(9152);
    expect(notice).toContain("9152");
    expect(notice.split("\n").length).toBeLessThanOrEqual(5);
    // A message with no id still produces a usable notice rather than "undefined".
    expect(mirrorFailureNotice("")).not.toContain("undefined");
  });

  test("a throwing failure sink still cannot reach the delivery path", () => {
    // "never throws" is what allows this call to sit ahead of delivery, so a
    // broken notifier must not take the message down with it. Losing the
    // notification is bad; losing his message is the failure this whole
    // contract exists to prevent.
    const repo = tempRepo();
    const blocked = blockedInboxPath(repo);
    let receipt: MirrorReceipt | undefined;

    expect(() => {
      receipt = mirrorInbound(
        repo,
        { msg_id: 8, chat_id: 1, ts: "t", text: "x" },
        () => {
          throw new Error("telegram is down");
        },
        blocked,
      );
    }).not.toThrow();

    // ...and the receipt is still honest about the write having failed.
    expect(receipt?.stored).toBe(false);
  });

  test("the notice carries no filesystem detail — that belongs on stderr", () => {
    const repo = tempRepo();
    const blocked = blockedInboxPath(repo);
    let notice = "";
    let error = "";
    mirrorInbound(
      repo,
      { msg_id: 5, chat_id: 1, ts: "t", text: "x" },
      (n, e) => {
        notice = n;
        error = e;
      },
      blocked,
    );
    expect(error).toContain("blocked"); // the caller gets the real reason...
    expect(notice).not.toContain(repo); // ...but the chat message does not.
  });
});
