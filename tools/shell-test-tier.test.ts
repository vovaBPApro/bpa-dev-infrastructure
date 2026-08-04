import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  acquireShellTierGuard,
  collectStream,
  drain,
  lockAcquireTimeoutMs,
  watchedTestTimeoutMs,
  type ShellTierGuard,
} from "./shell-test-guard";

// This file is the landing-gate executor for the shell-test tier. The gate's
// immutable framework collection includes *.test.ts but not *.test.sh, so the
// explicit inventory below both runs the tier and detects a deleted shell test.
// Do not replace this inventory with a glob: a glob cannot detect deletion.

const repoRoot = join(import.meta.dir, "..");
let tierGuard: ShellTierGuard;

// Every bun timeout in this file is derived by the guard from the bounds it is
// enforcing, never written here as a constant. A constant added locally is how
// round 2 came to arm a 390 s per-test timeout around a watchdog whose worst-case
// detection was 396 s: bun then decided a genuine hang first, with no named
// reason and a `stalled=no` release record. See watchedTestTimeoutMs.
beforeAll(async () => {
  tierGuard = await acquireShellTierGuard(repoRoot);
}, lockAcquireTimeoutMs());

afterAll(async () => {
  await tierGuard?.release();
});

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
  "orchestrator/launch-handshake-bounded.test.sh",
  "orchestrator/singleton-failclosed.test.sh",
  "gate/land-rollback.test.sh",
  "orchestrator/watchdog-supervision.test.sh",
  "orchestrator/fleet/launch-lane.test.sh",
  "orchestrator/watchdog.test.sh",
] as const;

const excludedShellTests = {} as const;

const allShellTests = [...runnableShellTests, ...Object.keys(excludedShellTests)];

test("the independently pinned shell-test inventory still exists", () => {
  expect(allShellTests).toHaveLength(12);
  for (const relativePath of allShellTests) {
    expect(existsSync(join(repoRoot, relativePath)), `${relativePath} is missing`).toBe(true);
  }
});

for (const relativePath of runnableShellTests) {
  test(
    `shell tier: ${relativePath}`,
    async () => {
      // A stall declared while an earlier test was running is terminal for the
      // tier: report it here too rather than spending the budget again.
      tierGuard.assertRunning();
      const env = { ...process.env };
      // gate/land.sh exports BUN_BIN, while nested gate checks reject caller
      // binary selectors. The shell tier must behave the same inside the gate
      // as it does standalone.
      delete env.BUN_BIN;
      const result = Bun.spawn(["bash", relativePath], {
        cwd: repoRoot,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = collectStream(result.stdout);
      const stderr = collectStream(result.stderr);
      const status = await tierGuard.watch(relativePath, result);
      await drain([stdout, stderr]);
      // Distinguish "this test failed" from "the watchdog killed it": the exit
      // status alone cannot, and the partial output still goes to the report.
      const stall = tierGuard.stallReason();
      const output = `${stdout.text()}${stderr.text()}`;
      if (stall) throw new Error(`${stall} test=${relativePath}\n${output}`);
      expect(status, `${relativePath} exited ${status}\n${output}`).toBe(0);
    },
    watchedTestTimeoutMs(),
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
  async () => {
    tierGuard.assertRunning();
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
        "immutable-file,proc-lock-observability,pid-mount-namespace";
      // Spawned asynchronously and watched, like the tier above: a synchronous
      // spawn blocks the loop the stall watchdog runs on, so a child hanging
      // here would be invisible to it.
      const result = Bun.spawn(["bash", file], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      const stdout = collectStream(result.stdout);
      const stderr = collectStream(result.stderr);
      const status = await tierGuard.watch(`capability-exclusions:${file}`, result);
      await drain([stdout, stderr]);
      const stall = tierGuard.stallReason();
      if (stall) throw new Error(`${stall} test=${file}\n${stdout.text()}${stderr.text()}`);
      expect(status, `${file}: ${stdout.text()}${stderr.text()}`).toBe(0);
      for (const line of stdout.text().split("\n")) {
        const match = line.match(/EXCLUDED case=([^ ]+) capability=([^ ]+)$/);
        if (match) observed.push(`${file}\t${match[1]}\t${match[2]}`);
      }
    }
    expect(observed.sort()).toEqual(inventory);
  },
  watchedTestTimeoutMs(),
);
