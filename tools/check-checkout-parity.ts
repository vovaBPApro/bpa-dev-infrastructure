#!/usr/bin/env bun

// Checkout parity: the same check, at the same SHA, must MEASURE THE SAME THING
// whichever kind of checkout it runs in (cutover gate E, workboard V3-5.51).
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
// WHY EXIT STATUS IS NOT THAT PROPERTY, which the first version of this file got
// wrong and an independent review caught by executing it. The consilium's own
// divergence exits 0 in BOTH worlds: with the inbox present the ledger aging
// check RUNS and reports `PASS instance [ledger]`; with it absent the check
// SKIPs, deliberately, because `capture.mode` is manual. Same exit status,
// different measurement -- so a comparator that reads `status === 0 ? pass :
// fail` reports parity on precisely the case it was built to catch. A trivial
// pass is not a failure; it is a check that did not happen, and "no failure
// printed" and "no failure occurred" are different claims
// (instructions/verification-and-locks.md). The same blindness runs the other
// way: two worlds failing for two DIFFERENT reasons compare equal as `fail`.
//
// So the comparison is on each check's OUTCOME SET -- the structured records the
// check itself prints -- and the exit status is one record among them, not the
// measurement. A record present in one world and ABSENT in another is a
// divergence. A record that is PASS in one world and SKIP or UNKNOWN in another
// is a divergence. Both are reported naming the check, the record, and the value
// each world produced.
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
//                     exact check the consilium caught diverging, and the
//                     divergence is INSIDE its outcome set rather than in its
//                     exit status, which is why the outcome set is what this
//                     harness compares.
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
// EVERY DECLARED MEMBER CARRIES AN EXTRACTOR, and that is a structural rule
// rather than a convention: `ParityCheck.outcomes` is required, so a member
// cannot be added without someone deciding what its outcome set IS. The
// deliberately blind extractor exists (`exitStatusOnlyOutcomes`) and is named
// for what it gives up; a test refuses it to any declared member. Outcome
// blindness is therefore something a person has to write down, not something a
// member can inherit by omission.
//
// WHAT AN EXTRACTOR DELIBERATELY DROPS is stated at each one. Two runs of the
// same check in two checkouts print different paths and different durations by
// construction, and `hygiene/check-shared-stash.sh` prints a worktree COUNT that
// differs between a linked worktree and a clone *by definition of the two
// kinds*. Those are noise and are excluded per-extractor, in tracked source,
// with the reason next to the exclusion. The environment handed to every child
// is identical across the three worlds for the same reason: an env difference
// could then never be the cause of a divergence this reports.
//
// DELIBERATE ASYMMETRY GOES THROUGH instance/checkout-parity-exemptions.tsv, and
// nowhere else. If a divergence is genuinely intended, a tracked row names the
// check, the record and the reason, and the row is re-verified on every run: an
// exemption whose divergence has gone away FAILs as stale, and one naming no
// declared check FAILs as an orphan. An asymmetry nobody wrote down is a finding,
// not a silence. The file is EMPTY as of this commit -- see its header for why
// the live inbox divergence is deliberately not in it.
//
// FAIL-CLOSED, in the direction the floor requires. A world that cannot be
// built is UNKNOWN, never PASS, and says so as a FINDING rather than only in
// evidence. A check killed by the per-check bound is UNKNOWN named as a kill,
// never a pass and never a fail. A check whose printed outcome set cannot be
// parsed -- including one that stopped before printing its summary -- is
// UNKNOWN in that world, never compared as if it had been read. A divergence
// between two worlds that WERE built is a FAIL even when the third world is
// unknown, because a disagreement already observed is not made unobserved by a
// missing witness.
//
// WHAT THIS FILE DOES NOT DO, stated because the row's acceptance clause asks
// for it and a reader will otherwise assume the opposite. Gate E in
// tools/check-cutover-readiness.ts checks that this mechanism is REGISTERED and
// LANDED; it does not execute it, and says so in its own evidence text. Nothing
// runs this on a timer or inside gate/land.sh either. Wiring an execution into
// a gate is a separate decision with its own cost (three worlds times four
// checks on every landing) and its own blast radius, and it is deliberately not
// taken here. Until it is taken, `CUTOVER-READINESS E PASS` means the mechanism
// exists -- not that the three outcome sets matched.
//
// Exit codes:
//   0  PASS     every declared check produced the same outcome set in all three worlds
//   1  FAIL     at least one check's outcome set differs between two built worlds
//   3  UNKNOWN  a world could not be built, or a check could not be measured

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The kinds, in the order gate E names them. The names are part of the
// contract: a FAIL quotes them, so they are what a reader greps for.
export const WORLD_NAMES = ["primary", "lane-worktree", "land-main"] as const;
export type WorldName = (typeof WORLD_NAMES)[number];

