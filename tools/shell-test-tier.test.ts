import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

// This file is the landing-gate executor for the shell-test tier. The gate's
// immutable framework collection includes *.test.ts but not *.test.sh, so the
// explicit inventory below both runs the tier and detects a deleted shell test.
// Do not replace this inventory with a glob: a glob cannot detect deletion.

const repoRoot = join(import.meta.dir, "..");

const runnableShellTests = [
  "bootstrap/bootstrap.test.sh",
  "gate/land.test.sh",
  "gate/land-target-branch.test.sh",
  "gate/lane-exit.test.sh",
  "orchestrator/launch-handshake-bounded.test.sh",
  "orchestrator/singleton-failclosed.test.sh",
  "gate/land-rollback.test.sh",
  "orchestrator/watchdog-supervision.test.sh",
] as const;

const excludedShellTests = {
  "orchestrator/watchdog.test.sh":
    "exit 1: mission-cli status exposes snake_case missions, omits lane updatedAt and leases, so watchdog cannot measure mission pressure",
} as const;

const allShellTests = [...runnableShellTests, ...Object.keys(excludedShellTests)];

test("the independently pinned shell-test inventory still exists", () => {
  expect(allShellTests).toHaveLength(9);
  for (const relativePath of allShellTests) {
    expect(existsSync(join(repoRoot, relativePath)), `${relativePath} is missing`).toBe(true);
  }
});

for (const relativePath of runnableShellTests) {
  test(
    `shell tier: ${relativePath}`,
    () => {
      const env = { ...process.env };
      // gate/land.sh exports BUN_BIN, while nested gate checks reject caller
      // binary selectors. The shell tier must behave the same inside the gate
      // as it does standalone.
      delete env.BUN_BIN;
      const result = spawnSync("bash", [relativePath], {
        cwd: repoRoot,
        encoding: "utf8",
        env,
      });
      expect(
        result.status,
        `${relativePath} exited ${result.status}\n${result.stdout}${result.stderr}`,
      ).toBe(0);
    },
    120_000,
  );
}

test("excluded shell tests are named and reasoned", () => {
  expect(Object.keys(excludedShellTests)).toEqual(["orchestrator/watchdog.test.sh"]);
  for (const reason of Object.values(excludedShellTests)) {
    expect(reason.trim().length).toBeGreaterThan(0);
  }
});
