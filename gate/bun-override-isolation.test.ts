import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

// Named regression lock for the "flaky" stale-lock rollback test.
//
// gate/land.sh:153 and gate/lane-exit.sh:80 call land_resolve_bun, which
// REFUSES an inherited BUN_BIN outright:
//
//   LAND step=preflight status=fail detail=caller-bun-override-refused
//
// and exits 2 before the invocation reaches any later step. Those are the only
// two call sites in the tree. On success the same function EXPORTS BUN_BIN
// (gate/land-lib.sh:146-147), and the two places a report's `verify:` command
// is executed both hand that exported value straight through:
//
//   gate/land.sh:761        (cd "$repo" && sh -c "$verify_command")  -- no scrub
//   gate/completion-guard.ts:152  spawnSync(command, {...}) with no `env`, so
//                                 process.env including BUN_BIN is inherited
//
// So a gate shell test behaves differently depending on WHO RAN IT: a human
// running it from a shell passes no BUN_BIN and it passes, while the same test
// reached through a report's `verify:` chain inherits one and fails at the
// first nested invocation. The landing gate's shell tier is NOT that path --
// tools/shell-test-tier.test.ts:61 deletes BUN_BIN before spawning each shell
// test and always has. The leak reaches these tests through `verify:`.
//
// That is what made gate/land-rollback.test.sh read as load-dependent. It is
// not a race: the failing runs went through a gate wrapper and the passing ones
// did not. The failure surfaces as an assertion naming a MISSING output line
// ("LAND step=post-merge-verify status=fail"), never as the refusal that caused
// it, so the message points away from the cause.
//
// The fix is one line per fixture -- `unset BUN_BIN`, as gate/land.test.sh:3
// has carried all along -- and this file locks it so the next such test cannot
// be added without it.
//
// Round 2 note (review of f2a4aab). Two of this file's assertions were
// themselves false greens and are rewritten below: the premise assertion was a
// substring match satisfied by a COMMENT, and the tree scan matched an entry
// point's full relative path, which this repository's own idiom for a
// gate-local reference ("$dir/name.sh") does not contain. Both fixes are
// exercised against gate/fixtures/lane-exit-idiom.test.sh.fixture rather than
// asserted in prose.

const repoRoot = join(import.meta.dir, "..");

// Entry points whose preflight refuses a caller-supplied BUN_BIN. Explicit, so
// that deleting one is a visible failure rather than a silently shorter scan.
// orchestrator/fleet/lane-payload.sh is deliberately NOT here: it never calls
// land_resolve_bun, and its one mention of the name is a comment explaining why
// it does the opposite -- `env -u BUN_BIN "$gate" ...`, which STRIPS the
// variable before invoking the real entry point.
const gateEntryPoints = ["gate/land.sh", "gate/lane-exit.sh"] as const;

const entryPointBasenames = gateEntryPoints.map((entry) => entry.split("/").pop()!);

