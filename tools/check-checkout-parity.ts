#!/usr/bin/env bun

// Checkout parity: the same check, at the same SHA, must return the same
// VERDICT whichever kind of checkout it runs in (cutover gate E, workboard
// V3-5.51).
//
// WHY THIS EXISTS. The evening consilium measured the failure, it was not
// hypothesised (instance/consilium-cutover-2026-08-04-evening-synthesis.md):
// `instance/decisions/inbox.jsonl` is deliberately untracked, so it exists in
// the primary repository and is ABSENT from every lane worktree and from
// `land-main` -- the clone the landing gate runs the suite from. The ledger
// check therefore had nothing to read exactly where the gate ran it, and passed
// trivially. A green in the place that decides landings meant less than the
// same green in the place a person looked. Gate E's clause is the fix stated as
// a property: "the suite returns the same verdict in the primary repo, a lane
// worktree and `land-main`". This is that property, executed.
//
// THE THREE WORLDS, and why each is a different KIND of checkout rather than
// three copies of one:
//
//   primary        a clone with its own `.git` DIRECTORY, plus a mirror of the
//                  source checkout's untracked and ignored working-tree files.
//                  That content is the whole point: it is what a primary
//                  repository has and what the other two kinds structurally
//                  cannot have.
//   lane-worktree  `git worktree add` off a dedicated parent clone. `.git` is a
//                  FILE, the object store, config and refs (including the
//                  repository-global `refs/stash`) are SHARED with the parent,
//                  `git worktree list` sees siblings, and tracked content is
//                  all there is.
//   land-main      an independent `git clone`: own `.git` directory, own
//                  config, own refs, no worktree linkage, tracked content only.
//
// Each world is built from the source repository alone and no world's
// construction touches another's -- the lane worktree hangs off its own parent
// clone precisely so that building it does not add a sibling to the `primary`
// world and change what a check sees there. Nothing here reads, writes or even
// resolves the real `/root/bpa-dev-infrastructure` or the real
// `/root/.cache/infra-lanes/land-main`: those are host facts, and a checker
// that consults them proves something about this box instead of about the SHA.
//
// THE DECLARED CHECK SET, and why it is a sample rather than the suite. The
// full suite is minutes; this runs three times over. A parity harness that
// costs three full suites is a harness nobody runs, and an unrun check is worth
// less than an honest sample. So the set below is bounded at four members, each
// picked because it reads a DIFFERENT one of the properties that actually
// differ between checkout kinds, and the set is DECLARED here in tracked source
// rather than assembled at run time:
//
//   ledger            tools/instructions/check.ts --strict -- reads
//                     `instance/`, including the untracked inbox. This is the
//                     exact check the consilium caught diverging; the set would
//                     be dishonest without it.
//   reachability      tools/check-mechanism-reachability.ts -- reads the
//                     checkout through `git ls-files`, so it exercises git
//                     plumbing rather than the filesystem.
//   shared-stash      hygiene/check-shared-stash.sh -- reads repository-GLOBAL
//                     state (`refs/stash`) and the worktree inventory, the one
//                     input a worktree shares with its parent and a clone keeps
//                     private.
//   fleet-cap         tools/check-fleet-cap.ts -- tracked content only, and
//                     therefore a CONTROL: it must agree in all three worlds,
//                     so a divergence here indicts this harness, not a check.
//
// Each world runs its OWN copy of the checker at the SHA under test, not this
// tree's copy. Parity is a claim about a commit, and a commit carries both the
// data and the code that judges it.
//
// The comparison is on VERDICTS -- did the check pass or fail -- and never on
// output bytes. Two runs of the same check in two checkouts print different
// paths and different durations by construction; diffing that would report
// noise as a finding. The environment handed to every child is identical across
// the three worlds for the same reason: an env difference could then never be
// the cause of a divergence this reports.
//
// FAIL-CLOSED, in the direction the floor requires. A world that cannot be
// built is UNKNOWN, never PASS. A check killed by the per-check bound is
// UNKNOWN named as a kill, never a pass and never a fail -- "no failure
// printed" and "no failure occurred" are different claims
// (instructions/verification-and-locks.md). A divergence between two worlds
// that WERE built is a FAIL even when the third world is unknown, because a
// disagreement already observed is not made unobserved by a missing witness.
//
// Exit codes:
//   0  PASS     every declared check returned the same verdict in all three worlds
//   1  FAIL     at least one check's verdict differs between two built worlds
//   3  UNKNOWN  a world could not be built, or a check could not be measured

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The kinds, in the order gate E names them. The names are part of the
// contract: a FAIL quotes them, so they are what a reader greps for.
export const WORLD_NAMES = ["primary", "lane-worktree", "land-main"] as const;
export type WorldName = (typeof WORLD_NAMES)[number];