/** What a check printed, before anything interprets it. */
export type CheckRun = { stdout: string; stderr: string; status: number };

/**
 * One structured judgement a check announced. `key` is what was judged and must
 * be stable across checkout kinds; `value` is the judgement. A record present in
 * one world and absent in another is as much a divergence as two different
 * values, which is the whole finding this file was rejected for missing.
 */
export type OutcomeRecord = { key: string; value: string };
export type OutcomeSet = { records: OutcomeRecord[] } | { unmeasured: string };

export type ParityCheck = {
  id: string;
  /** Argv for the check, rooted in the world under test. */
  argv: (world: string, bun: string) => string[];
  /**
   * The check's own structured output, read as a set of judgements. Required:
   * a member with no extractor would be compared on exit status alone, which is
   * the defect this field exists to remove.
   */
  outcomes: (run: CheckRun, world: string) => OutcomeSet;
};

/**
 * Replace a world's own path with a placeholder. Every world lives at a
 * different directory by construction, so an unnormalized path in a printed
 * record would make every check diverge and report the harness rather than the
 * checkout.
 */
export function normalizeWorldPaths(text: string, world: string): string {
  return world ? text.split(world).join("<world>") : text;
}

const LEDGER_LEVEL = "(?:FAIL|UNKNOWN|WARN|SKIP|PASS)";
const LEDGER_FINDING = new RegExp(`^(${LEDGER_LEVEL}) +(\\S+) +\\[([^\\]]+)\\]`);
const LEDGER_SUMMARY = /^summary: (\d+) FAIL, (\d+) UNKNOWN, (\d+) WARN, (\d+) SKIP, (\d+) PASS \((\d+) docs\)$/;

/**
 * tools/instructions/check.ts prints one line per judgement -- `LEVEL file
 * [check]  detail` -- and closes with a `summary:` line tallying the levels.
 * Both are read.
 *
 * DELIBERATELY DROPPED: the trailing `detail` text. It carries absolute paths
 * and row counts that legitimately differ between worlds; the level, the file
 * and the check id are the judgement.
 *
 * RECONCILED, not trusted: the tally this function parsed must equal the tally
 * the checker printed. If it does not, this parser lost lines, and a comparison
 * over lines a parser silently dropped is exactly the false green the outcome
 * set exists to prevent -- so it reports unmeasured instead. A run with no
 * `summary:` line did not finish printing, which is the same answer.
 */
export function ledgerOutcomes(run: CheckRun, world: string): OutcomeSet {
  const text = normalizeWorldPaths(`${run.stdout}\n${run.stderr}`, world);
  const records: OutcomeRecord[] = [];
  const counts: Record<string, number> = { FAIL: 0, UNKNOWN: 0, WARN: 0, SKIP: 0, PASS: 0 };
  let summary: RegExpMatchArray | null = null;
  for (const line of text.split("\n")) {
    const finding = line.match(LEDGER_FINDING);
    if (finding) {
      counts[finding[1]!] = (counts[finding[1]!] ?? 0) + 1;
      records.push({ key: `${finding[2]} [${finding[3]}]`, value: finding[1]! });
      continue;
    }
    const tally = line.match(LEDGER_SUMMARY);
    if (tally) summary = tally;
  }
  if (!summary) {
    return { unmeasured: "the ledger check printed no summary line, so its outcome set is unread rather than empty" };
  }
  const printed = { FAIL: Number(summary[1]), UNKNOWN: Number(summary[2]), WARN: Number(summary[3]), SKIP: Number(summary[4]), PASS: Number(summary[5]) };
  for (const [level, expected] of Object.entries(printed)) {
    if (counts[level] !== expected) {
      return { unmeasured: `the ledger check reported ${expected} ${level} but this harness read ${counts[level]}, so the outcome set was not parsed faithfully` };
    }
  }
  // The document count is tracked-derived and must be identical everywhere; a
  // checkout kind that sees fewer docs is a divergence in what was inspected.
  records.push({ key: "docs", value: summary[6]! });
  records.push({ key: "exit-status", value: String(run.status) });
  return { records };
}

/**
 * tools/check-mechanism-reachability.ts prints `MECHANISM-REACHABILITY clean`,
 * or one `MECHANISM-REACHABILITY <error>` line per unreachable/stale/orphan
 * mechanism. Each error is its own record, so two worlds that both fail for
 * DIFFERENT mechanisms diverge instead of comparing equal as "fail".
 */
