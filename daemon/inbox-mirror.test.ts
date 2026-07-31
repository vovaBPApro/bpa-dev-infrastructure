import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INBOX_RELATIVE,
  appendInboxLine,
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