// Bash is not statically analysable, so every predicate below is textual. Two
// rules keep that honest.
//
// (1) Full-line comments are blanked before any claim about BEHAVIOUR is
//     evaluated -- with line positions preserved, because placement matters
//     further down. A mention must never satisfy a claim about what the code
//     does; that is exactly how the previous round's premise assertion came to
//     certify a comment.
// (2) A claim about behaviour also requires COMMAND POSITION, not mere
//     presence, so an inline trailing comment cannot satisfy one either.
const executableLines = (source: string): string[] =>
  source.split("\n").map((line) => (/^[ \t]*#/.test(line) ? "" : line));

// `land_resolve_bun` in command position: start of line, after a shell
// separator or `!`, or after a keyword that introduces a command. The trailing
// lookahead rejects `land_resolve_bun()`, which is a definition, not a call.
const LAND_RESOLVE_BUN_CALL =
  /(?:^|[;&|(){}!]|\b(?:if|then|else|elif|do|while|until)\b)[ \t]*land_resolve_bun\b(?![ \t]*\()/;

const callsLandResolveBun = (source: string) =>
  executableLines(source).some((line) => LAND_RESOLVE_BUN_CALL.test(line));

const UNSET_BUN_BIN = /^[ \t]*unset[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*[ \t]+)*BUN_BIN\b/;

const firstEntryPointUse = (lines: string[]) =>
  lines.findIndex((line) => entryPointBasenames.some((name) => line.includes(name)));

// Neutralization is a claim about ORDER, not presence: an `unset BUN_BIN` that
// lands after the first executable line naming an entry point leaves every
// invocation before it exposed. Known residual limit: a heredoc body carrying
// that line early in the file reads as neutralization here. Tightening that
// requires parsing heredocs, which buys less than it costs -- the scan's job is
// to force a judgement on a new test, not to be a shell interpreter.
const neutralizesBunOverride = (source: string) => {
  const lines = executableLines(source);
  const unsetAt = lines.findIndex((line) => UNSET_BUN_BIN.test(line));
  if (unsetAt < 0) return false;
  const useAt = firstEntryPointUse(lines);
  return useAt < 0 || unsetAt < useAt;
};

// Matching the BASENAME, not the full relative path. gate/lane-exit.sh refers
// to its own siblings as "$script_dir/land-lib.sh" and
// "$script_dir/completion-guard.ts": a directory variable plus a bare filename
// is this repository's established idiom for a file living in gate/, and it is
// precisely what a newly added gate test writes. A full-path match cannot see
// it. Deliberately evaluated on the RAW source, including comments: merely
// naming an entry point is enough to require a judgement, and measuredImmune
// below is where that judgement is recorded.
const referencesGateEntryPoint = (source: string) =>
  entryPointBasenames.some((name) => source.includes(name));

// Shell tests that drive one of the entry points above and therefore MUST own
// their own environment. Explicit for the same reason: a glob cannot detect a
// deletion, and this inventory going stale is itself the regression.
const mustNeutralizeBunOverride = [
  "gate/land.test.sh",
  "gate/land-rollback.test.sh",
  "gate/land-target-branch.test.sh",
  "gate/lane-exit.test.sh",
] as const;

// Referencing an entry point is not the same as EXECUTING one. This one names
// an entry point without ever handing it the caller's environment, and was
// measured passing with BUN_BIN deliberately set. Listing it (rather than
// loosening the scan) keeps the triage decision visible and forces a newly
// added test to be judged rather than silently skipped.
const measuredImmune: Record<string, string> = {
  "orchestrator/fleet/lane-payload-systemd.test.sh":
    "drives the payload through systemd with a stand-in for the exit-side gate, so no caller environment reaches a real entry point",
};

// The defect-class fixture: a shell test that drives an entry point through the
// house idiom and does not own its environment. Stored with a `.fixture` suffix
// so the tree walk cannot see it as a live test -- named *.test.sh in this tree
// it would make the scan permanently, correctly red.
const evasionFixture = join(repoRoot, "gate/fixtures/lane-exit-idiom.test.sh.fixture");

const scanForOffenders = (root: string): string[] => {
  const shellTests: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".test.sh")) shellTests.push(full);
    }
  };
  walk(root);

  return shellTests
    .map((full) => relative(root, full))
    .filter((path) => {
      const source = readFileSync(join(root, path), "utf8");
      if (!referencesGateEntryPoint(source) || neutralizesBunOverride(source)) return false;
      return !(path in measuredImmune);
    })
    .sort();
};

test("every entry point named by this lock still CALLS land_resolve_bun", () => {
  for (const entry of gateEntryPoints) {
    const path = join(repoRoot, entry);
    expect(existsSync(path), `${entry} is missing`).toBe(true);
    expect(
      callsLandResolveBun(readFileSync(path, "utf8")),
      `${entry} no longer calls land_resolve_bun; this lock's premise moved`,
    ).toBe(true);
  }
});

