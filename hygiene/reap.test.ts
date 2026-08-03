import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This file IS the executor for hygiene/reap.sh and hygiene/install-cron.sh.
//
// The donor line (v2-deprecated) tracked hygiene/reap.sh and never wired it
// into anything except a soak test, and tracked hygiene/install-cron.sh and
// never invoked it (`crontab -l` on the host returned "no crontab for root").
// That is why the repository reached 1372 branches / 1393 worktrees before a
// manual reap. Placing these tests here means the landing gate's declared
// checks run them on every candidate (gate/land-lib.sh's
// `land_run_declared_checks` globs every tracked *.test.ts and runs it with
// `bun test`), so the reaper cannot go inert the same way again without a
// landing failing -- see tools/check-decision-ledger-drift.test.ts for the
// precedent this follows.
//
// These tests prove the REFUSALS, not just the deletions (Hard Floor 7: a
// reap test that only proves deletion would pass just as well with a reaper
// that deletes everything). Each refusal case was checked by hand against the
// actual donor script (`git show v2-deprecated:hygiene/reap.sh`) during
// development to confirm it is a real regression fix, not a restated no-op:
// the donor force-removes a worktree and deletes its branch whenever the
// branch is merged, so seeding a merged branch behind a clean worktree and
// running the donor script against it deletes both. hygiene/reap.sh refuses.

const repoRoot = join(import.meta.dir, "..");
const reap = join(repoRoot, "hygiene", "reap.sh");
const installCron = join(repoRoot, "hygiene", "install-cron.sh");

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const dir = cleanup.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function sh(command: string, cwd: string): string {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function run(args: string[]) {
  return spawnSync("bash", [reap, ...args], { encoding: "utf8" });
}

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hygiene-reap-"));
  cleanup.push(dir);
  return dir;
}

