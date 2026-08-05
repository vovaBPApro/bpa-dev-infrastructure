#!/usr/bin/env bun
//
// Commit collision guard (G1 of instance/plans/orchestrator-guards-2026-08-05.md).
//
// REFUSES a commit whose changed set touches a file that a LIVE branch is also
// rewriting. It is a command the orchestrator invokes before committing, not a
// git hook: a hook that runs invisibly is the mechanism this repository keeps
// having to remove, and the guard has to be greppable in the transcript that
// shows what the orchestrator actually did.
//
// ── Why it exists ──────────────────────────────────────────────────────────
//
// Three times on 2026-08-05 the orchestrator committed to instance/workboard.md
// while a branch in flight was rewriting the same file. Each time the branch
// stopped merging, needed a rebase, and the rebase invalidated an ACCEPT that a
// reviewer lane had already earned. V3-5.1 alone cost three rebases and three
// review passes, none of them caused by a defect in the change; its second
// re-attestation called it "a serialization failure in dispatch, not a defect
// in the change". The third occurrence happened AFTER workboard row V3-5.12 was
// filed for exactly this, by the orchestrator, an hour earlier — which is the
// whole argument for a mechanism: the rule existed, was written down, was
// recent, and did not hold.
//
// ── What "live" means, and why it is measured rather than listed ───────────
//
// A list of live branches is a property defended by whoever maintains the list.
// This guard asks the system instead, and a branch is live when ANY of these
// hold:
//
//   running-unit   a `lane-<name>.service` is running and <name> maps to a
//                  registered worktree under the lanes directory. The mapping
//                  goes through `git worktree list`, never through the unit
//                  name alone — that is also why a test fixture's transient
//                  `lane-payload-probe-<pid>` unit cannot inflate this census
//                  (V3-5.19): it maps to no worktree, so it names no branch.
//                  Unmapped running units are COUNTED and printed rather than
//                  silently dropped.
//   unlanded-accept  a `<lanes-dir>/<branch>.review.md` carries `verdict:
//                  ACCEPT` and the branch is not yet an ancestor of the target.
//                  This is the case that hurt: a reviewed branch waiting to
//                  land has no process and no dirty tree, and is exactly what
//                  an ordinary bookkeeping commit displaces.
//   open-worktree  a registered worktree whose lane recorded NO terminal
//                  outcome. orchestrator/fleet/lane-payload.sh writes
//                  `<lanes-dir>/lane-<name>.status` only when the lane ends, so
//                  the file's ABSENCE is the measured signal for "not finished"
//                  and an unparseable file is treated as live (fail-closed).
//   dirty-worktree  a registered worktree with uncommitted changes: a writer
//                  can still commit there whatever its status file says.
//
// A branch that has fully landed contributes nothing without any liveness rule
// being consulted, because the comparison is against its MERGE BASE with the
// target: a landed branch's diff versus its merge base is empty. That is what
// keeps the refusal rate near the real collision rate instead of near the
// branch count — measured on this repository on 2026-08-05: 33 registered
// worktrees, of which 6 branches still carried a workboard diff, of which the
// census above marks 1 live. A guard that refused all six would be turned off.
//
// ── What it deliberately does not do ───────────────────────────────────────
//
//   - It does not block a landing. `gate/land.sh:735` merges with a single
//     `git merge --no-ff`, which commits by itself and never calls a guard;
//     and a merge left in progress for a hand resolution is cleared here by
//     name (`merge-in-progress`), as are rebase and cherry-pick states. A
//     landing commits to files it just merged BY DESIGN.
//   - It does not decide whether a landing is in flight. Refusing an ordinary
//     commit while gate/land.sh holds its flock is workboard row V3-5.12 and a
//     different mechanism.
//   - It cannot see untracked files that were never added: they are in no
//     commit `git commit` would make without an explicit `git add`.
//   - Degraded, not blind, without systemd: if `systemctl` is unavailable the
//     unit census prints `units=unmeasured` and the other signals still apply.
//     Every running lane also has a registered worktree and no status file, so
//     `open-worktree` already covers it.
//
// Usage: bun orchestrator/commit-guard.ts [--repo <path>] [--lanes-dir <path>]
//                                         [--target <ref>] [--staged-only] [--json]
// Exit codes: 0 clear (or break-glass override), 2 usage/IO error, 3 refusal.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { lineValue } from "../gate/report-contract.ts";
import { resolveOpsJournalPath } from "../tools/instructions/dispatch-check.ts";

