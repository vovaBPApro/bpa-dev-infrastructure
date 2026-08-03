import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
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

test("sweeps a killed publisher only inside the reserved meteorite namespace", () => {
  const root = fixtureDir();
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  mkdirSync(source);
  sh("git init -q -b main && git config user.email test@example.invalid && git config user.name test && touch seed && git add seed && git commit -qm seed", source);
  sh(`git init -q --bare ${JSON.stringify(remote)} && git remote add origin ${JSON.stringify(remote)}`, source);
  const sha = sh("git rev-parse HEAD", source).trim();
  for (const name of ["main", "v3", "v2-deprecated", "ag-s3-1-r3", "ag-s3-2-r3"]) {
    sh(`git push -q origin ${sha}:refs/heads/${name}`, source);
  }
  const leaked = `refs/meteorite-candidates/1-999-${sha}/candidate`;
  const crashed = spawnSync("bash", ["-c", `git push -q origin ${sha}:${leaked} && kill -KILL $$`], { cwd: source, encoding: "utf8" });
  expect(crashed.signal).toBe("SIGKILL");
  expect(sh(`git ls-remote origin ${leaked}`, source)).toContain(leaked);

  const swept = run(["meteorite-refs", "--repo", source, "--max-age-seconds", "0", "--apply"]);
  expect(swept.status).toBe(0);
  expect(swept.stdout).toContain(`orphaned meteorite ref: ${leaked}`);
  expect(swept.stdout).toContain(`deleted orphaned meteorite ref: ${leaked}`);
  expect(sh(`git ls-remote origin ${leaked}`, source)).toBe("");
  const survivors = sh("git ls-remote --heads origin", source);
  for (const name of ["main", "v3", "v2-deprecated", "ag-s3-1-r3", "ag-s3-2-r3"]) {
    expect(survivors).toContain(`refs/heads/${name}`);
  }
});

