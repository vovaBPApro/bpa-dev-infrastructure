import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDocumentedMissionCli, documentedInvocations } from "./check-documented-mission-cli";

test("repository documentation names only dispatchable mission-cli actions", () => {
  const repo = join(import.meta.dir, "..");
  const files = Bun.spawnSync(["git", "-C", repo, "ls-files", "instructions", "instance"]).stdout.toString().split("\n").filter((file) => file.endsWith(".md"));
  expect(checkDocumentedMissionCli(repo, files)).toEqual([]);
  expect(documentedInvocations(repo, files).length).toBeGreaterThan(0);
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
