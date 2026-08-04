import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocumentedLand, checkDocumentedMissionCli, documentedInvocations, documentedLandInvocations, mandatoryLandFlags } from "./check-documented-mission-cli";

test("repository documentation names only dispatchable mission-cli actions", () => {
  const repo = join(import.meta.dir, "..");
  const files = Bun.spawnSync(["git", "-C", repo, "ls-files", "instructions", "instance"]).stdout.toString().split("\n").filter((file) => file.endsWith(".md"));
  expect(checkDocumentedMissionCli(repo, files)).toEqual([]);
  const invocations = documentedInvocations(repo, files);
  expect(invocations.length).toBe(7);
  expect(invocations).toContainEqual({ file: "instructions/orchestrator-cold-start.md", line: 154, group: "lane", action: "complete" });
  expect(invocations).toContainEqual({ file: "instructions/orchestrator-cold-start.md", line: 262, group: "mission", action: "complete" });
  const executed = Bun.spawnSync([process.execPath, "tools/check-documented-mission-cli.ts", "--repo", repo], { cwd: repo });
  expect(executed.exitCode, executed.stderr.toString()).toBe(0);
});

test("a fabricated documented action is rejected without matching prose", () => {
  const repo = mkdtempSync(join(tmpdir(), "documented-mission-cli-"));
  try {
    writeFileSync(join(repo, "fixture.md"), ["The mission transition design is prose.", "`core/mission-cli.ts mission fabricated` is prose.", "INFRA_STATE_DB=x bun \"$REPO/core/mission-cli.ts\" mission fabricated \"$ID\""].join("\n"));
    expect(checkDocumentedMissionCli(repo, ["fixture.md"])).toEqual(["fixture.md:3: undocumented CLI action mission fabricated"]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("a fabricated action across a shell continuation is rejected at its command line", () => {
  const repo = mkdtempSync(join(tmpdir(), "documented-mission-cli-wrapped-"));
  try {
    writeFileSync(join(repo, "fixture.md"), [
      "```sh",
      "INFRA_STATE_DB=x bun \"$REPO/core/mission-cli.ts\" \\",
      "  mission fabricated \"$ID\"",
      "```",
    ].join("\n"));
    expect(checkDocumentedMissionCli(repo, ["fixture.md"])).toEqual([
      "fixture.md:2: undocumented CLI action mission fabricated",
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// instance/workboard.md V3-0.15 F4: the cold-start document twice shipped a
// `gate/land.sh` invocation that the gate refuses at usage, because nothing
// checked the documented landing command -- only the mission-cli calls.
function landFixture(usage: string, doc: string[]): string {
  const repo = mkdtempSync(join(tmpdir(), "documented-land-"));
  mkdirSync(join(repo, "gate"), { recursive: true });
  writeFileSync(join(repo, "gate", "land.sh"), `#!/usr/bin/env bash\n  echo "${usage}" >&2\n`);
  writeFileSync(join(repo, "fixture.md"), doc.join("\n"));
  return repo;
}

test("repository documentation invokes gate/land.sh with every flag the gate makes mandatory", () => {
  const repo = join(import.meta.dir, "..");
  const files = Bun.spawnSync(["git", "-C", repo, "ls-files", "instructions", "instance"]).stdout.toString().split("\n").filter((file) => file.endsWith(".md"));
  expect(mandatoryLandFlags(repo)).toEqual(["--branch", "--item-id", "--report", "--repo"]);
  expect(checkDocumentedLand(repo, files)).toEqual([]);
  const invocations = documentedLandInvocations(repo, files);
  expect(invocations.length).toBe(1);
  expect(invocations[0]).toMatchObject({ file: "instructions/orchestrator-cold-start.md" });
  expect(invocations[0]!.text).toContain("--item-id");
});

test("a documented gate/land.sh invocation omitting a mandatory flag is rejected at its starting line", () => {
  const repo = landFixture("usage: gate/land.sh --branch <ag-name> --item-id <mission/acceptance-id> --report <file> --repo <path> [--worktree <path>] [--run-verify]", [
    "```sh",
    "\"$LAND_REPO/gate/land.sh\" \\",
    "  --branch \"$BRANCH\" \\",
    "  --report \"$REPORT_FILE\" \\",
    "  --repo \"$LAND_REPO\" \\",
    "  --run-verify",
    "```",
  ]);
  try {
    expect(checkDocumentedLand(repo, ["fixture.md"])).toEqual([
      "fixture.md:2: documented gate/land.sh invocation omits mandatory --item-id",
    ]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// The exclusion is honest scoping, matching the mission-cli lock: a reference
// an operator reads is not a command an operator pastes.
test("a prose mention of gate/land.sh outside a shell fence is not an invocation", () => {
  const repo = landFixture("usage: gate/land.sh --branch <ag-name> --item-id <id> --report <file> --repo <path>", [
    "Land only through `gate/land.sh` after required review.",
    "The gate is gate/land.sh and it runs the suite.",
    "```text",
    "\"$LAND_REPO/gate/land.sh\" --branch \"$BRANCH\"",
    "```",
  ]);
  try {
    expect(documentedLandInvocations(repo, ["fixture.md"])).toEqual([]);
    expect(checkDocumentedLand(repo, ["fixture.md"])).toEqual([]);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