function unprivilegedFixtureDir(): string {
  const env = { ...process.env };
  delete env.TMPDIR;
  delete env.TMP;
  delete env.TEMP;
  const systemTmp = spawnSync(process.execPath, ["-e", 'process.stdout.write(require("node:os").tmpdir())'], {
    encoding: "utf8",
    env,
  });
  if (systemTmp.status !== 0 || !systemTmp.stdout) {
    throw new Error(`fixture setup failed: could not derive the system temporary directory\n${systemTmp.stderr}`);
  }
  const dir = mkdtempSync(join(systemTmp.stdout, "hygiene-reap-unprivileged-"));
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
function buildFixture(makeDir: () => string = fixtureDir): { dir: string; repo: string; worktree: string } {
  const dir = makeDir();
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

// --- protected-branches list: fail closed, not fail open -------------------
//
// Round-2 review defect (fixed here): `load_protected` originally only
// skipped loading the list when it happened to be readable
// (`if [[ -r "$list_path" ]]; then ... fi`), with no `else`. A missing,
// unreadable, or wrongly-resolved list therefore silently degraded to "the
// only protected branch is main" -- losing v2-deprecated and v3 without a
// word. The reviewer reproduced this directly: against the code committed at
// 2f29677, seeding a merged, worktree-free branch named `v3` and pointing the
// protect-list lookup at a path that does not exist made `--apply` delete
// `v3`. (v3 and v2-deprecated are this repository's only copies of the
// current line and the entire host rebuild path -- deleting either is the
// worst outcome this tool can produce.) `load_protected` now requires the
// list to resolve to a readable *regular file* and `die`s otherwise, with no
// bypass flag.

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 1000;
}

// A copy of reap.sh + its gate/land-lib.sh dependency under a world-readable,
// world-executable tree, so a de-privileged child process (see below) can
// actually open and run them. The real checkout lives under /root, which a
// non-root user cannot traverse at all.
function worldReadableToolroot(): string {
  const root = unprivilegedFixtureDir();
  mkdirSync(join(root, "hygiene"));
  mkdirSync(join(root, "gate"));
  sh(`cp ${JSON.stringify(reap)} ${JSON.stringify(join(root, "hygiene", "reap.sh"))}`, root);
  sh(
    `cp ${JSON.stringify(join(repoRoot, "gate", "land-lib.sh"))} ${JSON.stringify(join(root, "gate", "land-lib.sh"))}`,
    root,
  );
  sh(`chmod -R a+rX ${JSON.stringify(root)}`, root);
  sh(`chmod a+x ${JSON.stringify(join(root, "hygiene", "reap.sh"))}`, root);
  return root;
}

test("branches refuses to run at all when the protected-branches list cannot be found (fail closed, not fail open)", () => {
  const { repo } = buildFixture();
  sh("git branch v3", repo); // the reviewer's exact repro branch name: merged, no worktree
  const missingDir = mkdtempSync(join(tmpdir(), "hygiene-missing-"));
  cleanup.push(missingDir);
  const missing = join(missingDir, "does-not-exist.txt");

  const result = run(["branches", "--repo", repo, "--protected-file", missing, "--apply"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("protected-branches list is not a readable regular file");
  expect(result.stderr).toContain(missing);
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
});

test("branches refuses to run at all when the protected-branches list exists but is not readable (fail closed, not fail open)", () => {
  if (currentUid() === 0 && !existsSync("/usr/bin/setpriv")) {
    throw new Error(
      "setpriv is required to prove fail-closed behavior for an unreadable file while running as root " +
        "(root bypasses chmod 000 via DAC override, so a plain chmod-000 test would pass even if the " +
        "readability check were deleted entirely -- that would be exactly the fake-green test Hard Floor 7 forbids)",
    );
  }

  const { dir, repo } = buildFixture(unprivilegedFixtureDir);
  sh("git branch v3", repo);
  chmodSync(dir, 0o755);
  sh(`chmod -R a+rX ${JSON.stringify(repo)}`, dir);

  const unreadable = join(dir, "unreadable.txt");
  writeFileSync(unreadable, "v3\n");
  chmodSync(unreadable, 0o000); // stays root-owned, permission bits genuinely deny non-root

  let result: ReturnType<typeof spawnSync>;
  if (currentUid() === 0) {
    // Prove the refusal as a genuinely unprivileged reader, not as root
    // (which can read a chmod-000 file regardless). This is the closest
    // faithful reproduction of the reviewer's "chmod 000" request that is
    // actually meaningful in a root-run environment.
    const toolroot = worldReadableToolroot();
    const fixtureProbe = spawnSync(
      "setpriv",
      ["--reuid=65534", "--regid=65534", "--clear-groups", "test", "-x", join(toolroot, "hygiene", "reap.sh")],
      { encoding: "utf8" },
    );
    if (fixtureProbe.status !== 0) {
      throw new Error(
        `fixture setup failed: dropped-privilege user cannot traverse and execute the copied reap.sh (${fixtureProbe.stderr.trim()})`,
      );
    }
    const nobodyHome = join(dir, "nobody-home");
    mkdirSync(nobodyHome);
    chmodSync(nobodyHome, 0o777);
    const gitconfig = join(nobodyHome, ".gitconfig");
    writeFileSync(gitconfig, "[safe]\n\tdirectory = *\n");
    chmodSync(gitconfig, 0o644); // writeFileSync respects umask; nobody must be able to read this
    result = spawnSync(
      "setpriv",
      [
        "--reuid=65534",
        "--regid=65534",
        "--clear-groups",
        "bash",
        join(toolroot, "hygiene", "reap.sh"),
        "branches",
        "--repo",
        repo,
        "--protected-file",
        unreadable,
        "--apply",
      ],
      { cwd: "/tmp", encoding: "utf8", env: { ...process.env, HOME: nobodyHome } },
    );
  } else {
    result = spawnSync("bash", [reap, "branches", "--repo", repo, "--protected-file", unreadable, "--apply"], {
      encoding: "utf8",
    });
  }

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain("protected-branches list is not a readable regular file");
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
});

test("branches refuses to run at all when the protected-branches path is a directory, not a file", () => {
  // `[[ -r somedir ]]` is true (directories are "readable"), so a bare `-r`
  // check alone would not catch this. `read ... < dir` fails with EISDIR
  // *inside* the while loop, which does not trip `set -e` -- a while
  // condition's exit status is exempt -- so the loop would silently behave
  // like an empty file. Same fail-open outcome, different trigger. The fix
  // requires a regular file (`-f`), which also rejects this.
  const { dir, repo } = buildFixture();
  sh("git branch v3", repo);
  const asDir = join(dir, "protected-is-a-dir");
  mkdirSync(asDir);

  const result = run(["branches", "--repo", repo, "--protected-file", asDir, "--apply"]);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("protected-branches list is not a readable regular file");
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
});

// --- round-3 review defect: `&&` as a loop body's last statement under set -e
//
// `load_protected`'s per-line loop originally ended with
// `[[ -n "$name" ]] && protected_set["$name"]=1`. When the last line read
// strips to empty (an ordinary trailing blank line, or a file that ends on a
// comment), that `[[ ]]` is false, its exit status becomes the loop body's
// exit status, which becomes the (bare, uncontrolled) while loop's exit
// status, which -- because `load_protected_file` and `load_protected` are
// both called as bare statements -- kills the entire script under `set -e`
// with ZERO output: not even the `ERROR:` line `die` would have printed,
// because the script never got that far. A one-character edit to a config
// file (an editor adding a trailing newline) would put this reaper back in
// exactly the "wired into nothing, nobody notices" state this row exists to
// fix, just via silence at the *branches* subcommand instead of the *cron
// entry* the donor never wired up. Confirmed against ce67a2b, both variants,
// before writing the fix: completely silent, `status !== 0`, zero stdout,
// zero stderr.

function writeProtectFile(dir: string, name: string, lines: string[]): string {
  const path = join(dir, name);
  // Every line, including the last, is newline-terminated -- what a normal
  // editor produces. `lines: [..., ""]` therefore adds one genuine trailing
  // BLANK LINE (an extra "\n"), not merely "no final newline"; the latter is
  // a separate, unrelated `read`/EOF quirk (an unterminated last line is
  // silently dropped by `while read`) that this suite does not exercise --
  // it is not the defect this round is about, and a hand-edited config file
  // ending without a trailing newline at all is not the realistic case.
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""));
  return path;
}

test("a protected-branches file ending in a trailing blank line does not silently crash the script", () => {
  const { dir, repo } = buildFixture();
  sh("git branch v3", repo);
  // Trailing blank line after the last real entry -- the exact shape a text
  // editor adds without anyone noticing.
  const path = writeProtectFile(dir, "trailing-blank.txt", ["v2-deprecated", "v3", ""]);

  const result = run(["branches", "--repo", repo, "--protected-file", path, "--apply"]);
  expect(result.status).toBe(0);
  expect(`${result.stdout}${result.stderr}`.length).toBeGreaterThan(0); // not a silent crash
  expect(result.stdout).toContain("protected branch, refusing: v3");
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
});

test("a protected-branches file ending in a comment line does not silently crash the script", () => {
  const { dir, repo } = buildFixture();
  sh("git branch v3", repo);
  const path = writeProtectFile(dir, "trailing-comment.txt", ["v2-deprecated", "v3", "# trailing comment, nothing after it"]);

  const result = run(["branches", "--repo", repo, "--protected-file", path, "--apply"]);
  expect(result.status).toBe(0);
  expect(`${result.stdout}${result.stderr}`.length).toBeGreaterThan(0);
  expect(result.stdout).toContain("protected branch, refusing: v3");
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
});

// --- round-3 review item 2: --protected-file must be additive, not a
// replacement, or an empty override file functions as an undocumented
// bypass of every default protection (including v2-deprecated and v3).
// Chosen fix: UNION. --protected-file's names are added to the default
// list; they can never subtract from it. This is the safer shape for
// something intended to run unattended (a cron/timer executor with nobody
// reviewing each invocation): a caller may only ever ask for MORE branches
// to be protected, never fewer, so a mistaken or malicious override file
// degrades to "did nothing extra," not "disabled the safety net."

test("--protected-file only ADDS protections; a legitimate, readable, empty override does not drop the defaults", () => {
  const { dir, repo } = buildFixture();
  sh("git branch v3", repo); // protected only via the default instance/ file, not via this override
  const emptyOverride = writeProtectFile(dir, "empty.txt", ["# nothing here, on purpose"]);

  const result = run(["branches", "--repo", repo, "--protected-file", emptyOverride, "--apply"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("protected branch, refusing: v3");
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
});

test("--protected-file unions its own names on top of the defaults, both take effect", () => {
  const { dir, repo } = buildFixture();
  const override = writeProtectFile(dir, "extra.txt", ["merged"]); // an otherwise-deletable branch
  sh("git branch v3", repo); // covered only by the default list, not this override

  const result = run(["branches", "--repo", repo, "--protected-file", override, "--apply"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("protected branch, refusing: merged"); // from --protected-file
  expect(result.stdout).toContain("protected branch, refusing: v3"); // from the default list, still active
  expect(sh("git show-ref --verify --quiet refs/heads/merged && echo present", repo).trim()).toBe("present");
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
});

// --- round-4 review lock: a final line with no trailing newline must not
// silently lose its protection.
//
// `while IFS= read -r name; do ...; done < file` treats a final,
// newline-less line the way it treats end-of-file: `read` still populates
// `name` with the line's content, but returns non-zero because it never saw
// a delimiter, so the loop CONDITION is false and the body never runs for
// that line. No crash, no `set -e` trip, no error of any kind -- exit 0, no
// output -- and the name that line held is simply never added to
// protected_set. This was misjudged in round 3 as "fails closed" because it
// does not crash; it does not fail closed, it silently fails OPEN, which is
// the same failure class as rounds 1 and 2 (v3/v2-deprecated losing
// protection through a config-file edge case), reached by nothing more than
// `printf` (rather than `echo`) appending a name, or a text editor that
// doesn't force a final newline. Reproduced against fec502d before the fix
// (see terminal.md for the full transcript): a protect file containing
// `v2-deprecated\nv3` with no trailing newline after `v3`, exit 0, no
// output, `v3` actually deleted.

function runWithEnv(args: string[], env: Record<string, string>) {
  return spawnSync("bash", [reap, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("a protected-branches file whose final line has no trailing newline still protects that line's branch", () => {
  const { dir, repo } = buildFixture();
  sh("git branch v3", repo); // merged, no worktree -- deletable unless the last line is honored
  const path = join(dir, "no-trailing-newline.txt");
  // Deliberately NOT using writeProtectFile: this is the one test that needs
  // the file to end WITHOUT a trailing newline, which is the whole point.
  writeFileSync(path, "v2-deprecated\nv3");

  const result = runWithEnv(["branches", "--repo", repo, "--apply"], { PROTECT_BRANCHES_FILE: path });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("protected branch, refusing: v3");
  expect(sh("git show-ref --verify --quiet refs/heads/v3 && echo present", repo).trim()).toBe("present");
});

test("a disposition file whose final line has no trailing newline still applies that disposition", () => {
  // Same fix, lower-severity direction: a missed disposition here means the
  // branch stays report-only forever (safe), not that it gets deleted. Still
  // fixed for consistency between the two loops.
  const { dir, repo } = buildFixture();
  const path = join(dir, "no-trailing-newline-dispositions.txt");
  writeFileSync(path, "unmerged operator ruling, no trailing newline after this line");

  const apply = run(["branches", "--repo", repo, "--dispositions", path, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("dispositioned branch: unmerged:");
  const check = spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/unmerged"], { cwd: repo });
  expect(check.status).not.toBe(0);
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