export function reachabilityOutcomes(run: CheckRun, world: string): OutcomeSet {
  const text = normalizeWorldPaths(`${run.stdout}\n${run.stderr}`, world);
  const records: OutcomeRecord[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^MECHANISM-REACHABILITY (.+)$/);
    if (!match) continue;
    const detail = match[1]!.trim();
    records.push(detail === "clean" ? { key: "verdict", value: "clean" } : { key: detail, value: "error" });
  }
  if (records.length === 0) {
    return { unmeasured: "the reachability check printed no MECHANISM-REACHABILITY line, so its outcome set is unread" };
  }
  records.push({ key: "exit-status", value: String(run.status) });
  return { records };
}

/**
 * hygiene/check-shared-stash.sh prints one `SHARED-STASH status=<clean|fail>`
 * line, with `detail=` or `hazard=` when it refuses.
 *
 * DELIBERATELY DROPPED: `worktrees=<n>`. A linked worktree has siblings and an
 * independent clone does not -- that count differs between the kinds by
 * DEFINITION of the kinds, so comparing it would report the harness building
 * three different checkouts as a defect in the checkout.
 */
export function sharedStashOutcomes(run: CheckRun, world: string): OutcomeSet {
  const text = normalizeWorldPaths(`${run.stdout}\n${run.stderr}`, world);
  const records: OutcomeRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("SHARED-STASH ")) continue;
    const status = line.match(/\bstatus=(\S+)/);
    if (status) records.push({ key: "status", value: status[1]! });
    const detail = line.match(/\bdetail=(\S+)/);
    if (detail) records.push({ key: "detail", value: detail[1]! });
    if (/\bhazard=/.test(line)) records.push({ key: "hazard", value: "reported" });
  }
  if (records.length === 0) {
    return { unmeasured: "the shared-stash check printed no SHARED-STASH line, so its outcome set is unread" };
  }
  records.push({ key: "exit-status", value: String(run.status) });
  return { records };
}

/**
 * tools/check-fleet-cap.ts prints `FLEET-CAP clean <field>=<value> ...`, or one
 * error line per violation. Every field is tracked-derived, so every field is a
 * record and nothing here is dropped: this member is the control, and a control
 * that ignores half its output controls nothing.
 */
export function fleetCapOutcomes(run: CheckRun, world: string): OutcomeSet {
  const text = normalizeWorldPaths(`${run.stdout}\n${run.stderr}`, world);
  const records: OutcomeRecord[] = [];
  let seen = false;
  for (const line of text.split("\n")) {
    const clean = line.match(/^FLEET-CAP clean (.+)$/);
    if (clean) {
      seen = true;
      records.push({ key: "verdict", value: "clean" });
      for (const field of clean[1]!.trim().split(/\s+/)) {
        const pair = field.match(/^([^=]+)=(.*)$/);
        if (pair) records.push({ key: pair[1]!, value: pair[2]! });
      }
      continue;
    }
    if (line.trim() && run.status !== 0) {
      seen = true;
      records.push({ key: line.trim(), value: "error" });
    }
  }
  if (!seen) return { unmeasured: "the fleet-cap check printed neither a clean line nor an error, so its outcome set is unread" };
  records.push({ key: "exit-status", value: String(run.status) });
  return { records };
}

/**
 * The blind extractor, named for what it gives up: it reduces a check to its
 * exit status, which is exactly the comparison an independent review rejected.
 * It exists so a synthetic fixture can exercise the harness without inventing an
 * output vocabulary, and a test refuses it to every DECLARED member.
 */
export function exitStatusOnlyOutcomes(run: CheckRun): OutcomeSet {
  return { records: [{ key: "exit-status", value: String(run.status) }] };
}

