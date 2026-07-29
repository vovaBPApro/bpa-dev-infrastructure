import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDOFF_MAX_AGE_MS,
  buildHandoff,
  latestHandoffPath,
  validateHandoff,
  writeHandoff,
} from "./handoff.ts";

const temporaryDirectories: string[] = [];
const cli = join(import.meta.dir, "handoff.ts");

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "handoff-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "instance", "decisions"), { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  writeFileSync(join(root, "tracked"), "x\n");
  execFileSync("git", ["-C", root, "add", "tracked"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

function values(ts = "2026-07-29T12:00:00.000Z") {
  return {
    ts,
    from: "claude-orchestrator",
    to: "gpt-orchestrator",
    fromVendor: "anthropic",
    fromSession: "session-a",
    toVendor: "openai",
    toSession: "session-b",
  };
}

describe("handoff write/validate", () => {
  test("round trip collects SHA, worktrees, reports, and pending decisions", () => {
    const root = repo();
    const reports = join(root, "reports");
    mkdirSync(reports);
    writeFileSync(join(reports, "lane.md"), "terminal report\n");
    writeFileSync(
      join(root, "instance", "decisions", "HR-1.md"),
      "---\nid: hr-1\nstate: pending\n---\nopen\n",
    );
    writeFileSync(
      join(root, "instance", "decisions", "HR-2.md"),
      "---\nid: hr-2\nstate: routed\n---\nclosed\n",
    );

    const handoff = buildHandoff(root, reports, values());
    const path = writeHandoff(root, handoff);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.source_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(saved.worktrees).toHaveLength(1);
    expect(saved.unlanded_reports).toEqual([join(reports, "lane.md")]);
    expect(saved.open_decisions).toEqual([{ id: "hr-1", path: "instance/decisions/HR-1.md" }]);
    expect(validateHandoff(saved, Date.parse(values().ts) + 1_000).valid).toBe(true);
    expect(latestHandoffPath(root)).toBe(path);
  });

  test("CLI write then CLI validate succeeds with deterministic clock", () => {
    const root = repo();
    const reports = join(root, "reports");
    mkdirSync(reports);
    const write = spawnSync("bun", [
      cli, "write", "--repo", root, "--reports-dir", reports, "--ts", values().ts,
      "--from", "claude", "--to", "gpt", "--from-vendor", "anthropic",
      "--from-session", "a", "--to-vendor", "openai", "--to-session", "b",
    ], { encoding: "utf8" });
    expect(write.status).toBe(0);
    const path = join(root, write.stdout.trim());
    const validate = spawnSync("bun", [
      cli, "validate", "--file", path, "--now-ms", String(Date.parse(values().ts) + 5_000),
    ], { encoding: "utf8" });
    expect(validate.status).toBe(0);
    expect(validate.stdout).toContain("schema valid, fresh");
  });

  test("stale handoff fails freshness validation", () => {
    const root = repo();
    const handoff = buildHandoff(root, join(root, "missing-reports"), values());
    const result = validateHandoff(handoff, Date.parse(values().ts) + HANDOFF_MAX_AGE_MS + 1);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("stale");
  });

  test("missing required schema fields fail validation", () => {
    const result = validateHandoff(
      { schema_version: 1, timestamp: values().ts },
      Date.parse(values().ts),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("source_sha must be a non-empty string");
    expect(result.errors).toContain("worktrees must be an array");
  });

  test("future timestamp and duplicate filename are rejected", () => {
    const root = repo();
    const handoff = buildHandoff(root, join(root, "reports"), values());
    expect(validateHandoff(handoff, Date.parse(values().ts) - 1).errors.join(" ")).toContain("future");
    writeHandoff(root, handoff);
    expect(() => writeHandoff(root, handoff)).toThrow();
  });
});