export type ParityCheck = {
  id: string;
  /** Argv for the check, rooted in the world under test. */
  argv: (world: string, bun: string) => string[];
};

export const DECLARED_CHECKS: readonly ParityCheck[] = [
  { id: "ledger", argv: (world, bun) => [bun, join(world, "tools/instructions/check.ts"), "--repo", world, "--strict"] },
  { id: "reachability", argv: (world, bun) => [bun, join(world, "tools/check-mechanism-reachability.ts"), "--repo", world] },
  { id: "shared-stash", argv: (world) => ["/bin/bash", join(world, "hygiene/check-shared-stash.sh"), world] },
  { id: "fleet-cap", argv: (world, bun) => [bun, join(world, "tools/check-fleet-cap.ts"), "--repo", world] },
];

// Mirroring the source's untracked and ignored content is bounded, because an
// unbounded copy of a working tree is how a fast check becomes a slow one.
// Exceeding a bound makes the primary world UNKNOWN -- it is a world this run
// could not build faithfully, and an unfaithful primary would compare as a
// second land-main and report parity it never measured.
//
// The numbers are calibrated against the real canonical checkout, measured
// 2026-08-07: 5081 untracked/ignored paths and 37 MB, almost all of it
// `daemon/node_modules` and `orchestrator/runtime`. A first draft set the path
// bound at 4000 and the live run went UNKNOWN on the one repository the gate is
// about -- a bound tight enough to refuse reality is a bound that turns the
// checker off. These sit roughly four times above what was measured, which
// leaves room for the dependency tree to grow without leaving room for a
// runaway working tree to become the thing under test.
export const MIRROR_MAX_PATHS = 20_000;
export const MIRROR_MAX_BYTES = 512 * 1024 * 1024;

// Variables gate/land-lib.sh exports into whatever invoked the gate; a child
// that re-enters a gate entry point dies on `caller-bun-override-refused`,
// which would be the refusal refusing its own parent. Removed from every world
// identically, so this cannot itself produce a divergence.
const STRIPPED_ENV = ["BUN_BIN", "LAND_CHECK_PATH", "CHECK_OUTCOMES_JSON"] as const;

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 120_000;

export type Verdict = "pass" | "fail";
export type CheckOutcome = { verdict: Verdict; status: number } | { unknown: string };
export type WorldOutcome = { name: WorldName; path: string; note: string } | { name: WorldName; unknown: string };
export type ParityVerdict = "PASS" | "FAIL" | "UNKNOWN";
export type ParityResult = { verdict: ParityVerdict; findings: string[]; evidence: string[] };

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("git", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout ?? "", stderr: (run.stderr ?? "").trim().split("\n").at(-1) ?? "" };
}

function nulList(args: string[]): string[] | null {
  const run = git(args);
  if (run.status !== 0) return null;
  return run.stdout.split("\0").filter(Boolean);
}

function cloneAt(repo: string, sha: string, destination: string): string | undefined {
  // --no-hardlinks: a world sharing object FILES with the source is not an
  // independent checkout, and `land-main`'s independence is the property under
  // test. This repository's object store is small enough that the cost is
  // fractions of a second.
  const cloned = git(["clone", "--no-hardlinks", "--quiet", "--no-checkout", repo, destination]);
  if (cloned.status !== 0) return `clone-failed ${cloned.stderr}`.trim();
  const checkedOut = git(["-C", destination, "checkout", "--quiet", "--detach", sha]);
  if (checkedOut.status !== 0) return `checkout-failed ${checkedOut.stderr}`.trim();
  return undefined;
}

/**
 * Copy every path present in the source working tree but absent from a fresh
 * checkout -- untracked and ignored alike. This is not ambient host state
 * leaking into a hermetic run: the source checkout is this checker's INPUT, and
 * its extra content is precisely the property that distinguishes a primary
 * repository from the other two kinds. Returns a note, or an unknown reason
 * when the mirror could not be made faithfully.
 */