// The assertion above used to be `source.includes("land_resolve_bun")`, which a
// comment satisfies. These cases are that defect, kept red.
test("the premise assertion reads a call, not a mention", () => {
  expect(callsLandResolveBun("if ! land_resolve_bun; then exit 2; fi\n")).toBe(true);
  expect(callsLandResolveBun("land_resolve_bun\n")).toBe(true);
  expect(callsLandResolveBun("# instead of tripping the land_resolve_bun guard\n")).toBe(false);
  expect(callsLandResolveBun("#   if land_resolve_bun fails, we exit\n")).toBe(false);
  expect(callsLandResolveBun('env -u BUN_BIN "$gate" # land_resolve_bun\n')).toBe(false);
  expect(callsLandResolveBun("land_resolve_bun() {\n")).toBe(false);
});

// orchestrator/fleet/lane-payload.sh was listed as an entry point on the
// strength of a comment naming land_resolve_bun. It is not one, and this keeps
// it from coming back. Note what is NOT asserted here: that the comment still
// exists. Pinning a comment is the defect this round removed, so the claims are
// about the payload's behaviour only.
test("the payload wrapper strips BUN_BIN rather than refusing it", () => {
  const source = readFileSync(join(repoRoot, "orchestrator/fleet/lane-payload.sh"), "utf8");
  expect(callsLandResolveBun(source), "it never calls the guard, it evades it").toBe(false);
  expect(executableLines(source).some((line) => line.includes("env -u BUN_BIN"))).toBe(true);
});

test("gate shell tests that drive a gate entry point neutralize an inherited BUN_BIN", () => {
  for (const relativePath of mustNeutralizeBunOverride) {
    const path = join(repoRoot, relativePath);
    expect(existsSync(path), `${relativePath} is missing`).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(
      neutralizesBunOverride(source),
      `${relativePath} drives a gate entry point but does not 'unset BUN_BIN' before ` +
        `first use. Run under a gate wrapper it will fail at preflight with ` +
        `caller-bun-override-refused, and the assertion message will name a ` +
        `missing output line instead of the refusal.`,
    ).toBe(true);
  }
});

test("neutralization is judged on placement, not presence", () => {
  const before = 'unset BUN_BIN\nland="$root/gate/land.sh"\n"$land" --help\n';
  const after = 'land="$root/gate/land.sh"\n"$land" --help\nunset BUN_BIN\n';
  expect(neutralizesBunOverride(before)).toBe(true);
  expect(neutralizesBunOverride(after)).toBe(false);
  // A comment naming an entry point above the unset line is not a use --
  // gate/land-rollback.test.sh's header is exactly this shape.
  expect(neutralizesBunOverride('# drives gate/land.sh\nunset BUN_BIN\nl="$r/gate/land.sh"\n')).toBe(true);
  // ...and an unset that is itself only a comment neutralizes nothing.
  expect(neutralizesBunOverride('# unset BUN_BIN\nland="$root/gate/land.sh"\n')).toBe(false);
});

// The inventory above detects deletion; this scan detects ADDITION -- a new
// shell test that drives an entry point without owning its environment.
test("no unlisted shell test drives a gate entry point without neutralizing BUN_BIN", () => {
  const offenders = scanForOffenders(repoRoot);
  expect(
    offenders,
    `these shell tests reference a gate entry point but neither 'unset BUN_BIN' ` +
      `before first use nor appear in measuredImmune: ${offenders.join(", ")}. Run ` +
      `each with BUN_BIN set: if it fails, add the unset line; if it passes, add ` +
      `it to measuredImmune with the reason it never hands an entry point the ` +
      `caller's environment.`,
  ).toEqual([]);
});