export const OVERRIDE_ENV = "COMMIT_GUARD_OVERRIDE";

/** Why a branch counts as live. Ordered strongest first for the refusal text. */
export type LiveReason = "running-unit" | "unlanded-accept" | "dirty-worktree" | "open-worktree";

export type LiveBranch = {
  branch: string;
  reasons: LiveReason[];
  /** The registered worktree holding it, when one does. */
  worktree?: string;
  /** The lane name derived from the worktree path, for the refusal text. */
  lane?: string;
};

export type Collision = {
  file: string;
  branch: string;
  reasons: LiveReason[];
  lane?: string;
  /** `committed` = in the branch's diff vs its merge base; `uncommitted` = dirty in its worktree. */
  source: "committed" | "uncommitted";
};

export type Worktree = { path: string; branch?: string; detached: boolean };

// ── Pure parsers ───────────────────────────────────────────────────────────

/** `git worktree list --porcelain` into records. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const found: Worktree[] = [];
  let current: Worktree | undefined;
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) found.push(current);
      current = { path: line.slice("worktree ".length), detached: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length);
    if (line === "detached") current.detached = true;
  }
  if (current) found.push(current);
  return found;
}

/**
 * Lane names from `systemctl list-units ... 'lane-*'` output. The unit name is
 * the FIRST field of a --no-legend line, and systemd prefixes a failed unit's
 * line with a status bullet, so the name is taken after stripping any leading
 * non-word marker rather than by column arithmetic.
 */
export function parseLaneUnits(listUnits: string): string[] {
  const names: string[] = [];
  for (const line of listUnits.split(/\r?\n/)) {
    const match = line.trim().replace(/^\S*\s+(?=lane-)/, "").match(/^(lane-\S+?)\.service\b/);
    if (match) names.push(match[1].slice("lane-".length));
  }
  return names;
}

/**
 * True when a lane status file records a finished lane.
 * lane-payload.sh writes this file ONLY at exit, with `state: terminal` or
 * `state: failed` on its first line. Anything else — including an empty or
 * malformed file — is not a terminal record and leaves the lane live.
 */
export function statusIsTerminal(contents: string): boolean {
  return /^state:\s*(terminal|failed)\s*$/m.test(contents);
}

/** A review artifact claiming an ACCEPT, under the same one-occurrence rule the completion guard uses. */
export function reviewIsAccept(contents: string): boolean {
  return lineValue(contents, "verdict") === "ACCEPT";
}

// ── git ────────────────────────────────────────────────────────────────────

