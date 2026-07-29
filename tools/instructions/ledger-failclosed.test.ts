import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInboxAging } from "./ledger.ts";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function repoWithInbox(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "ledger-failclosed-"));
  temporaryDirectories.push(root);
  const decisions = join(root, "instance", "decisions");
  mkdirSync(decisions, { recursive: true });
  writeFileSync(join(decisions, "inbox.jsonl"), contents);
  return root;
}

describe("inbox JSONL fails closed", () => {
  test("malformed complete lines and invalid timestamps cannot produce PASS", () => {
    const malformed = repoWithInbox(
      '{"msg_id":700,"ts":"2026-07-29T10:00:00.000Z"}\n' +
        '{"msg_id":701,"ts":"truncated"\n',
    );
    const malformedFindings = checkInboxAging(malformed, NOW, true);
    expect(
      malformedFindings.some(
        (finding) =>
          finding.level === "FAIL" &&
          finding.file === "instance/decisions/inbox.jsonl:2" &&
          finding.detail.includes("malformed JSON"),
      ),
    ).toBe(true);
    expect(malformedFindings.some((finding) => finding.level === "PASS")).toBe(false);

    const invalidTimestamp = repoWithInbox(
      '{"msg_id":777,"ts":"not-a-date","text":"binding human directive"}\n',
    );
    const timestampFindings = checkInboxAging(invalidTimestamp, NOW, true);
    expect(
      timestampFindings.some(
        (finding) =>
          finding.level === "FAIL" &&
          finding.file === "inbox.jsonl:msg 777" &&
          finding.detail.includes("timestamp"),
      ),
    ).toBe(true);
    expect(timestampFindings.some((finding) => finding.level === "PASS")).toBe(false);
  });

  test("well-formed fresh ledger still passes without a false alarm", () => {
    const root = repoWithInbox(
      '{"msg_id":778,"ts":"2026-07-29T10:00:00.000Z","text":"fresh"}\n',
    );
    const findings = checkInboxAging(root, NOW, true);
    expect(findings).toEqual([
      {
        level: "PASS",
        file: "instance/decisions/inbox.jsonl",
        detail: "1 rows, none aged untriaged",
      },
    ]);
  });
});
