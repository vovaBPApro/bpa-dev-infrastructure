import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Regression lock for V3-0.51.
//
// The lane agent harness killed a FOREGROUND command at 120000 ms — a bound no
// tracked file named, no lane could see, and nothing reported when it fired.
// This repository's own suite measured 98-155 s across nine runs, so the bound
// sat INSIDE the suite's range: the same command passed or died run to run.
// The kill arrives as SIGTERM (exit 143) with truncated output and no trailing
// summary, and through an unguarded pipe that becomes exit 0 (V3-0.40,
// gate/completion-guard.ts:131) — a truncated green. V3-0.23 chased that
// symptom for four rounds without reproducing it, because it is invisible from
// outside a lane.
//
// The fix is a declaration in instance/lane-agent-command*.conf. What can rot
// is the declaration itself: a new variant conf copied from an old one, or an
// edit that drops the entries, silently restores the inherited default. So the
// lock is not "the current file has the right bytes" — it audits every tracked
// conf, and it proves itself red against a fixture with the bound removed.

const repoRoot = join(import.meta.dir, "../..");
const instanceDir = join(repoRoot, "instance");

// The agent binaries known to honour these entries. A conf naming a different
// binary is reported as unbounded-but-unknown rather than silently passing:
// "we did not measure this CLI" and "this CLI needs no bound" are different
// claims, and only the second one is safe to assume.
const BOUNDED_AGENTS = ["claude"] as const;
const BOUND_VARIABLES = ["BASH_DEFAULT_TIMEOUT_MS", "BASH_MAX_TIMEOUT_MS"] as const;

type ConfAudit = {
  name: string;
  agent: string;
  declared: Record<string, string>;
};

// Same parse as orchestrator/fleet/launch-lane.sh: one argv entry per line,
// blank lines and column-1 comments dropped. When argv[0] is `env`, the
// NAME=VALUE entries that follow are environment assignments and the first
// entry that is not an assignment is the agent binary.
function auditConf(name: string, contents: string): ConfAudit {
  const argv = contents
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const declared: Record<string, string> = {};
  let index = 0;
  if (argv[index] === "env") {
    index += 1;
    while (index < argv.length) {
      const match = argv[index].match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) break;
      declared[match[1]] = match[2];
      index += 1;
    }
  }
  return { name, agent: argv[index] ?? "", declared };
}

function auditConfDir(dir: string): ConfAudit[] {
  return readdirSync(dir)
    .filter((entry) => /^lane-agent-command.*\.conf$/.test(entry))
    .sort()
    .map((entry) => auditConf(entry, readFileSync(join(dir, entry), "utf8")));
}

/** Returns one message per conf that runs under an undeclared bound. */
function undeclaredBounds(audits: ConfAudit[]): string[] {
  const problems: string[] = [];
  for (const audit of audits) {
    if (!BOUNDED_AGENTS.includes(audit.agent as (typeof BOUNDED_AGENTS)[number])) continue;
    for (const variable of BOUND_VARIABLES) {
      if (!audit.declared[variable]) {
        problems.push(`${audit.name} does not declare ${variable}`);
      }
    }
  }
  return problems;
}

test("every tracked lane agent command conf declares its foreground bound", () => {
  const audits = auditConfDir(instanceDir);
  expect(audits.length, "no lane agent command conf was found").toBeGreaterThan(0);
  expect(undeclaredBounds(audits)).toEqual([]);
});

test("the fixture proving this lock red: a conf with the bound removed is rejected", () => {
  // Fail-before evidence, kept executable rather than described. This is the
  // exact shape of instance/lane-agent-command.conf before V3-0.51 landed.
  const scratch = mkdtempSync(join(tmpdir(), "lane-agent-command-bound-"));
  try {
    writeFileSync(
      join(scratch, "lane-agent-command.conf"),
      ["# comment column 1 is data, not argv", "env", "IS_SANDBOX=1", "claude", "--print", ""].join(
        "\n",
      ),
    );
    const problems = undeclaredBounds(auditConfDir(scratch));
    expect(problems).toEqual([
      "lane-agent-command.conf does not declare BASH_DEFAULT_TIMEOUT_MS",
      "lane-agent-command.conf does not declare BASH_MAX_TIMEOUT_MS",
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("every conf that declares a bound declares the same one", () => {
  const audits = auditConfDir(instanceDir);
  for (const variable of BOUND_VARIABLES) {
    const values = new Set(
      audits.map((audit) => audit.declared[variable]).filter((value) => value !== undefined),
    );
    expect(
      values.size,
      `${variable} drifted across confs: ${[...values].join(", ")}`,
    ).toBeLessThanOrEqual(1);
  }
});

test("the declared bound clears the longest bound a lane's own gate enforces", () => {
  // The invariant that matters, and the one most likely to rot silently: a
  // harness bound tighter than an inner mechanism's own timeout replaces that
  // mechanism's honest timeout report with a truncated kill, so the inner bound
  // never fires. gate/land-lib.sh runs the meteorite prover under its own
  // timeout; raising THAT without raising this one re-opens the defect, and
  // this assertion is what makes the two files fail together instead.
  const landLib = readFileSync(join(repoRoot, "gate", "land-lib.sh"), "utf8");
  const meteorite = landLib.match(/LAND_METEORITE_TIMEOUT_SECONDS:-([0-9]+)/);
  expect(meteorite, "gate/land-lib.sh no longer declares a meteorite timeout").not.toBeNull();
  const meteoriteMs = Number(meteorite![1]) * 1000;

  const audits = auditConfDir(instanceDir).filter((audit) =>
    BOUNDED_AGENTS.includes(audit.agent as (typeof BOUNDED_AGENTS)[number]),
  );
  expect(audits.length).toBeGreaterThan(0);
  for (const audit of audits) {
    for (const variable of BOUND_VARIABLES) {
      const declared = Number(audit.declared[variable]);
      expect(Number.isInteger(declared), `${audit.name}: ${variable} is not an integer`).toBe(true);
      expect(
        declared,
        `${audit.name}: ${variable}=${declared} does not clear the ${meteoriteMs} ms meteorite bound`,
      ).toBeGreaterThan(meteoriteMs);
    }
  }
});