export const DECLARED_CHECKS: readonly ParityCheck[] = [
  { id: "ledger", argv: (world, bun) => [bun, join(world, "tools/instructions/check.ts"), "--repo", world, "--strict"], outcomes: ledgerOutcomes },
  { id: "reachability", argv: (world, bun) => [bun, join(world, "tools/check-mechanism-reachability.ts"), "--repo", world], outcomes: reachabilityOutcomes },
  { id: "shared-stash", argv: (world) => ["/bin/bash", join(world, "hygiene/check-shared-stash.sh"), world], outcomes: sharedStashOutcomes },
  { id: "fleet-cap", argv: (world, bun) => [bun, join(world, "tools/check-fleet-cap.ts"), "--repo", world], outcomes: fleetCapOutcomes },
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

export const EXEMPTIONS_FILE = "instance/checkout-parity-exemptions.tsv";

// Variables gate/land-lib.sh exports into whatever invoked the gate; a child
// that re-enters a gate entry point dies on `caller-bun-override-refused`,
// which would be the refusal refusing its own parent. Removed from every world
// identically, so this cannot itself produce a divergence.
const STRIPPED_ENV = ["BUN_BIN", "LAND_CHECK_PATH", "CHECK_OUTCOMES_JSON"] as const;

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 120_000;

export type Verdict = "pass" | "fail";
export type CheckOutcome = { verdict: Verdict; status: number; outcomes: OutcomeSet } | { unknown: string };
export type WorldOutcome = { name: WorldName; path: string; note: string } | { name: WorldName; unknown: string };
export type ParityVerdict = "PASS" | "FAIL" | "UNKNOWN";
export type ParityResult = { verdict: ParityVerdict; findings: string[]; evidence: string[] };

/** One tracked, re-verified statement that a named divergence is intended. */
export type ParityExemption = { check: string; key: string; reason: string };

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync("git", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { status: run.status, stdout: run.stdout ?? "", stderr: (run.stderr ?? "").trim().split("\n").at(-1) ?? "" };
}

function nulList(args: string[]): string[] | null {
  const run = git(args);
  if (run.status !== 0) return null;
  return run.stdout.split("\0").filter(Boolean);
}

/**
 * An absent exemptions file means nothing is exempt -- the strict reading and
 * the safe one. An unreadable-but-present file is UNKNOWN: a permission error
 * must not silently become "no exemptions", nor the reverse.
 */
export function readParityExemptions(path: string): ParityExemption[] | { unknown: string } {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("ENOENT") ? [] : { unknown: `parity exemptions file unreadable: ${path} (${message})` };
  }
  const rows: ParityExemption[] = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line.trim() || line.startsWith("#")) continue;
    const cells = line.split("\t");
    if (cells.length !== 3 || cells.some((cell) => !cell.trim())) {
      return { unknown: `${path}:${index + 1} is not a three-column check/record/reason row` };
    }
    rows.push({ check: cells[0]!.trim(), key: cells[1]!.trim(), reason: cells[2]!.trim() });
  }
  return rows;
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
  const printed: CheckRun = { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status };
  return { verdict: run.status === 0 ? "pass" : "fail", status: run.status, outcomes: check.outcomes(printed, world) };
}

/** Collapse a world's records into key -> value, folding repeats into one sorted value. */
export function foldRecords(records: readonly OutcomeRecord[]): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const record of records) {
    const bucket = grouped.get(record.key);
    if (bucket) bucket.push(record.value);
    else grouped.set(record.key, [record.value]);
  }
  return new Map([...grouped].map(([key, values]) => [key, values.length === 1 ? values[0]! : [...values].sort().join("+")]));
}

/** The value a world gave a record it never mentioned. Absence is an outcome. */
export const ABSENT = "absent";