// Builds a repo with:
//  - main, one commit
//  - "merged": branched from main, no extra commits (trivially an ancestor)
//  - "unmerged": branched from main with an extra commit, never merged
//  - "worktree-held": branched from main, merged into main (ancestor), but
//    checked out in a live worktree at the time of the sweep
//  - "stale-merged": branched from main, merged into main, authored/committed
//    far in the past, to exercise the age-reporting arithmetic too
function buildFixture(): { dir: string; repo: string; worktree: string } {
  const dir = fixtureDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh("git init -q -b main .", repo);
  sh("git config user.email hygiene@example.test", repo);
  sh("git config user.name Hygiene", repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh("git add base.txt && git commit -qm base", repo);

  sh("git branch merged", repo);
  sh("git branch stale-merged", repo);
  sh("git branch worktree-held", repo);

  sh("git checkout -qb unmerged", repo);
  writeFileSync(join(repo, "unmerged.txt"), "unmerged\n");
  sh("git add unmerged.txt", repo);
  sh(
    "GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z' git commit -qm unmerged",
    repo,
  );
  sh("git checkout -q main", repo);

  const worktree = join(dir, "worktree-held-wt");
  sh(`git worktree add -q ${JSON.stringify(worktree)} worktree-held`, repo);

  return { dir, repo, worktree };
}

test("a branch held by a live worktree survives dry-run and --apply, even though merged", () => {
  const { repo, worktree } = buildFixture();
  const dry = run(["branches", "--repo", repo]);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toContain("held by live worktree, refusing: worktree-held");

  const apply = run(["branches", "--repo", repo, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("held by live worktree, refusing: worktree-held");
  expect(sh("git show-ref --verify --quiet refs/heads/worktree-held && echo present", repo).trim()).toBe(
    "present",
  );
  expect(existsSync(worktree)).toBe(true);
});

test("an unmerged branch with no disposition is never deleted", () => {
  const { repo } = buildFixture();
  const dry = run(["branches", "--repo", repo]);
  expect(dry.stdout).toContain("unmerged stale branch (report-only, no disposition): unmerged");

  const apply = run(["branches", "--repo", repo, "--apply"]);
  expect(apply.status).toBe(0);
  expect(sh("git show-ref --verify --quiet refs/heads/unmerged && echo present", repo).trim()).toBe(
    "present",
  );
});

test("a genuinely stale merged branch is reported, then deleted under --apply", () => {
  const { repo } = buildFixture();
  const dry = run(["branches", "--repo", repo]);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toContain("merged branch: stale-merged");
  // Dry run must not have mutated anything.
  expect(sh("git show-ref --verify --quiet refs/heads/stale-merged && echo present", repo).trim()).toBe(
    "present",
  );

  const apply = run(["branches", "--repo", repo, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("deleting merged branch: stale-merged");
  const check = spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/stale-merged"], {
    cwd: repo,
  });
  expect(check.status).not.toBe(0);

  // The plain "merged" branch (no worktree) goes the same way.
  expect(sh("git branch --list merged", repo).trim()).toBe("");
});

test("the default branch and the instance-file protect list survive --apply unconditionally", () => {
  const { repo } = buildFixture();
  sh("git branch v3", repo); // merged, no worktree -- would be deletable but for the protect list
  const apply = run(["branches", "--repo", repo, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("protected branch, refusing: v3");
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
  expect(sh("git show-ref --verify --quiet refs/heads/main && echo present", repo).trim()).toBe("present");
});

test("--protect adds a caller-supplied name to the refusal list", () => {
  const { repo } = buildFixture();
  const apply = run(["branches", "--repo", repo, "--protect", "merged", "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("protected branch, refusing: merged");
  expect(sh("git show-ref --verify --quiet refs/heads/merged && echo present", repo).trim()).toBe("present");
});

test("an explicit disposition deletes an otherwise-unmerged branch; no disposition never does", () => {
  const { dir, repo } = buildFixture();
  const dispositions = join(dir, "dispositions.txt");
  writeFileSync(dispositions, "unmerged operator ruling: abandoned experiment, safe to drop\n");
  const apply = run(["branches", "--repo", repo, "--dispositions", dispositions, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("dispositioned branch: unmerged: operator ruling");
  expect(apply.stdout).toContain("deleting dispositioned branch: unmerged");
  const check = spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/unmerged"], { cwd: repo });
  expect(check.status).not.toBe(0);
});

test("worktrees: dry-run reports orphaned metadata without pruning; --apply prunes only that", () => {
  const { dir, repo, worktree } = buildFixture();
  const orphan = join(dir, "orphan-wt");
  sh(`git worktree add -q ${JSON.stringify(orphan)} -b orphan-branch`, repo);
  rmSync(orphan, { recursive: true, force: true }); // directory gone, git metadata still there

  const dry = run(["worktrees", "--repo", repo]);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toContain("orphaned worktree metadata:");
  expect(sh("git worktree list --porcelain", repo)).toContain(`worktree ${orphan}`);

  const apply = run(["worktrees", "--repo", repo, "--apply"]);
  expect(apply.status).toBe(0);
  const list = sh("git worktree list --porcelain", repo);
  expect(list).not.toContain(`worktree ${orphan}`);
  // The live worktree, never orphaned, must be untouched.
  expect(list).toContain(`worktree ${worktree}`);
  expect(existsSync(worktree)).toBe(true);
});

test("--help is side-effect-free and both subcommands reject unknown flags", () => {
  const { repo } = buildFixture();
  const before = sh("git show-ref --heads", repo);
  const help = run(["--help"]);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Usage: reap.sh");
  const after = sh("git show-ref --heads", repo);
  expect(after).toBe(before);

  const bad = run(["branches", "--repo", repo, "--nonsense"]);
  expect(bad.status).not.toBe(0);
});

// --- install-cron.sh -------------------------------------------------------
//
// Exercised against a fake `crontab` command, exactly like the donor's own
// test did (`git show v2-deprecated:hygiene/reap.test.sh`), so this proves
// the script is correct without ever touching a real crontab. This lane does
// not invoke install-cron.sh against the host's actual crontab -- arming a
// real timer is deferred to V3-1.1 (bootstrap/), see hygiene/install-cron.sh.

function fakeCrontab(dir: string): { cmd: string; cronFile: string } {
  const cmd = join(dir, "fake-crontab.sh");
  const cronFile = join(dir, "crontab");
  writeFileSync(
    cmd,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "-l" ]]; then',
      '  [[ -f "$FAKE_CRONTAB_FILE" ]] && cat "$FAKE_CRONTAB_FILE"',
      "else",
      '  cp "$1" "$FAKE_CRONTAB_FILE"',
      "fi",
      "",
    ].join("\n"),
  );
  spawnSync("chmod", ["+x", cmd]);
  writeFileSync(cronFile, "MAILTO=hygiene@example.test\n");
  return { cmd, cronFile };
}

test("install-cron.sh installs an idempotent, deterministic managed block and can uninstall it", () => {
  const dir = fixtureDir();
  const { cmd, cronFile } = fakeCrontab(dir);
  const logDir = join(dir, "logs");
  const env = { ...process.env, FAKE_CRONTAB_FILE: cronFile, CRONTAB_CMD: cmd, HYGIENE_LOG_DIR: logDir };

  const install1 = spawnSync("bash", [installCron], { encoding: "utf8", env });
  expect(install1.status).toBe(0);
  const contentsAfterFirst = sh(`cat ${JSON.stringify(cronFile)}`, dir);
  expect(contentsAfterFirst).toContain("# BEGIN bpa-dev-infrastructure hygiene");
  expect(contentsAfterFirst).toContain("MAILTO=hygiene@example.test");
  expect(contentsAfterFirst).toContain("reap.sh branches");
  expect(contentsAfterFirst).toContain("reap.sh worktrees");

  const install2 = spawnSync("bash", [installCron], { encoding: "utf8", env });
  expect(install2.status).toBe(0);
  const contentsAfterSecond = sh(`cat ${JSON.stringify(cronFile)}`, dir);
  expect(contentsAfterSecond).toBe(contentsAfterFirst);

  const uninstall = spawnSync("bash", [installCron, "--uninstall"], {
    encoding: "utf8",
    env: { ...process.env, FAKE_CRONTAB_FILE: cronFile, CRONTAB_CMD: cmd },
  });
  expect(uninstall.status).toBe(0);
  const contentsAfterUninstall = sh(`cat ${JSON.stringify(cronFile)}`, dir);
  expect(contentsAfterUninstall).not.toContain("# BEGIN bpa-dev-infrastructure hygiene");
  expect(contentsAfterUninstall).toContain("MAILTO=hygiene@example.test");
});
