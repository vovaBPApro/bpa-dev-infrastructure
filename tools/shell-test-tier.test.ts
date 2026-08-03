import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// This file is the landing-gate executor for the shell-test tier. The gate's
// immutable framework collection includes *.test.ts but not *.test.sh, so the
// explicit inventory below both runs the tier and detects a deleted shell test.
// Do not replace this inventory with a glob: a glob cannot detect deletion.

const repoRoot = join(import.meta.dir, "..");

const runnableShellTests = [
  "bootstrap/bootstrap.test.sh",
  "bootstrap/provision-service-user.test.sh",
  "gate/land.test.sh",
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

test("shell fixtures cannot claim host-global refs, locks, or ports", () => {
  for (const relativePath of runnableShellTests) {
    const source = readFileSync(join(repoRoot, relativePath), "utf8");

    // A fixture may manipulate refs only inside a repository rooted in its
    // private temporary directory. The fleet launcher used to point --repo at
    // the shared checkout and race on refs/heads/ag-fleet-launch-proof.
    for (const match of source.matchAll(/--repo\s+["']?\$([A-Z][A-Z0-9_]*)["']?/g)) {
      const variable = match[1];
      const assignment = source.match(
        new RegExp(`^${variable}=[^\\n]+$`, "m"),
      )?.[0];
      expect(
        assignment,
        `${relativePath} must derive launcher repository ${variable} from private SCRATCH`,
      ).toContain("$SCRATCH");
    }

    // A disposable clone can inherit a fixture branch from its source. Require
    // every explicit launcher ref to be allocated through a per-run variable;
    // a literal ref merely relocates the original global-name collision.
    if (relativePath === "orchestrator/fleet/launch-lane.test.sh") {
      expect(source, `${relativePath} contains a fixed fixture ref`).not.toMatch(
        /--branch\s+["']?[A-Za-z0-9][A-Za-z0-9._/-]*/,
      );
    }

    // Lock files must be derived from private fixture state, never a fixed
    // host path. TMPDIR itself is caller-controlled and therefore not private.
    expect(source, `${relativePath} contains a fixed host-global lock path`).not.toMatch(
      /(?:^|[="' ])(?:\/tmp|\/run|\/var\/lock|\$\{?TMPDIR\}?)[^\n"']*\.(?:lock|lck)(?:["' ]|$)/m,
    );

    // Reject literal listening/published ports. Ephemeral allocation (port 0)
    // or a port recorded below a private fixture root remains allowed.
    expect(source, `${relativePath} claims a fixed TCP port`).not.toMatch(
      /\b(?:listen|--listen|-p|--publish)\b[^\n]*(?:[1-9][0-9]{2,4})\b/,
    );
  }
});

test("the independently pinned shell-test inventory still exists", () => {
  expect(allShellTests).toHaveLength(11);
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
        "immutable-file,proc-lock-observability,pid-mount-namespace";
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