export function checkParity(options: {
  repo: string;
  checks?: readonly ParityCheck[];
  sha?: string;
  root?: string;
  bun?: string;
  timeoutMs?: number;
  exemptions?: string;
}): ParityResult {
  const checks = options.checks ?? DECLARED_CHECKS;
  const bun = options.bun ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const repo = resolve(options.repo);

  if (checks.length === 0) {
    return { verdict: "UNKNOWN", findings: ["the declared check set is empty, so no parity was measured"], evidence: [] };
  }

  const exemptions = readParityExemptions(options.exemptions ?? join(repo, EXEMPTIONS_FILE));
  if ("unknown" in exemptions) return { verdict: "UNKNOWN", findings: [exemptions.unknown], evidence: [] };

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
    const evidence: string[] = [`sha=${sha}`, `exemptions=${exemptions.length}`];
    for (const world of worlds) {
      evidence.push("path" in world ? `world=${world.name} built (${world.note})` : `world=${world.name} UNBUILT (${world.unknown})`);
    }
    const unbuilt = worlds.filter((world): world is { name: WorldName; unknown: string } => "unknown" in world);
    // A reason that lives only on the evidence stream leaves a consumer reading
    // an UNKNOWN with no findings at all. The unbuilt world IS the finding.
    for (const world of unbuilt) findings.push(`world=${world.name} UNBUILT: ${world.unknown}`);

    const checkIds = new Set(checks.map((check) => check.id));
    const declaredExemptions = new Map(exemptions.map((row) => [`${row.check}\t${row.key}`, row]));
    const usedExemptions = new Set<string>();
    // Which checks were compared at all, so a stale-exemption claim is only made
    // about a check this run actually measured in two worlds.
    const comparedChecks = new Set<string>();

    let diverged = false;
    let unmeasured = unbuilt.length > 0;
    for (const check of checks) {
      const outcomes = built.map((world) => ({ world: world.name, outcome: runCheck(check, world.path, bun, timeoutMs) }));
      const unknowns = outcomes.filter((entry) => "unknown" in entry.outcome);
      const measured = outcomes.filter((entry): entry is { world: WorldName; outcome: { verdict: Verdict; status: number; outcomes: OutcomeSet } } => "verdict" in entry.outcome);
      for (const entry of unknowns) {
        unmeasured = true;
        findings.push(`check=${check.id} world=${entry.world} UNKNOWN: ${(entry.outcome as { unknown: string }).unknown}`);
      }
      const verdicts = new Set(measured.map((entry) => entry.outcome.verdict));
      if (verdicts.size > 1) {
        diverged = true;
        findings.push(`check=${check.id} DIVERGED verdict: ${measured.map((entry) => `${entry.world}=${entry.outcome.verdict}(exit ${entry.outcome.status})`).join(" ")}`);
      } else if (measured.length > 0) {
        evidence.push(`check=${check.id} ${[...verdicts][0]} in ${measured.map((entry) => entry.world).join(", ")}`);
      }

      // The outcome sets. A world whose output could not be parsed is unmeasured
      // for this check and is not compared as if it had been read.
      const read: { world: WorldName; folded: Map<string, string> }[] = [];
      for (const entry of measured) {
        if ("unmeasured" in entry.outcome.outcomes) {
          unmeasured = true;
          findings.push(`check=${check.id} world=${entry.world} UNKNOWN: ${entry.outcome.outcomes.unmeasured}`);
          continue;
        }
        read.push({ world: entry.world, folded: foldRecords(entry.outcome.outcomes.records) });
      }
      if (read.length >= 2) {
        comparedChecks.add(check.id);
        const keys = [...new Set(read.flatMap((entry) => [...entry.folded.keys()]))].sort();
        for (const key of keys) {
          const values = read.map((entry) => ({ world: entry.world, value: entry.folded.get(key) ?? ABSENT }));
          if (new Set(values.map((entry) => entry.value)).size <= 1) continue;
          const rendered = values.map((entry) => `${entry.world}=${entry.value}`).join(" ");
          const exemptionKey = `${check.id}\t${key}`;
          const exemption = declaredExemptions.get(exemptionKey);
          if (exemption) {
            usedExemptions.add(exemptionKey);
            evidence.push(`check=${check.id} exempt record="${key}" ${rendered} reason=${exemption.reason}`);
            continue;
          }
          diverged = true;
          findings.push(`check=${check.id} DIVERGED outcome record="${key}": ${rendered}`);
        }
      }

      // One measured world cannot agree with anything. Saying so keeps a run
      // that built a single world from reading as a parity that held.
      if (measured.length < 2) {
        unmeasured = true;
        findings.push(`check=${check.id} was measured in ${measured.length} world(s), so no two verdicts were compared`);
      }
    }

    // Every exemption is a claim about current state and is re-verified here.
    // The three answers are kept apart on purpose: an exemption naming no
    // declared check is decidable now and FAILs; one whose divergence is gone
    // FAILs as stale; one whose check this run could not compare is UNVERIFIED,
    // and saying "stale" about it would be a statement this run did not measure.
    for (const row of exemptions) {
      const key = `${row.check}\t${row.key}`;
      if (usedExemptions.has(key)) continue;
      if (!checkIds.has(row.check)) {
        diverged = true;
        findings.push(`FAIL orphan exemption: check=${row.check} record="${row.key}" names no check in the declared set`);
      } else if (!comparedChecks.has(row.check)) {
        unmeasured = true;
        findings.push(`UNKNOWN unverified exemption: check=${row.check} record="${row.key}" — this run compared that check's outcome set in fewer than two worlds, so whether the exemption is still needed is unmeasured`);
      } else {
        diverged = true;
        findings.push(`FAIL stale exemption: check=${row.check} record="${row.key}" no longer diverges between the worlds this run built`);
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
    exemptions: argument("--exemptions", join(repo, EXEMPTIONS_FILE)),
  });
  for (const line of result.evidence) console.log(`CHECKOUT-PARITY evidence ${line}`);
  for (const line of result.findings) console.error(`CHECKOUT-PARITY ${line}`);
  console.log(`CHECKOUT-PARITY ${result.verdict} checks=${DECLARED_CHECKS.map((check) => check.id).join(",")} worlds=${WORLD_NAMES.join(",")}`);
  process.exit(EXIT_CODES[result.verdict]);
}
