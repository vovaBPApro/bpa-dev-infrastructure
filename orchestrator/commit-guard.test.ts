import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLaneUnits, parseWorktrees, statusIsTerminal, reviewIsAccept, parsePorcelainStatus } from "./commit-guard.ts";

// This file IS the executor for orchestrator/commit-guard.ts: the landing gate
// runs every tracked *.test.ts on every candidate, so the guard cannot go inert
// without a landing failing.
//
// It proves the REFUSALS first. A guard that only proved its clears would pass
// just as well if it never refused anything, which is the shape G5 of
// instance/plans/orchestrator-guards-2026-08-05.md is about. The red-before
// evidence for the central case is `guard removed -> the refusal test fails`,
// which is the last test in this file: it runs a stand-in that always clears
// against the same fixture and asserts the fixture would have caught it.

const guard = join(import.meta.dir, "commit-guard.ts");

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function sh(command: string, cwd: string): string {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`command failed: ${command}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

type Fixture = { root: string; repo: string; lanes: string; fakeBin: string };

/**
 * A repository with a `main` checkout and a lanes directory, shaped like the
 * real installation: lane worktrees at <lanes>/<name>, lane status files at
 * <lanes>/lane-<name>.status, review artifacts at <lanes>/<branch>.review.md.
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "commit-guard-"));
  cleanup.push(root);
  const repo = join(root, "repo");
  const lanes = join(root, "lanes");
  const fakeBin = join(root, "bin");
  mkdirSync(repo);
  mkdirSync(lanes);
  mkdirSync(fakeBin);
  sh("git init -q -b main .", repo);
  sh("git config user.email fixture@example.com && git config user.name Fixture", repo);
  writeFileSync(join(repo, "board.md"), "row one\n");
  writeFileSync(join(repo, "other.md"), "unrelated\n");
  sh("git add -A && git commit -q -m base", repo);
  // No fake systemctl content by default: an empty census, so a test that does
  // not care about units is not at the mercy of the host's real lane units.
  fakeSystemctl(fakeBin, "");
  return { root, repo, lanes, fakeBin };
}

/** A `systemctl` stand-in on PATH: no test-only branch inside the guard itself. */
function fakeSystemctl(binDir: string, output: string): void {
  const path = join(binDir, "systemctl");
  writeFileSync(path, `#!/bin/sh\nprintf '%s' ${JSON.stringify(output)}\n`);
  chmodSync(path, 0o755);
}

/** A lane: a worktree at <lanes>/<name> on `branch`, optionally with a commit touching `file`. */
function lane(f: Fixture, name: string, branch: string, options: { file?: string; text?: string } = {}): string {
  const worktree = join(f.lanes, name);
  sh(`git worktree add -q -b ${branch} ${worktree} main`, f.repo);
  if (options.file) {
    writeFileSync(join(worktree, options.file), options.text ?? "lane rewrote this\n");
    sh(`git add -A && git commit -q -m "lane ${branch}"`, worktree);
  }
  return worktree;
}

function stage(f: Fixture, file: string, text: string): void {
  writeFileSync(join(f.repo, file), text);
  sh(`git add ${file}`, f.repo);
}

function run(f: Fixture, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [guard, "--repo", f.repo, "--lanes-dir", f.lanes, "--target", "main", ...args],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, ...env },
    },
  );
}

// ── The refusal this guard exists for ──────────────────────────────────────

test("refuses a staged file that a live lane branch is rewriting, naming branch and file", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  stage(f, "board.md", "row one\nrow two added by the orchestrator\n");

  const result = run(f);
  expect(result.status).toBe(3);
  expect(result.stderr).toContain("verdict=refused");
  expect(result.stderr).toContain("board.md");
  expect(result.stderr).toContain("ag-v3-5.1");
  // The refusal has to teach: a bare "conflict" would not let the orchestrator
  // decide between waiting and breaking glass.
  expect(result.stderr).toMatch(/board\.md\s+<- ag-v3-5\.1 \(/);
});

test("a live branch that touches a DIFFERENT file does not block the commit", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "other.md" });
  stage(f, "board.md", "row one\nrow two\n");

  const result = run(f);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("verdict=clear");
});

test("uncommitted work in a live lane worktree collides too", () => {
  const f = fixture();
  const worktree = lane(f, "v3-5.1", "ag-v3-5.1");
  writeFileSync(join(worktree, "board.md"), "the lane is mid-edit\n");
  stage(f, "board.md", "row one\nrow two\n");

  const result = run(f);
  expect(result.status).toBe(3);
  expect(result.stderr).toContain("uncommitted");
});

test("an unstaged tracked modification counts by default and is excluded by --staged-only", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  writeFileSync(join(f.repo, "board.md"), "row one\nnot staged yet\n"); // `git commit -a` would carry this

  expect(run(f).status).toBe(3);
  expect(run(f, ["--staged-only"]).status).toBe(0);
});