export function mirrorWorkingTree(repo: string, destination: string, bounds: { maxPaths?: number; maxBytes?: number } = {}): { note: string } | { unknown: string } {
  const maxPaths = bounds.maxPaths ?? MIRROR_MAX_PATHS;
  const maxBytes = bounds.maxBytes ?? MIRROR_MAX_BYTES;
  const untracked = nulList(["-C", repo, "ls-files", "--others", "--exclude-standard", "-z"]);
  const ignored = nulList(["-C", repo, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"]);
  if (untracked === null || ignored === null) {
    return { unknown: "the source checkout has no readable working tree, so a primary world cannot be built from it" };
  }
  const paths = [...new Set([...untracked, ...ignored])].filter((path) => path !== ".git" && !path.startsWith(".git/"));
  if (paths.length > maxPaths) {
    return { unknown: `the source checkout carries ${paths.length} untracked/ignored path(s), over the ${maxPaths} bound this harness will mirror` };
  }
  let bytes = 0;
  let copied = 0;
  for (const path of paths) {
    const from = join(repo, path);
    let stat: Stats;
    try {
      // lstat, not stat: an installed dependency tree is full of symlinks, and
      // a mirror that RESOLVED them would copy the target's bytes under the
      // link's name -- a primary world that differs from the primary it claims
      // to mirror. A symlink is reproduced as a symlink, dangling or not.
      stat = lstatSync(from);
    } catch (error) {
      return { unknown: `${path} in the source checkout is unreadable (${error instanceof Error ? error.message : String(error)})` };
    }
    // Defensive, and honestly so: `git ls-files --others` reports regular files
    // and symlinks only -- a fifo beside a tracked file is simply not listed,
    // verified 2026-08-07 -- so nothing this harness feeds itself reaches here.
    // It stays because the alternative to refusing an unreproducible entry is
    // skipping one, and a skipped entry makes the primary world quietly less
    // primary than the source it claims to mirror.
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return { unknown: `${path} in the source checkout is neither a regular file nor a symlink, so the primary world cannot mirror it` };
    }
    bytes += stat.size;
    if (bytes > maxBytes) {
      return { unknown: `the source checkout's untracked/ignored content exceeds the ${maxBytes}-byte bound this harness will mirror` };
    }
    try {
      mkdirSync(dirname(join(destination, path)), { recursive: true });
      if (stat.isSymbolicLink()) symlinkSync(readlinkSync(from), join(destination, path));
      else copyFileSync(from, join(destination, path));
    } catch (error) {
      return { unknown: `${path} could not be mirrored into the primary world (${error instanceof Error ? error.message : String(error)})` };
    }
    copied += 1;
  }
  return { note: copied === 0 ? "no untracked or ignored content in the source checkout, so this world differs from land-main structurally only" : `mirrored ${copied} untracked/ignored path(s) from the source checkout` };
}

export function buildWorlds(repo: string, sha: string, root: string): WorldOutcome[] {
  const outcomes: WorldOutcome[] = [];

  const primary = join(root, "primary");
  const primaryFailure = cloneAt(repo, sha, primary);
  if (primaryFailure) {
    outcomes.push({ name: "primary", unknown: primaryFailure });
  } else {
    const mirrored = mirrorWorkingTree(repo, primary);
    outcomes.push("unknown" in mirrored ? { name: "primary", unknown: mirrored.unknown } : { name: "primary", path: primary, note: mirrored.note });
  }

  // The parent exists so that adding a worktree does not add a sibling to the
  // `primary` world above. Two worlds that alter each other are one world.
  const laneParent = join(root, "lane-parent");
  const lane = join(root, "lane-worktree");
  const laneParentFailure = cloneAt(repo, sha, laneParent);
  if (laneParentFailure) {
    outcomes.push({ name: "lane-worktree", unknown: `parent ${laneParentFailure}` });
  } else {
    const added = git(["-C", laneParent, "worktree", "add", "--quiet", "--detach", lane, sha]);
    outcomes.push(added.status === 0 ? { name: "lane-worktree", path: lane, note: "linked worktree of a parent clone; shared object store, config and refs" } : { name: "lane-worktree", unknown: `worktree-add-failed ${added.stderr}` });
  }

  const landMain = join(root, "land-main");
  const landMainFailure = cloneAt(repo, sha, landMain);
  outcomes.push(landMainFailure ? { name: "land-main", unknown: landMainFailure } : { name: "land-main", path: landMain, note: "independent clone; tracked content only" });

  return outcomes;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of STRIPPED_ENV) delete environment[name];
  return environment;
}

