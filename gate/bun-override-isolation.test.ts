import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// Named regression lock for the "flaky" stale-lock rollback test.
//
// gate/land.sh, gate/lane-exit.sh and orchestrator/fleet/lane-payload.sh all
// call land_resolve_bun, which REFUSES an inherited BUN_BIN outright:
//
//   LAND step=preflight status=fail detail=caller-bun-override-refused
//
// and exits 2 before the invocation reaches any later step. Those same
// wrappers EXPORT BUN_BIN. So a gate shell test that drives one of those entry
// points behaves differently depending on WHO RAN IT: a human running it from
// a shell passes no BUN_BIN and the test passes, while the same test run from a
// lane's `verify:` chain at lane exit -- or from the landing gate's own
// post-merge verify -- inherits one and fails at the first nested invocation.
//
// That is what made gate/land-rollback.test.sh read as load-dependent. It is
// not a race: three consecutive landings failed and every idle reproduction
// passed, because the failing runs went through a gate wrapper and the passing
// ones did not. The failure surfaces as an assertion naming a MISSING output
// line ("LAND step=post-merge-verify status=fail"), never as the refusal that
// caused it, so the message points away from the cause.
//
// The fix is one line per fixture -- `unset BUN_BIN`, as gate/land.test.sh:3
// has carried all along -- and this file locks it so the next such test cannot
// be added without it.

const repoRoot = join(import.meta.dir, "..");

// Entry points whose preflight refuses a caller-supplied BUN_BIN. Explicit, so
// that deleting one is a visible failure rather than a silently shorter scan.
const gateEntryPoints = [
  "gate/land.sh",
  "gate/lane-exit.sh",
  "orchestrator/fleet/lane-payload.sh",
] as const;

// Shell tests that drive one of the entry points above and therefore MUST own
// their own environment. Explicit for the same reason: a glob cannot detect a
// deletion, and this inventory going stale is itself the regression.
const mustNeutralizeBunOverride = [
  "gate/land.test.sh",
  "gate/land-rollback.test.sh",
  "gate/land-target-branch.test.sh",
  "gate/lane-exit.test.sh",
] as const;

const neutralizesBunOverride = (source: string) =>
  /^[ \t]*unset[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*[ \t]+)*BUN_BIN\b/m.test(source);

const referencesGateEntryPoint = (source: string) =>
  gateEntryPoints.some((entry) => source.includes(entry));

// Referencing an entry point is not the same as EXECUTING one, and bash is not
// statically analysable enough to tell the two apart. These two name an entry
// point without ever handing it the caller's environment; both were measured
// passing with BUN_BIN deliberately set. Listing them (rather than loosening
// the scan) keeps the triage decision visible and forces a newly added test to
// be judged rather than silently skipped.
const measuredImmune: Record<string, string> = {
  "orchestrator/fleet/launch-lane.test.sh":
    "only asserts that the payload path appears in recorded systemd args; never executes it",
  "orchestrator/fleet/lane-payload-systemd.test.sh":
    "drives the payload through systemd with a stand-in for gate/lane-exit.sh, so no caller environment reaches a real entry point",
};

test("every entry point named by this lock still refuses a caller BUN_BIN", () => {
  for (const entry of gateEntryPoints) {
    const path = join(repoRoot, entry);
    expect(existsSync(path), `${entry} is missing`).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(
      source.includes("land_resolve_bun"),
      `${entry} no longer calls land_resolve_bun; this lock's premise moved`,
    ).toBe(true);
  }
});

test("gate shell tests that drive a gate entry point neutralize an inherited BUN_BIN", () => {
  for (const relativePath of mustNeutralizeBunOverride) {
    const path = join(repoRoot, relativePath);
    expect(existsSync(path), `${relativePath} is missing`).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(
      neutralizesBunOverride(source),
      `${relativePath} drives a gate entry point but does not 'unset BUN_BIN'. ` +
        `Run under a gate wrapper it will fail at preflight with ` +
        `caller-bun-override-refused, and the assertion message will name a ` +
        `missing output line instead of the refusal.`,
    ).toBe(true);
  }
});

// The inventory above detects deletion; this scan detects ADDITION -- a new
// shell test that drives an entry point without owning its environment.
test("no unlisted shell test drives a gate entry point without neutralizing BUN_BIN", () => {
  const shellTests: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".test.sh")) shellTests.push(full);
    }
  };
  walk(repoRoot);

  const offenders = shellTests
    .map((full) => relative(repoRoot, full))
    .filter((path) => {
      const source = readFileSync(join(repoRoot, path), "utf8");
      if (!referencesGateEntryPoint(source) || neutralizesBunOverride(source)) return false;
      return !(path in measuredImmune);
    });

  expect(
    offenders,
    `these shell tests reference a gate entry point but neither 'unset BUN_BIN' ` +
      `nor appear in measuredImmune: ${offenders.join(", ")}. Run each with ` +
      `BUN_BIN set: if it fails, add the unset line; if it passes, add it to ` +
      `measuredImmune with the reason it never hands an entry point the caller's environment.`,
  ).toEqual([]);
});

test("every measuredImmune entry still exists and still carries a reason", () => {
  for (const [path, reason] of Object.entries(measuredImmune)) {
    expect(existsSync(join(repoRoot, path)), `${path} is missing`).toBe(true);
    expect(reason.trim().length, `${path} has an empty reason`).toBeGreaterThan(0);
  }
});

// The static checks above are only as good as their correspondence to real
// behavior, so one entry point is exercised end to end with a BUN_BIN
// deliberately set. gate/lane-exit.test.sh is the cheapest of the affected
// tests (~2s); running the whole affected set here would add ~20s to every
// landing for no additional class coverage.
test(
  "gate/lane-exit.test.sh passes when its caller exports BUN_BIN",
  () => {
    const bun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" });
    expect(bun.status, "bun must be resolvable to run this lock").toBe(0);
    const result = spawnSync("bash", ["gate/lane-exit.test.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, BUN_BIN: bun.stdout.trim() },
    });
    expect(
      result.status,
      `gate/lane-exit.test.sh exited ${result.status} with BUN_BIN exported\n` +
        `${result.stdout}${result.stderr}`,
    ).toBe(0);
  },
  120_000,
);