// ── The liveness census: measured, never listed ────────────────────────────

test("a landed branch does not block, even with its worktree still registered", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  sh("git merge -q --no-ff -m land ag-v3-5.1", f.repo);
  stage(f, "board.md", "the orchestrator edits the landed file\n");

  const result = run(f);
  expect(result.status).toBe(0);
});

test("a lane that recorded a terminal outcome is no longer live", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  writeFileSync(join(f.lanes, "lane-v3-5.1.status"), "state: terminal\nreason: report-valid\nexit: 0\n");
  stage(f, "board.md", "row one\nrow two\n");

  expect(run(f).status).toBe(0);
});

test("a running lane unit keeps a branch live even after its lane recorded terminal", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  writeFileSync(join(f.lanes, "lane-v3-5.1.status"), "state: terminal\nreason: report-valid\nexit: 0\n");
  fakeSystemctl(f.fakeBin, "lane-v3-5.1.service loaded active running lane payload\n");
  stage(f, "board.md", "row one\nrow two\n");

  const result = run(f);
  expect(result.status).toBe(3);
  expect(result.stderr).toContain("running-unit");
});

test("a fixture probe unit that maps to no worktree is counted, not obeyed", () => {
  const f = fixture();
  fakeSystemctl(f.fakeBin, "lane-payload-probe-31337.service loaded active running probe\n");
  stage(f, "board.md", "row one\nrow two\n");

  const result = run(f);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("unmapped-units=1");
});

test("an unlanded ACCEPT is live even with no worktree and no unit", () => {
  const f = fixture();
  const worktree = lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  writeFileSync(join(f.lanes, "ag-v3-5.1.review.md"), "verdict: ACCEPT\nreviewed-sha: deadbeef\n");
  sh(`git worktree remove --force ${worktree}`, f.repo);
  stage(f, "board.md", "row one\nrow two\n");

  const result = run(f);
  expect(result.status).toBe(3);
  expect(result.stderr).toContain("unlanded-accept");
});

test("an ACCEPT whose branch already landed is not live", () => {
  const f = fixture();
  const worktree = lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  writeFileSync(join(f.lanes, "ag-v3-5.1.review.md"), "verdict: ACCEPT\nreviewed-sha: deadbeef\n");
  sh("git merge -q --no-ff -m land ag-v3-5.1", f.repo);
  sh(`git worktree remove --force ${worktree}`, f.repo);
  stage(f, "board.md", "the orchestrator edits the landed file\n");

  expect(run(f).status).toBe(0);
});

test("a REJECT review artifact is not an unlanded ACCEPT", () => {
  const f = fixture();
  const worktree = lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  writeFileSync(join(f.lanes, "ag-v3-5.1.review.md"), "verdict: REJECT\nreviewed-sha: deadbeef\n");
  writeFileSync(join(f.lanes, "lane-v3-5.1.status"), "state: failed\nreason: report-invalid\nexit: 2\n");
  sh(`git worktree remove --force ${worktree}`, f.repo);
  stage(f, "board.md", "row one\nrow two\n");

  expect(run(f).status).toBe(0);
});

test("a lane running the guard in its own worktree does not collide with itself", () => {
  const f = fixture();
  // The lane is live by every signal the census has — registered worktree, no
  // status file, a commit touching board.md — and is committing to board.md
  // again. Refusing here would make the guard unusable inside a lane.
  const worktree = lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  writeFileSync(join(worktree, "board.md"), "the lane's next commit\n");
  sh("git add board.md", worktree);

  const result = spawnSync(
    process.execPath,
    [guard, "--repo", worktree, "--lanes-dir", f.lanes, "--target", "main"],
    { encoding: "utf8", env: { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}` } },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("verdict=clear");
});

// ── A landing is not blocked ───────────────────────────────────────────────

test("a merge in progress clears: a landing commits to files it merged by design", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md", text: "the lane rewrote the board\n" });
  // Make the merge conflict so it stops with MERGE_HEAD present, which is the
  // only state in which a landing ever reaches a separate `git commit`.
  writeFileSync(join(f.repo, "board.md"), "main rewrote the board\n");
  sh("git commit -q -am 'main moves'", f.repo);
  const merge = spawnSync("git", ["merge", "--no-ff", "ag-v3-5.1"], { cwd: f.repo, encoding: "utf8" });
  expect(merge.status).not.toBe(0); // conflicted, as intended
  expect(existsSync(join(f.repo, ".git", "MERGE_HEAD"))).toBe(true);
  writeFileSync(join(f.repo, "board.md"), "resolved\n");
  sh("git add board.md", f.repo);

  const result = run(f);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("reason=merge-in-progress");
});

// ── Break-glass ────────────────────────────────────────────────────────────

test("break-glass clears the refusal, announces on stderr and journals the reason", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  stage(f, "board.md", "row one\nrow two\n");
  const journal = join(f.root, "runtime", "ops-journal.log");

  const result = run(f, [], {
    COMMIT_GUARD_OVERRIDE: "landing ag-v3-5.1 by hand after a conflict",
    ORCH_OPS_JOURNAL: journal,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("verdict=override");
  const written = readFileSync(journal, "utf8");
  expect(written).toContain("COMMIT_GUARD_OVERRIDE");
  expect(written).toContain("landing ag-v3-5.1 by hand after a conflict");
  expect(written).toContain("ag-v3-5.1");
  expect(written).toContain("board.md");
});

test("break-glass set but empty is refused, whatever the verdict would have been", () => {
  const f = fixture();
  stage(f, "board.md", "row one\nrow two\n"); // would otherwise be clear
  const result = run(f, [], { COMMIT_GUARD_OVERRIDE: "" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("MUST carry a reason");
});

test("a clear verdict writes no journal row", () => {
  const f = fixture();
  stage(f, "board.md", "row one\nrow two\n");
  const journal = join(f.root, "runtime", "ops-journal.log");
  const result = run(f, [], { COMMIT_GUARD_OVERRIDE: "not needed here", ORCH_OPS_JOURNAL: journal });
  expect(result.status).toBe(0);
  expect(existsSync(journal)).toBe(false);
});

// ── Usage / fail-closed edges ──────────────────────────────────────────────

test("an unresolvable target is an error, never a clear verdict", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  stage(f, "board.md", "row one\nrow two\n");
  const result = spawnSync(
    process.execPath,
    [guard, "--repo", f.repo, "--lanes-dir", f.lanes, "--target", "origin/main"],
    { encoding: "utf8", env: { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}` } },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("target ref does not resolve");
});

