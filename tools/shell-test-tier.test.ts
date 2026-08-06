import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// This file is the landing-gate executor for the shell-test tier. The gate's
// immutable framework collection includes *.test.ts but not *.test.sh, so the
// explicit inventory below both runs the tier and detects a deleted shell test.
// Do not replace this inventory with a glob: a glob cannot detect deletion.
//
// The second, independent record of that inventory is tools/expected-shell-test-tier.tsv,
// one path per line. It is deliberately not an aggregate count: a count is
// merge-blind, and that is measured, not theoretical — see the file's header.

const repoRoot = join(import.meta.dir, "..");

const requiredTypeScriptExecutors = [
  "tools/check-mechanism-reachability.test.ts",
  "tools/check-documented-mission-cli.test.ts",
  // The board checker (V3-0.43). The gate's collection is a glob, so this file
  // already RUNS; what a glob cannot do is notice it stopped existing. Deleting
  // it would take the workboard back to having no reader at all -- the exact
  // state in which `e0cd52b` committed a corrupted board and passed the gate.
  //
  // Registered by entry only, matching the two above: this list has no second
  // independent record, so deleting a file TOGETHER with its line here is still
  // silently green. That gap is pre-existing and covers all three entries; the
  // fix has the shape the shell tier already uses -- a line-per-entry .tsv --
  // and belongs with that inventory, not to this row. An aggregate count is
  // explicitly NOT the fix: it is merge-blind, which is why the shell tier
  // stopped using one.
  "tools/check-workboard-shape.test.ts",
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
  "orchestrator/fleet/launch-lane-cap.test.sh",
  "orchestrator/fleet/lane-payload-systemd.test.sh",
  "orchestrator/fleet/lane-unit-namespace.test.sh",
  "orchestrator/watchdog.test.sh",
  "orchestrator/fleet/fleet-nudge.test.sh",
  "orchestrator/fleet/fleet-nudge-liveness.test.sh",
  // V3-5.6. Both locks below guard launch.sh's fail-closed mechanism wiring,
  // and both were unreachable from this inventory when they were written — a
  // lock nothing runs is the same class of defect as a relay nothing wired.
  // heartbeat-writer.test.sh is new here; session-hook-wiring.test.sh landed
  // with V3-5.2 r2 and had never been registered, so nothing in the gate ran it.
  "orchestrator/heartbeat-writer.test.sh",
  "orchestrator/session-hook-wiring.test.sh",
  // V3-5.27. The landing path's own reproducibility from a bare clone: the gate
  // supplies its committer identity instead of inheriting the canonical
  // checkout's, and every ref the rebuild proof dereferences is resolved or
  // refused by name. Both gaps were measured landing from a fresh clone on
  // 2026-08-06 and both were invisible to every existing lock, because every
  // other gate fixture configures an identity before it runs the gate.
  "gate/land-bare-clone.test.sh",
] as const;

const excludedShellTests = {} as const;

const allShellTests = [...runnableShellTests, ...Object.keys(excludedShellTests)];

function readPinnedInventory(): string[] {
  return readFileSync(join(repoRoot, "tools/expected-shell-test-tier.tsv"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

test("the independently pinned shell-test inventory still exists", () => {
  const pinned = readPinnedInventory();
  // Fail closed: an emptied or comment-only pin must never read as agreement.
  expect(pinned.length).toBeGreaterThan(0);
  expect(new Set(allShellTests).size, "the tier inventory names a shell test twice").toBe(
    allShellTests.length,
  );
  expect(new Set(pinned).size, "the pin names a shell test twice").toBe(pinned.length);
  expect([...allShellTests].sort()).toEqual([...pinned].sort());
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
