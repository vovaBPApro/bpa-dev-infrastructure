import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// This file is the landing-gate executor for the shell-test tier. The gate's
// immutable framework collection includes *.test.ts but not *.test.sh, so the
// explicit inventory below both runs the tier and detects a deleted shell test.
// Do not replace this inventory with a glob: a glob cannot detect deletion.

const repoRoot = join(import.meta.dir, "..");

const requiredTypeScriptExecutors = [
  "tools/check-mechanism-reachability.test.ts",
  "tools/check-documented-mission-cli.test.ts",
] as const;

test("independently pinned TypeScript gate executors still exist", () => {
  for (const relativePath of requiredTypeScriptExecutors) {
    expect(existsSync(join(repoRoot, relativePath)), `${relativePath} is missing`).toBe(true);
  }
});

const runnableShellTests = [
  "bootstrap/bootstrap.test.sh",
  "bootstrap/provision-service-user.test.sh",
  "gate/land.test.sh",
  "gate/meteorite-gate.test.sh",
  "gate/land-target-branch.test.sh",
  "gate/lane-exit.test.sh",
  "gate/push-guard.test.sh",
  "orchestrator/launch-handshake-bounded.test.sh",
  "orchestrator/singleton-failclosed.test.sh",
  "gate/land-rollback.test.sh",
  "orchestrator/watchdog-supervision.test.sh",
  "orchestrator/fleet/launch-lane.test.sh",
  "orchestrator/fleet/lane-payload-systemd.test.sh",
  "orchestrator/fleet/lane-unit-namespace.test.sh",
  "orchestrator/watchdog.test.sh",
  "orchestrator/fleet/fleet-nudge.test.sh",
  "orchestrator/fleet/fleet-nudge-liveness.test.sh",
] as const;

const excludedShellTests = {} as const;

const allShellTests = [...runnableShellTests, ...Object.keys(excludedShellTests)];

test("the independently pinned shell-test inventory still exists", () => {
  expect(allShellTests).toHaveLength(16);
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
  expect(Object.keys(excludedShellTests)).toEqual([]);
  for (const reason of Object.values(excludedShellTests)) {
    expect(reason.trim().length).toBeGreaterThan(0);
  }
});

test(
  "runtime capability exclusions exactly match the independently pinned inventory",
  () => {
    const inventory = readFileSync(
      join(repoRoot, "instance/expected-shell-capability-exclusions.tsv"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("\t"))
      .map(([file, caseName, capability]) => `${file}\t${caseName}\t${capability}`)
      .sort();
    const byFile = new Map<string, string[]>();
    for (const row of inventory) {
      const [file] = row.split("\t");
      byFile.set(file, [...(byFile.get(file) ?? []), row]);
    }
    const observed: string[] = [];
    for (const [file] of byFile) {
      const env = { ...process.env };
      delete env.BUN_BIN;
      env.INFRA_TEST_FORCE_MISSING_CAPABILITIES =
        "immutable-file,proc-lock-observability,pid-mount-namespace,systemd-transient-unit";
      const result = spawnSync("bash", [file], { cwd: repoRoot, encoding: "utf8", env });
      expect(result.status, `${file}: ${result.stdout}${result.stderr}`).toBe(0);
      for (const line of result.stdout.split("\n")) {
        const match = line.match(/EXCLUDED case=([^ ]+) capability=([^ ]+)$/);
        if (match) observed.push(`${file}\t${match[1]}\t${match[2]}`);
      }
    }
    expect(observed.sort()).toEqual(inventory);
  },
  120_000,
);