test("a non-repository path is an error, never a clear verdict", () => {
  const f = fixture();
  const result = spawnSync(process.execPath, [guard, "--repo", f.root, "--target", "main"], { encoding: "utf8" });
  expect(result.status).toBe(2);
});

// ── Pure parsers ───────────────────────────────────────────────────────────

test("worktree porcelain yields path and branch, and marks a detached tree", () => {
  const parsed = parseWorktrees(
    "worktree /a\nHEAD 1111\nbranch refs/heads/main\n\nworktree /b\nHEAD 2222\ndetached\n",
  );
  expect(parsed).toEqual([
    { path: "/a", branch: "main", detached: false },
    { path: "/b", detached: true },
  ]);
});

test("lane unit names survive systemd's failed-unit bullet", () => {
  expect(parseLaneUnits("  lane-a.service loaded active running x\n● lane-b.service loaded failed failed y\n"))
    .toEqual(["a", "b"]);
  expect(parseLaneUnits("bpa-telegram-daemon.service loaded active running\n")).toEqual([]);
});

test("only an explicit terminal state ends a lane; absence and noise do not", () => {
  expect(statusIsTerminal("state: terminal\nreason: report-valid\n")).toBe(true);
  expect(statusIsTerminal("state: failed\nreason: report-invalid\n")).toBe(true);
  expect(statusIsTerminal("")).toBe(false);
  expect(statusIsTerminal("state: running\n")).toBe(false);
  expect(statusIsTerminal("the file was truncated mid-write")).toBe(false);
});

test("an ACCEPT must be the single verdict in the artifact", () => {
  expect(reviewIsAccept("verdict: ACCEPT\n")).toBe(true);
  expect(reviewIsAccept("verdict: REJECT\n")).toBe(false);
  expect(reviewIsAccept("verdict: ACCEPT\nverdict: REJECT\n")).toBe(false);
  expect(reviewIsAccept("no verdict here\n")).toBe(false);
});

test("porcelain status keeps a rename's destination and drops never-added files", () => {
  expect(parsePorcelainStatus("M  a.md\0?? new.md\0R  old.md -> new-name.md\0")).toEqual(["a.md", "new-name.md"]);
});

// ── The guard must be able to fail ─────────────────────────────────────────

test("RED-BEFORE: the same fixture clears when the guard is replaced by a stand-in that never refuses", () => {
  const f = fixture();
  lane(f, "v3-5.1", "ag-v3-5.1", { file: "board.md" });
  stage(f, "board.md", "row one\nrow two added by the orchestrator\n");

  // The real guard refuses this fixture...
  expect(run(f).status).toBe(3);

  // ...and a guard that answered "clear" to everything would pass every clear
  // test in this file while failing exactly here. This is the fail-before
  // evidence for the refusal, held in the suite rather than in a transcript.
  const stand_in = join(f.root, "always-clear.ts");
  writeFileSync(stand_in, "process.stdout.write('COMMIT-GUARD verdict=clear paths=0 live=0 unmapped-units=0\\n');\n");
  const neutered = spawnSync(
    process.execPath,
    [stand_in, "--repo", f.repo, "--lanes-dir", f.lanes, "--target", "main"],
    { encoding: "utf8", env: { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}` } },
  );
  expect(neutered.status).toBe(0);
  expect(neutered.status).not.toBe(3);
});