export function runCheck(check: ParityCheck, world: string, bun: string, timeoutMs: number): CheckOutcome {
  const argv = check.argv(world, bun);
  if (!existsSync(argv[1]!)) return { unknown: `${check.id} is absent from this world (${argv[1]})` };
  const run = spawnSync(argv[0]!, argv.slice(1), {
    cwd: world,
    encoding: "utf8",
    env: childEnvironment(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  // A kill announces itself here rather than reaching the caller as an ordinary
  // status. `signal` is set when the bound fired; `status === null` covers the
  // spawn that never produced one.
  if (run.signal) return { unknown: `${check.id} was killed by ${run.signal} after ${timeoutMs}ms, so its verdict in this world is unmeasured` };
  if (run.status === null) return { unknown: `${check.id} produced no exit status in this world (${run.error?.message ?? "no error reported"})` };
  return { verdict: run.status === 0 ? "pass" : "fail", status: run.status };
}

export function checkParity(options: { repo: string; checks?: readonly ParityCheck[]; sha?: string; root?: string; bun?: string; timeoutMs?: number }): ParityResult {
  const checks = options.checks ?? DECLARED_CHECKS;
  const bun = options.bun ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const repo = resolve(options.repo);

  if (checks.length === 0) {
    return { verdict: "UNKNOWN", findings: ["the declared check set is empty, so no parity was measured"], evidence: [] };
  }

  let sha = options.sha;
  if (!sha) {
    const head = git(["-C", repo, "rev-parse", "HEAD"]);
    if (head.status !== 0) return { verdict: "UNKNOWN", findings: [`${repo} has no resolvable HEAD (${head.stderr || "git rev-parse failed"})`], evidence: [] };
    sha = head.stdout.trim();
  }

  const root = options.root ?? mkdtempSync(join(tmpdir(), "checkout-parity-"));
  const owned = options.root === undefined;
  try {
    const worlds = buildWorlds(repo, sha, root);
    const built = worlds.filter((world): world is { name: WorldName; path: string; note: string } => "path" in world);
    const findings: string[] = [];
    const evidence: string[] = [`sha=${sha}`];
    for (const world of worlds) {
      evidence.push("path" in world ? `world=${world.name} built (${world.note})` : `world=${world.name} UNBUILT (${world.unknown})`);
    }
    const unbuilt = worlds.filter((world): world is { name: WorldName; unknown: string } => "unknown" in world);

    let diverged = false;
    let unmeasured = unbuilt.length > 0;
    for (const check of checks) {
      const outcomes = built.map((world) => ({ world: world.name, outcome: runCheck(check, world.path, bun, timeoutMs) }));
      const unknowns = outcomes.filter((entry) => "unknown" in entry.outcome);
      const measured = outcomes.filter((entry): entry is { world: WorldName; outcome: { verdict: Verdict; status: number } } => "verdict" in entry.outcome);
      for (const entry of unknowns) {
        unmeasured = true;
        findings.push(`check=${check.id} world=${entry.world} UNKNOWN: ${(entry.outcome as { unknown: string }).unknown}`);
      }
      const verdicts = new Set(measured.map((entry) => entry.outcome.verdict));
      if (verdicts.size > 1) {
        diverged = true;
        findings.push(`check=${check.id} DIVERGED: ${measured.map((entry) => `${entry.world}=${entry.outcome.verdict}(exit ${entry.outcome.status})`).join(" ")}`);
      } else if (measured.length > 0) {
        evidence.push(`check=${check.id} ${[...verdicts][0]} in ${measured.map((entry) => entry.world).join(", ")}`);
      }
      // One measured world cannot agree with anything. Saying so keeps a run
      // that built a single world from reading as a parity that held.
      if (measured.length < 2) {
        unmeasured = true;
        findings.push(`check=${check.id} was measured in ${measured.length} world(s), so no two verdicts were compared`);
      }
    }

    if (diverged) return { verdict: "FAIL", findings, evidence };
    if (unmeasured) return { verdict: "UNKNOWN", findings, evidence };
    return { verdict: "PASS", findings, evidence };
  } finally {
    if (owned) rmSync(root, { recursive: true, force: true });
  }
}

export const EXIT_CODES: Record<ParityVerdict, number> = { PASS: 0, FAIL: 1, UNKNOWN: 3 };

function argument(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Bun.argv[index + 1];
  if (!value) {
    console.error(`CHECKOUT-PARITY UNKNOWN argument-missing name=${name}`);
    process.exit(EXIT_CODES.UNKNOWN);
  }
  return value;
}

if (import.meta.main) {
  const repo = argument("--repo", join(import.meta.dir, ".."));
  const shaArgument = argument("--sha", "");
  const timeout = Number(argument("--timeout-ms", String(DEFAULT_CHECK_TIMEOUT_MS)));
  const result = checkParity({
    repo,
    sha: shaArgument || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CHECK_TIMEOUT_MS,
  });
  for (const line of result.evidence) console.log(`CHECKOUT-PARITY evidence ${line}`);
  for (const line of result.findings) console.error(`CHECKOUT-PARITY ${line}`);
  console.log(`CHECKOUT-PARITY ${result.verdict} checks=${DECLARED_CHECKS.map((check) => check.id).join(",")} worlds=${WORLD_NAMES.join(",")}`);
  process.exit(EXIT_CODES[result.verdict]);
}