// The scan's stated claim is universal, so it is checked against a member of
// the class rather than only against a tree where no member exists. Before this
// round the fixture below sat in gate/ and the lock stayed entirely green.
test("the scan names a test that reaches an entry point through the house idiom", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-override-scan-"));
  try {
    mkdirSync(join(root, "gate"));
    copyFileSync(evasionFixture, join(root, "gate/lane-exit-idiom.test.sh"));
    // A correct sibling, so this proves discrimination and not just alarm.
    copyFileSync(join(repoRoot, "gate/lane-exit.test.sh"), join(root, "gate/lane-exit.test.sh"));
    expect(scanForOffenders(root)).toEqual(["gate/lane-exit-idiom.test.sh"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the evasion fixture still encodes the evasion", () => {
  expect(existsSync(evasionFixture), "the defect-class fixture is missing").toBe(true);
  const source = readFileSync(evasionFixture, "utf8");
  for (const entry of gateEntryPoints) {
    expect(
      source.includes(entry),
      `the fixture spells out ${entry}, so it no longer evades a full-path scan ` +
        `and no longer proves anything. Refer to the entry point as "$dir/name" only.`,
    ).toBe(false);
  }
  expect(referencesGateEntryPoint(source), "the fixture must still reach an entry point").toBe(true);
  expect(neutralizesBunOverride(source), "the fixture must stay defective").toBe(false);
});

test("every measuredImmune entry still exists and still carries a reason", () => {
  for (const [path, reason] of Object.entries(measuredImmune)) {
    expect(existsSync(join(repoRoot, path)), `${path} is missing`).toBe(true);
    expect(reason.trim().length, `${path} has an empty reason`).toBeGreaterThan(0);
  }
});

const resolveBun = () => {
  const bun = spawnSync("bash", ["-c", "command -v bun"], { encoding: "utf8" });
  expect(bun.status, "bun must be resolvable to run these locks").toBe(0);
  return bun.stdout.trim();
};

// The static checks above are only as good as their correspondence to real
// behavior, so one entry point is exercised end to end with a BUN_BIN
// deliberately set. gate/land-target-branch.test.sh drives gate/land.sh -- the
// entry point whose refusal actually produced the incident -- and at ~3s costs
// about a second more than the cheapest affected test, which drives the other
// one. Running the whole inventory here would add roughly a minute and a half
// to every landing for no additional class coverage.
test(
  "gate/land-target-branch.test.sh passes when its caller exports BUN_BIN",
  () => {
    const result = spawnSync("bash", ["gate/land-target-branch.test.sh"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, BUN_BIN: resolveBun() },
    });
    expect(
      result.status,
      `gate/land-target-branch.test.sh exited ${result.status} with BUN_BIN exported\n` +
        `${result.stdout}${result.stderr}`,
    ).toBe(0);
  },
  120_000,
);

// ...and the fixture is exercised in both directions, so the scan above is
// locking a real member of the defect class rather than a plausible-looking
// text file. Clean it passes; with BUN_BIN exported it fails, at the refusal.
test(
  "the evasion fixture is a genuine member of the defect class",
  () => {
    const bunBin = resolveBun();
    const clean = { ...process.env } as Record<string, string>;
    delete clean.BUN_BIN;
    const passing = spawnSync("bash", [evasionFixture], { encoding: "utf8", env: clean });
    expect(
      passing.status,
      `the fixture must pass from a clean shell, or it proves nothing about BUN_BIN\n` +
        `${passing.stdout}${passing.stderr}`,
    ).toBe(0);

    const failing = spawnSync("bash", [evasionFixture], {
      encoding: "utf8",
      env: { ...clean, BUN_BIN: bunBin },
    });
    expect(failing.status, "the fixture must fail once a caller exports BUN_BIN").not.toBe(0);
    expect(
      `${failing.stdout}${failing.stderr}`.includes("caller-bun-override-refused"),
      `the fixture failed for some other reason\n${failing.stdout}${failing.stderr}`,
    ).toBe(true);
  },
  120_000,
);