function git(repo: string, args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    out: result.stdout ?? "",
    err: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function gitOrDie(repo: string, args: string[], what: string): string {
  const result = git(repo, args);
  if (!result.ok) fail(`cannot ${what}: git ${args.join(" ")} — ${result.err.trim()}`);
  return result.out;
}

/** Paths in `git status --porcelain` output, both sides of the index. */
export function parsePorcelainStatus(porcelain: string): string[] {
  const paths: string[] = [];
  for (const line of porcelain.split("\0")) {
    if (!line) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    if (code.startsWith("R") || code.startsWith("C")) path = path.split(" -> ").at(-1)!;
    if (code === "??" || code === "!!") continue; // never added: in no commit `git commit` would make
    paths.push(path);
  }
  return paths;
}

// ── Census ─────────────────────────────────────────────────────────────────

export type CensusInput = {
  repo: string;
  lanesDir: string;
  target: string;
  /** Branch we are committing on; it cannot collide with itself. */
  selfBranch?: string;
  /** Worktree we are committing in; its own dirt is the change under test. */
  selfWorktree: string;
};

export type Census = {
  live: LiveBranch[];
  /** Running `lane-*` units that map to no registered worktree (test fixtures land here). */
  unmappedUnits: string[];
  /** True when systemctl could not be run at all. */
  unitsUnmeasured: boolean;
};

function readIfFile(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function takeCensus(input: CensusInput): Census {
  const { repo, lanesDir, target, selfBranch, selfWorktree } = input;
  const worktrees = parseWorktrees(gitOrDie(repo, ["worktree", "list", "--porcelain"], "list worktrees"));

  // Running lane units, mapped to branches THROUGH the worktree registry.
  let unitsUnmeasured = false;
  let runningLanes: string[] = [];
  const units = spawnSync(
    "systemctl",
    ["list-units", "--type=service", "--state=running", "--no-legend", "--plain", "lane-*"],
    { encoding: "utf8" },
  );
  if (units.error || units.status === null) unitsUnmeasured = true;
  else runningLanes = parseLaneUnits(units.stdout ?? "");

  const laneOf = (worktree: Worktree): string | undefined => {
    const parent = dirname(worktree.path.replace(/\/+$/, ""));
    return resolve(parent) === resolve(lanesDir) ? basename(worktree.path.replace(/\/+$/, "")) : undefined;
  };

  const byBranch = new Map<string, LiveBranch>();
  const add = (branch: string, reason: LiveReason, worktree?: string, lane?: string) => {
    if (!branch || branch === selfBranch) return;
    const existing = byBranch.get(branch);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      existing.worktree ??= worktree;
      existing.lane ??= lane;
      return;
    }
    byBranch.set(branch, { branch, reasons: [reason], worktree, lane });
  };

  const mappedLanes = new Set<string>();
  for (const worktree of worktrees) {
    if (resolve(worktree.path) === resolve(selfWorktree)) continue;
    if (!worktree.branch) continue; // a detached worktree publishes no branch to collide with
    const lane = laneOf(worktree);
    if (lane) mappedLanes.add(lane);

    if (lane && runningLanes.includes(lane)) add(worktree.branch, "running-unit", worktree.path, lane);

    const status = spawnSync("git", ["-C", worktree.path, "status", "--porcelain", "-z"], { encoding: "utf8" });
    if (status.status === 0 && (status.stdout ?? "").length > 0) {
      add(worktree.branch, "dirty-worktree", worktree.path, lane);
    }

    // No lane status file means no lane recorded an ending. A worktree that was
    // never launched by launch-lane.sh (a hand-made one) also lands here, which
    // is the fail-closed direction: unknown provenance is not evidence of death.
    const statusFile = lane ? readIfFile(join(lanesDir, `lane-${lane}.status`)) : undefined;
    if (!statusFile || !statusIsTerminal(statusFile)) {
      add(worktree.branch, "open-worktree", worktree.path, lane);
    }
  }

  // Unlanded ACCEPTs: branch-named, so they survive their worktree being reaped.
  let artifacts: string[] = [];
  try {
    artifacts = readdirSync(lanesDir).filter((entry) => entry.endsWith(".review.md"));
  } catch {
    artifacts = [];
  }
  for (const artifact of artifacts) {
    const branch = artifact.slice(0, -".review.md".length);
    if (!branch || branch === selfBranch) continue;
    const contents = readIfFile(join(lanesDir, artifact));
    if (!contents || !reviewIsAccept(contents)) continue;
    if (!git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) continue;
    if (git(repo, ["merge-base", "--is-ancestor", branch, target]).ok) continue; // already landed
    add(branch, "unlanded-accept");
  }

  const unmappedUnits = runningLanes.filter((lane) => !mappedLanes.has(lane));
  return { live: [...byBranch.values()], unmappedUnits, unitsUnmeasured };
}

// ── Collision ──────────────────────────────────────────────────────────────

/** Files a live branch is rewriting: its diff versus its merge base, plus any uncommitted work in its worktree. */
export function branchFiles(
  repo: string,
  target: string,
  live: LiveBranch,
): { committed: string[]; uncommitted: string[] } {
  const mergeBase = git(repo, ["merge-base", target, live.branch]);
  let committed: string[] = [];
  if (mergeBase.ok) {
    const base = mergeBase.out.trim();
    const diff = git(repo, ["diff", "--name-only", "-z", base, live.branch]);
    if (diff.ok) committed = diff.out.split("\0").filter(Boolean);
  } else {
    // No merge base: an unrelated history. Everything the branch holds is
    // potentially in conflict, so compare its whole tree rather than nothing.
    const files = git(repo, ["ls-tree", "-r", "--name-only", "-z", live.branch]);
    if (files.ok) committed = files.out.split("\0").filter(Boolean);
  }

  let uncommitted: string[] = [];
  if (live.worktree) {
    const status = spawnSync("git", ["-C", live.worktree, "status", "--porcelain", "-z"], { encoding: "utf8" });
    if (status.status === 0) uncommitted = parsePorcelainStatus(status.stdout ?? "");
  }
  return { committed, uncommitted };
}

export function findCollisions(changed: string[], live: LiveBranch[], files: (live: LiveBranch) => { committed: string[]; uncommitted: string[] }): Collision[] {
  const changedSet = new Set(changed);
  const collisions: Collision[] = [];
  for (const branch of live) {
    const { committed, uncommitted } = files(branch);
    const seen = new Set<string>();
    for (const [source, list] of [["committed", committed], ["uncommitted", uncommitted]] as const) {
      for (const file of list) {
        if (!changedSet.has(file) || seen.has(file)) continue;
        seen.add(file);
        collisions.push({ file, branch: branch.branch, reasons: branch.reasons, lane: branch.lane, source });
      }
    }
  }
  return collisions;
}

// ── Break-glass ────────────────────────────────────────────────────────────

/**
 * One append-only journal row per override, loud and greppable, mirroring
 * DISPATCH_OVERRIDE. The path comes from tools/instructions/dispatch-check.ts
 * so the journal keeps one home; the LABEL is this mechanism's own, because a
 * journal row naming the wrong guard is worse than no row.
 */
export function appendOverrideJournal(
  repoRoot: string,
  entry: { files: string[]; branches: string[]; reason: string; ts?: string },
  override?: string,
): string {
  const path = resolveOpsJournalPath(repoRoot, override);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error("ops journal must be a regular file (symlinks and special files are refused)");
  }
  const ts = entry.ts ?? new Date().toISOString();
  // JSON-escaped values: a newline in a reason cannot forge a second row.
  const line =
    `${ts}\t${OVERRIDE_ENV}\tfiles=${JSON.stringify(entry.files.join(","))}\t` +
    `branches=${JSON.stringify(entry.branches.join(","))}\treason=${JSON.stringify(entry.reason)}\n`;
  const sizeBefore = existsSync(path) ? statSync(path).size : 0;
  appendFileSync(path, line);
  const after = statSync(path);
  if (!after.isFile() || after.size < sizeBefore + Buffer.byteLength(line) || !readFileSync(path, "utf8").includes(line)) {
    throw new Error("ops journal append could not be durably verified");
  }
  return path;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function fail(message: string): never {
  process.stderr.write(`commit-guard: ${message}\n`);
  process.exit(2);
}

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun orchestrator/commit-guard.ts [--repo <path>] [--lanes-dir <path>]",
      "                                        [--target <ref>] [--staged-only] [--json]",
      "",
      "Refuses a commit whose changed files are also being rewritten by a live branch.",
      "",
      "  --repo <path>       Repository/worktree the commit would be made in (default: cwd).",
      "  --lanes-dir <path>  Lane worktree and artifact root",
      "                      (default: $XDG_CACHE_HOME|$HOME/.cache + /infra-lanes).",
      "  --target <ref>      Integration ref the merge base is taken against (default: origin/main).",
      "  --staged-only       Consider only the index; the default also counts tracked",
      "                      unstaged modifications, because `git commit -a` carries them.",
      "  --json              Emit the verdict as JSON on stdout.",
      "  -h, --help          Show this usage.",
      "",
      `Break-glass: ${OVERRIDE_ENV}=<reason> forces a clear verdict (a landing commits to`,
      "files it merged by design). Every use is announced on stderr and appended to the",
      "ops journal (orchestrator/runtime/ops-journal.log). Set-but-empty is an error.",
      "",
      "Exit codes: 0 clear (or override), 2 usage/IO error, 3 refusal.",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

type Options = {
  repo: string;
  lanesDir: string;
  target: string;
  stagedOnly: boolean;
  json: boolean;
};

export function defaultLanesDir(env: Record<string, string | undefined> = process.env): string {
  const cache = env.XDG_CACHE_HOME || join(env.HOME ?? "", ".cache");
  return join(cache, "infra-lanes");
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    repo: process.cwd(),
    lanesDir: defaultLanesDir(),
    target: "origin/main",
    stagedOnly: false,
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--staged-only") { options.stagedOnly = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--repo" || arg === "--lanes-dir" || arg === "--target") {
      const value = args[++index];
      if (!value || value.startsWith("--")) usage(2);
      if (arg === "--repo") options.repo = value;
      if (arg === "--lanes-dir") options.lanesDir = isAbsolute(value) ? value : resolve(value);
      if (arg === "--target") options.target = value;
      continue;
    }
    usage(2);
  }
  return options;
}

