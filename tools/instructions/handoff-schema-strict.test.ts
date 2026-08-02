import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHandoff } from "./handoff.ts";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-29T12:00:00.000Z";
const nowMs = Date.parse(timestamp);
const documentedMaxStringLength = 4_096;
const documentedMaxArrayItems = 1_000;
const documentedMaxBytes = 1_048_576;

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function validHandoff() {
  return {
    schema_version: 1,
    source_sha: "a".repeat(40),
    timestamp,
    from: "claude-orchestrator",
    to: "gpt-orchestrator",
    from_vendor: "anthropic",
    from_session: "session-a",
    to_vendor: "openai",
    to_session: "session-b",
    worktrees: [{ path: "/tmp/lane", head: "b".repeat(40), branch: "ag-lane" }],
    unlanded_reports: ["/tmp/report.md"],
    open_decisions: [{ id: "hr-1", path: "instance/decisions/HR-1.md" }],
  };
}

describe("handoff schema strictness and resource bounds", () => {
  test("accepts a genuine in-bounds handoff", () => {
    expect(validateHandoff(validHandoff(), nowMs)).toEqual({ valid: true, errors: [], ageMs: 0 });
  });

  test("rejects an unknown top-level property", () => {
    expect(validateHandoff({ ...validHandoff(), unexpected: "schema forbids me" }, nowMs).valid).toBe(false);
  });

  test("rejects an unknown nested property", () => {
    const handoff = validHandoff();
    Object.assign(handoff.worktrees[0], { unexpected: true });
    expect(validateHandoff(handoff, nowMs).valid).toBe(false);
  });

  test("rejects strings and arrays above their documented ceilings", () => {
    const longString = { ...validHandoff(), from: "x".repeat(documentedMaxStringLength + 1) };
    expect(validateHandoff(longString, nowMs).valid).toBe(false);

    const longArray = {
      ...validHandoff(),
      unlanded_reports: Array.from({ length: documentedMaxArrayItems + 1 }, () => "/tmp/report.md"),
    };
    expect(validateHandoff(longArray, nowMs).valid).toBe(false);
  });

  test("rejects an aggregate encoded handoff above the byte ceiling", () => {
    const handoff = {
      ...validHandoff(),
      unlanded_reports: Array.from({ length: 300 }, () => "x".repeat(documentedMaxStringLength)),
    };
    expect(validateHandoff(handoff, nowMs).valid).toBe(false);
  });

  test("CLI refuses a handoff file above the pre-parse byte ceiling", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-strict-"));
    temporaryDirectories.push(root);
    const path = join(root, "oversized.json");
    const handoff = { ...validHandoff(), from: "x".repeat(documentedMaxBytes) };
    writeFileSync(path, JSON.stringify(handoff));
    const result = spawnSync("bun", [
      join(import.meta.dir, "handoff.ts"), "validate", "--file", path, "--now-ms", String(nowMs),
    ], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("byte ceiling");
  });
});