function describe(collision: Collision): string {
  const lane = collision.lane ? ` lane=${collision.lane}` : "";
  return `  ${collision.file}  <- ${collision.branch} (${collision.reasons.join(",")}${lane}; ${collision.source})`;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const repo = resolve(options.repo);

  // Validated before anything is measured: a break-glass with no reason is a
  // broken invocation whatever the verdict would have been.
  const override = process.env[OVERRIDE_ENV];
  if (override !== undefined && override.trim() === "") {
    fail(`${OVERRIDE_ENV} is set but empty — a break-glass override MUST carry a reason`);
  }

  if (!git(repo, ["rev-parse", "--is-inside-work-tree"]).ok) fail(`not a git worktree: ${repo}`);
  const selfWorktree = gitOrDie(repo, ["rev-parse", "--show-toplevel"], "resolve the worktree root").trim();
  const head = git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const selfBranch = head.ok ? head.out.trim() : undefined;

  // A merge, rebase or cherry-pick in progress is not an ordinary edit: the
  // staged set IS the other branch's content. gate/land.sh's own merge commits
  // itself and never reaches here, but a hand resolution of one must not be
  // refused by the guard that exists to protect it.
  const inProgress = (["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"] as const)
    .filter((marker) => {
      const path = git(repo, ["rev-parse", "--git-path", marker]);
      return path.ok && existsSync(resolve(repo, path.out.trim()));
    });
  if (inProgress.length > 0) {
    process.stdout.write(`COMMIT-GUARD verdict=clear reason=merge-in-progress markers=${inProgress.join(",")}\n`);
    process.exit(0);
  }

  const stagedOut = gitOrDie(repo, ["diff", "--cached", "--name-only", "-z"], "read the index");
  const changed = new Set(stagedOut.split("\0").filter(Boolean));
  if (!options.stagedOnly) {
    const unstaged = gitOrDie(repo, ["diff", "--name-only", "-z"], "read the working tree");
    for (const file of unstaged.split("\0").filter(Boolean)) changed.add(file);
  }

  if (!git(repo, ["rev-parse", "--verify", "--quiet", `${options.target}^{commit}`]).ok) {
    fail(`target ref does not resolve: ${options.target} (pass --target)`);
  }

  const census = takeCensus({
    repo,
    lanesDir: options.lanesDir,
    target: options.target,
    selfBranch,
    selfWorktree,
  });
  const changedFiles = [...changed];
  const collisions = changedFiles.length === 0
    ? []
    : findCollisions(changedFiles, census.live, (live) => branchFiles(repo, options.target, live));

  const summary =
    `paths=${changedFiles.length} live=${census.live.length} ` +
    `unmapped-units=${census.unmappedUnits.length}${census.unitsUnmeasured ? " units=unmeasured" : ""}`;

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      verdict: collisions.length ? "refused" : "clear",
      changed: changedFiles,
      live: census.live,
      unmappedUnits: census.unmappedUnits,
      unitsUnmeasured: census.unitsUnmeasured,
      collisions,
    }, null, 2)}\n`);
  }

  if (collisions.length === 0) {
    if (!options.json) process.stdout.write(`COMMIT-GUARD verdict=clear ${summary}\n`);
    process.exit(0);
  }

  if (override !== undefined) {
    let journal: string;
    try {
      journal = appendOverrideJournal(repo, {
        files: [...new Set(collisions.map((collision) => collision.file))],
        branches: [...new Set(collisions.map((collision) => collision.branch))],
        reason: override,
      });
    } catch (error) {
      fail(`${OVERRIDE_ENV} refused: ${(error as Error).message}`);
    }
    process.stderr.write(
      `COMMIT-GUARD verdict=override ${summary} collisions=${collisions.length} journal=${journal}\n` +
        collisions.map(describe).join("\n") + "\n",
    );
    process.exit(0);
  }

  process.stderr.write(
    `COMMIT-GUARD verdict=refused ${summary} collisions=${collisions.length}\n` +
      collisions.map(describe).join("\n") + "\n" +
      `COMMIT-GUARD: wait for the branch to land, move the change to a lane, or set ` +
      `${OVERRIDE_ENV}=<reason> to break glass (announced and journaled).\n`,
  );
  process.exit(3);
}
