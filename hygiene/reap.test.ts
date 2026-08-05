import { test, expect, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
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
  expect(contentsAfterFirst).toContain("check-retained-branches.ts --repo");

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

// --- V3-5.13: the two operations the reaper did not have -------------------
//
// Measured at the base commit, before any of this existed:
//   - `reap.sh remote-branches` -> "unknown subcommand". There was no remote
//     operation at all, so every remote deletion in the last sweep was done by
//     hand, guarded ad hoc.
//   - a merged branch behind a worktree that still exists: `branches --apply`
//     exits 0 and deletes nothing, because git will not delete a checked-out
//     branch; `worktrees --apply` prints "no orphaned worktrees" and removes
//     nothing, because it only pruned ORPHANED metadata. Neither command could
//     break the other's deadlock, and that is why 54 branches were unreapable.
//   - a merged branch that exists only on the remote appears in NO output: the
//     inventory walked refs/heads and never said so.
//
// These tests prove the refusals as hard as the deletions. A reaper that
// deletes everything passes any test that only checks that something was
// deleted -- and this tool's failure mode is not "it does not run", it is "it
// removes work nobody has a copy of".

const livePids: number[] = [];
afterEach(() => {
  while (livePids.length) {
    const pid = livePids.pop();
    if (pid === undefined) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone -- the point was that it was alive DURING the sweep
    }
  }
});

// Starts a real process whose working directory is inside `dir`, and does not
// return until the kernel actually reports it there. A fake /proc would prove
// nothing about the probe that runs on the host; this is the same signal a
// running lane produces, produced the same way.
function spawnLaneIn(dir: string): number {
  const started = spawnSync(
    "bash",
    ["-c", `cd ${JSON.stringify(dir)} && exec sleep 300 >/dev/null 2>&1 & echo $!`],
    { encoding: "utf8" },
  );
  const pid = Number(started.stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`fixture setup failed: no lane pid\n${started.stdout}\n${started.stderr}`);
  }
  livePids.push(pid);
  const target = realpathSync(dir);
  for (let attempt = 0; attempt < 500; attempt++) {
    let cwd = "";
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = "";
    }
    if (cwd === target) return pid;
    spawnSync("sleep", ["0.01"]);
  }
  throw new Error(`fixture setup failed: lane process ${pid} never entered ${dir}`);
}

// A repo with a real remote, holding one landed lane branch, one lane branch
// that never landed, and one protected branch -- all three present on the
// remote, which is where the reaper could not previously look.
function buildRemoteFixture(): { dir: string; repo: string; remote: string } {
  const dir = fixtureDir();
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  mkdirSync(repo);
  sh("git init -q -b main .", repo);
  sh("git config user.email hygiene@example.test", repo);
  sh("git config user.name Hygiene", repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh("git add base.txt && git commit -qm base", repo);
  sh(`git init -q --bare ${JSON.stringify(remote)}`, repo);
  sh(`git remote add origin ${JSON.stringify(remote)}`, repo);
  sh("git push -q origin main", repo);

  sh("git checkout -qb ag-merged-remote", repo);
  writeFileSync(join(repo, "landed.txt"), "landed\n");
  sh("git add landed.txt && git commit -qm landed", repo);
  sh("git push -q origin ag-merged-remote", repo);
  sh("git checkout -q main", repo);
  sh("git merge -q --no-ff -m 'merge ag-merged-remote' ag-merged-remote", repo);
  sh("git push -q origin main", repo);

  sh("git checkout -qb ag-unmerged-remote main", repo);
  writeFileSync(join(repo, "wip.txt"), "wip nobody else has\n");
  sh("git add wip.txt && git commit -qm wip", repo);
  sh("git push -q origin ag-unmerged-remote", repo);
  sh("git checkout -q main", repo);

  sh("git branch v3 main", repo); // on the instance protect list
  sh("git push -q origin v3", repo);

  return { dir, repo, remote };
}

test("remote-branches: reaps a merged remote branch, retains an unmerged one, refuses a protected one", () => {
  const { repo } = buildRemoteFixture();
  // Drop the local refs: these are now exactly the remote-only branches that
  // were invisible to the old inventory as well as to the old reaper.
  sh("git branch -D ag-merged-remote ag-unmerged-remote", repo);

  const dry = run(["remote-branches", "--repo", repo]);
  expect(dry.status).toBe(0);
  expect(dry.stdout).toContain("merged remote branch: origin/ag-merged-remote");
  expect(dry.stdout).toContain("unmerged remote branch (report-only, no disposition): origin/ag-unmerged-remote");
  expect(dry.stdout).toContain("protected remote branch, refusing: origin/v3");
  expect(dry.stdout).toContain("protected remote branch, refusing: origin/main");
  // Dry run mutates nothing at all.
  expect(sh("git ls-remote --heads origin", repo)).toContain("refs/heads/ag-merged-remote");

  const apply = run(["remote-branches", "--repo", repo, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("deleted merged remote branch: origin/ag-merged-remote");
  const heads = sh("git ls-remote --heads origin", repo);
  expect(heads).not.toContain("refs/heads/ag-merged-remote");
  expect(heads).toContain("refs/heads/ag-unmerged-remote");
  expect(heads).toContain("refs/heads/v3");
  expect(heads).toContain("refs/heads/main");
});

test("remote-branches: a merged remote branch whose lane is still running is refused", () => {
  const { dir, repo } = buildRemoteFixture();
  const lane = join(dir, "lane-wt");
  sh(`git worktree add -q ${JSON.stringify(lane)} ag-merged-remote`, repo);
  spawnLaneIn(lane);

  const apply = run(["remote-branches", "--repo", repo, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("remote branch held by a live lane, refusing: origin/ag-merged-remote");
  expect(apply.stdout).toContain("process-working-inside");
  expect(sh("git ls-remote --heads origin", repo)).toContain("refs/heads/ag-merged-remote");
});

test("remote-branches: a remote branch whose tip moved since it was measured is retained, not raced away", () => {
  const { dir, repo } = buildRemoteFixture();
  const lane = join(dir, "lane-wt");
  sh(`git worktree add -q ${JSON.stringify(lane)} ag-merged-remote`, repo);
  // --liveness-cmd is the one hook this script runs immediately before it
  // acts, which makes it the honest place to stage a concurrent push: a real
  // racing lane lands in exactly this window. The probe reports the lane
  // terminal (exit 1) so the sweep proceeds to the delete it must then refuse.
  const racer = join(dir, "racer.sh");
  writeFileSync(
    racer,
    [
      "#!/usr/bin/env bash",
      `git -C ${JSON.stringify(repo)} push -q --force origin main:ag-merged-remote`,
      "exit 1",
    ].join("\n"),
  );
  chmodSync(racer, 0o755);

  const apply = run(["remote-branches", "--repo", repo, "--apply", "--liveness-cmd", racer]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain(
    "remote refused the delete (tip moved since it was measured?), retaining: origin/ag-merged-remote",
  );
  expect(sh("git ls-remote --heads origin", repo)).toContain("refs/heads/ag-merged-remote");
});

test("branches: names and counts the remote-only branches it cannot see, instead of reading as complete", () => {
  const { repo } = buildRemoteFixture();
  sh("git branch -D ag-merged-remote ag-unmerged-remote", repo);

  const out = run(["branches", "--repo", repo]);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("remote-only branch, invisible to refs/heads: origin/ag-merged-remote");
  expect(out.stdout).toContain("remote-only branch, invisible to refs/heads: origin/ag-unmerged-remote");
  expect(out.stdout).toContain("remote-only branches: 2");
});

test("branches: says out loud when it could not look at the remote at all", () => {
  const { dir, repo } = buildRemoteFixture();
  sh(`git remote set-url origin ${JSON.stringify(join(dir, "no-such-remote.git"))}`, repo);

  const out = run(["branches", "--repo", repo]);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("remote inventory: UNAVAILABLE from 'origin'");
  expect(out.stdout).toContain("covered refs/heads ONLY");
});

test("a merged branch behind a terminal worktree is reaped, worktree FIRST -- the deadlock that stranded the branches", () => {
  const { repo, worktree } = buildFixture();

  // The default is unchanged: any worktree still refuses its branch outright.
  const guarded = run(["branches", "--repo", repo, "--apply"]);
  expect(guarded.status).toBe(0);
  expect(guarded.stdout).toContain("held by live worktree, refusing: worktree-held");
  expect(existsSync(worktree)).toBe(true);

  const apply = run(["branches", "--repo", repo, "--with-worktrees", "--apply"]);
  expect(apply.status).toBe(0);
  const removedAt = apply.stdout.indexOf(`removed terminal worktree: ${worktree}`);
  const deletedAt = apply.stdout.indexOf("deleted merged branch: worktree-held");
  expect(removedAt).toBeGreaterThan(-1);
  expect(deletedAt).toBeGreaterThan(-1);
  // Order is the whole point, not a coincidence of both happening: git cannot
  // delete a checked-out branch, so worktree-then-branch is the only sequence
  // that works, and the reverse would silently leave the branch behind.
  expect(removedAt).toBeLessThan(deletedAt);
  expect(existsSync(worktree)).toBe(false);
  const check = spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/worktree-held"], { cwd: repo });
  expect(check.status).not.toBe(0);
});

test("worktrees: a running lane's worktree is refused, and its branch survives with it", () => {
  const { repo, worktree } = buildFixture();
  spawnLaneIn(worktree);

  const apply = run(["worktrees", "--repo", repo, "--apply", "--terminal"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain(`live worktree, refusing: ${worktree}`);
  expect(apply.stdout).toContain("process-working-inside");
  expect(existsSync(worktree)).toBe(true);
  expect(sh("git show-ref --verify --quiet refs/heads/worktree-held && echo present", repo).trim()).toBe(
    "present",
  );
});

test("worktrees: classification is always reported; removal needs --apply --terminal", () => {
  const { repo, worktree } = buildFixture();

  const report = run(["worktrees", "--repo", repo]);
  expect(report.status).toBe(0);
  expect(report.stdout).toContain(`terminal worktree: ${worktree}`);
  expect(existsSync(worktree)).toBe(true);

  const unarmed = run(["worktrees", "--repo", repo, "--apply"]);
  expect(unarmed.status).toBe(0);
  expect(unarmed.stdout).toContain(`not removing without --terminal: ${worktree}`);
  expect(existsSync(worktree)).toBe(true);

  const armed = run(["worktrees", "--repo", repo, "--apply", "--terminal"]);
  expect(armed.status).toBe(0);
  expect(armed.stdout).toContain(`removed terminal worktree: ${worktree}`);
  expect(existsSync(worktree)).toBe(false);
});

test("a dirty worktree is refused even when its branch is merged, and the uncommitted file survives", () => {
  const { repo, worktree } = buildFixture();
  writeFileSync(join(worktree, "uncommitted.txt"), "work nobody else has a copy of\n");

  const apply = run(["branches", "--repo", repo, "--with-worktrees", "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("held by live worktree, refusing: worktree-held");
  expect(apply.stdout).toContain("dirty-worktree");
  expect(existsSync(join(worktree, "uncommitted.txt"))).toBe(true);
  expect(sh("git show-ref --verify --quiet refs/heads/worktree-held && echo present", repo).trim()).toBe(
    "present",
  );
});

test("an interrupted rebase in a clean-looking worktree is refused", () => {
  const { repo, worktree } = buildFixture();
  const gitDir = sh("git rev-parse --absolute-git-dir", worktree).trim();
  mkdirSync(join(gitDir, "rebase-merge"), { recursive: true });

  const apply = run(["worktrees", "--repo", repo, "--apply", "--terminal"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("operation-in-progress=rebase-merge");
  expect(existsSync(worktree)).toBe(true);
});

test("liveness is re-measured at the moment of removal, not once at classification", () => {
  const { dir, repo, worktree } = buildFixture();
  const counter = join(dir, "probe-calls");
  const probe = join(dir, "liveness.sh");
  // Terminal on the first call (classification), running on the second (the
  // call the removal itself makes). A sweep that trusted its plan-phase
  // verdict would delete a worktree whose lane had come back to life; lanes
  // start and finish while a sweep runs, which is the entire reason the
  // probe is re-run rather than cached.
  writeFileSync(
    probe,
    [
      "#!/usr/bin/env bash",
      'calls=$(cat "$PROBE_COUNTER" 2>/dev/null || echo 0)',
      "calls=$((calls + 1))",
      'printf %s "$calls" > "$PROBE_COUNTER"',
      'if [[ "$calls" -ge 2 ]]; then exit 0; fi',
      "exit 1",
    ].join("\n"),
  );
  chmodSync(probe, 0o755);

  const apply = spawnSync(
    "bash",
    [reap, "branches", "--repo", repo, "--with-worktrees", "--apply", "--liveness-cmd", probe],
    { encoding: "utf8", env: { ...process.env, PROBE_COUNTER: counter } },
  );
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("terminal worktree holds branch: worktree-held");
  expect(apply.stdout).toContain("worktree stopped being terminal between classification and removal, refusing");
  expect(apply.stdout).toContain("leaving branch in place because its worktree survived: worktree-held");
  expect(readFileSync(counter, "utf8")).toBe("2");
  expect(existsSync(worktree)).toBe(true);
  expect(sh("git show-ref --verify --quiet refs/heads/worktree-held && echo present", repo).trim()).toBe(
    "present",
  );
});

test("a liveness probe that cannot answer is UNKNOWN, and UNKNOWN refuses", () => {
  const { dir, repo, worktree } = buildFixture();
  const broken = join(dir, "broken-probe.sh");
  writeFileSync(broken, "#!/usr/bin/env bash\nexit 3\n");
  chmodSync(broken, 0o755);

  const odd = run(["worktrees", "--repo", repo, "--apply", "--terminal", "--liveness-cmd", broken]);
  expect(odd.status).toBe(0);
  expect(odd.stdout).toContain("liveness-cmd exit=3 (UNKNOWN, refusing)");
  expect(existsSync(worktree)).toBe(true);

  // A probe that is not there at all is the same answer, not a free pass.
  const missing = run([
    "worktrees",
    "--repo",
    repo,
    "--apply",
    "--terminal",
    "--liveness-cmd",
    join(dir, "no-such-probe"),
  ]);
  expect(missing.status).toBe(0);
  expect(missing.stdout).toContain("(UNKNOWN, refusing)");
  expect(existsSync(worktree)).toBe(true);
});

test("an unreadable proc root is UNKNOWN, never an empty list of processes", () => {
  const { dir, repo, worktree } = buildFixture();

  const apply = run([
    "branches",
    "--repo",
    repo,
    "--with-worktrees",
    "--apply",
    "--proc-root",
    join(dir, "no-such-proc"),
  ]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("proc-root-unreadable");
  expect(apply.stdout).toContain("held by live worktree, refusing: worktree-held");
  expect(existsSync(worktree)).toBe(true);
  expect(sh("git show-ref --verify --quiet refs/heads/worktree-held && echo present", repo).trim()).toBe(
    "present",
  );
});

// --- round-5 review defect: the escalation was strictly more permissive than
// the `-D` the script bans ---------------------------------------------------
//
// `git branch -d` refuses for two unrelated reasons and delete_local_branch
// treated them as one, escalating past BOTH to `git update-ref -d`:
//
//   "the branch 'X' is not fully merged."          -- -d judged against the
//                                                     wrong HEAD, the case the
//                                                     escalation was written for
//   "cannot delete branch 'X' used by worktree at" -- a worktree has it out
//
// Measured on this host, git 2.43.0: `git branch -D` REFUSES a checked-out
// branch and `git update-ref -d` deletes it anyway, so the escalation was more
// dangerous than the instrument the file's header calls "the one command this
// tool must never learn" -- while passing the string check that enforced that
// prohibition. The reviewer reproduced a running lane's branch being deleted
// under the exact argv hygiene/install-cron.sh installs.
//
// Second half, same finding: the sweep's worktree census is taken once, before
// the loop, so a lane dispatched while the sweep runs is invisible to every
// guard above the delete. `git worktree add -b` puts a new lane's branch at
// main's tip, where land_assert_reap_safe correctly reports it carried -- so a
// brand-new lane is deletable and absent from the census at the same time,
// which is the ordinary state of every lane between dispatch and first commit.
//
// The two tests below stage that window deterministically rather than racing
// it. Both were run against the pre-fix script first: both delete the branch.

// A --liveness-cmd that DISPATCHES a lane -- a real `git worktree add` plus a
// real process working inside it -- and then reports the worktree it was asked
// about as live. Classification of one branch is thus the clock for "a lane
// started while the sweep was running": no sleeps, no polling, and the branch
// it creates is invisible to a census taken before the loop.
function laneDispatchingProbe(
  dir: string,
  name: string,
  repo: string,
  branch: string,
  at: string,
  pidFile: string,
): string {
  const probe = join(dir, name);
  writeFileSync(
    probe,
    [
      "#!/usr/bin/env bash",
      `at=${JSON.stringify(at)}`,
      `pidfile=${JSON.stringify(pidFile)}`,
      'if [[ ! -d "$at" ]]; then',
      `  git -C ${JSON.stringify(repo)} worktree add -q "$at" ${JSON.stringify(branch)} >/dev/null 2>&1`,
      '  ( cd "$at" && exec sleep 300 ) >/dev/null 2>&1 &',
      '  printf %s "$!" > "$pidfile"',
      '  target="$(cd "$at" && pwd -P)"',
      "  for _ in $(seq 1 500); do",
      '    if [[ "$(readlink "/proc/$(cat "$pidfile")/cwd" 2>/dev/null)" == "$target" ]]; then break; fi',
      "    sleep 0.01",
      "  done",
      "fi",
      "exit 0", // the worktree this probe was ASKED about is live
      "",
    ].join("\n"),
  );
  chmodSync(probe, 0o755);
  return probe;
}

// Reads the pid the probe recorded and hands it to the suite's killer, so a
// failing assertion cannot leave a 300-second sleep behind.
function adoptProbeLane(pidFile: string): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (Number.isInteger(pid) && pid > 0) livePids.push(pid);
}

// main, one merged branch at its tip (`zzz-victim`, the shape of a lane before
// its first commit), one unmerged branch, and `aaa-trigger` -- named to sort
// FIRST, because `for-each-ref refs/heads` walks refname order, so classifying
// it happens while the victim is still ahead of the loop.
function buildMidSweepFixture(): { dir: string; repo: string; trigger: string } {
  const dir = fixtureDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh("git init -q -b main .", repo);
  sh("git config user.email hygiene@example.test", repo);
  sh("git config user.name Hygiene", repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh("git add base.txt && git commit -qm base", repo);
  sh("git branch aaa-trigger", repo);
  sh("git branch zzz-victim", repo);
  const trigger = join(dir, "aaa-trigger-wt");
  sh(`git worktree add -q ${JSON.stringify(trigger)} aaa-trigger`, repo);
  return { dir, repo, trigger };
}

test("branches: a lane dispatched while the sweep is running keeps its branch, census or no census", () => {
  const { dir, repo } = buildMidSweepFixture();
  const victimWorktree = join(dir, "zzz-victim-wt");
  const pidFile = join(dir, "probe.pid");
  const probe = laneDispatchingProbe(dir, "dispatch.sh", repo, "zzz-victim", victimWorktree, pidFile);

  // --with-worktrees is here only because --liveness-cmd is the one hook the
  // `branches` sweep runs mid-loop; it opens the window deterministically. The
  // code under test -- delete_local_branch -- is reached identically by the
  // installed cron argv, which is how the reviewer reproduced this by timing.
  const apply = run(["branches", "--repo", repo, "--with-worktrees", "--apply", "--liveness-cmd", probe]);
  adoptProbeLane(pidFile);

  expect(apply.status).toBe(0);
  // The sweep genuinely got as far as deciding to delete it -- this is not a
  // test that passes because nothing happened.
  expect(apply.stdout).toContain("merged branch: zzz-victim");
  expect(apply.stdout).toContain("deleting merged branch: zzz-victim");
  expect(apply.stdout).toContain("a worktree holds this branch as of right now, refusing: zzz-victim");
  expect(sh("git show-ref --verify --quiet refs/heads/zzz-victim && echo present", repo).trim()).toBe("present");
  // And the lane it belongs to still has a branch under it.
  expect(sh("git rev-parse --abbrev-ref HEAD", victimWorktree).trim()).toBe("zzz-victim");
});

// The other window, and the one no flag can open: between the `-d` refusal and
// the escalation past it, delete_local_branch fetches. `ext::` makes that fetch
// run a script, so the branch can acquire a worktree in exactly that gap --
// under the installed cron argv, with no --with-worktrees and no
// --liveness-cmd. This is the window the SECOND re-measure exists for, and
// round-3 review found that guard was the one new guard of round 2 that no test
// held: removing it left the whole file passing, because the message classifier
// in front of it happened to catch this fixture first. It no longer does --
// the classifier is a measurement now, and the measurement says this branch is
// genuinely unmerged, i.e. escalate. So the re-measure is all that stands here,
// which is exactly what makes this its lock.
function remoteWhoseFetchDispatchesALane(
  dir: string,
  repo: string,
  branch: string,
  at: string,
): void {
  const bare = join(dir, "remote.git");
  sh(`git init -q --bare ${JSON.stringify(bare)}`, dir);
  const helper = join(dir, "fetch-helper.sh");
  writeFileSync(
    helper,
    [
      "#!/usr/bin/env bash",
      `at=${JSON.stringify(at)}`,
      'if [[ ! -d "$at" ]]; then',
      `  git -C ${JSON.stringify(repo)} worktree add -q "$at" ${JSON.stringify(branch)} >/dev/null 2>&1`,
      "fi",
      'exec git upload-pack "$1"',
      "",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);
  sh(`git remote add origin ${JSON.stringify(`ext::bash ${helper} ${bare}`)}`, repo);
  // ext:: transports are refused by default; this enables it for this fixture
  // repository only, and it is the transport that makes the window observable.
  sh("git config protocol.ext.allow always", repo);
}

test("branches: a worktree that appears during the fetch keeps its branch -- the re-measure between the refusal and the delete", () => {
  const { dir, repo } = buildFixture();
  const victimWorktree = join(dir, "unmerged-wt");
  remoteWhoseFetchDispatchesALane(dir, repo, "unmerged", victimWorktree);
  const dispositions = join(dir, "dispositions.txt");
  writeFileSync(dispositions, "unmerged operator ruling: abandoned experiment, safe to drop\n");

  // The installed cron argv, plus the disposition file that is ordinary
  // instance configuration. No flag opens this window.
  const apply = run(["branches", "--repo", repo, "--dispositions", dispositions, "--apply"]);

  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("deleting dispositioned branch: unmerged");
  expect(apply.stdout).toContain("git refused -d for unmerged, re-measuring rather than forcing");
  expect(apply.stdout).toContain("a worktree took this branch while it was being reaped, refusing: unmerged");
  expect(apply.stdout).toContain(victimWorktree);
  // It must NOT have reached the escalation at all.
  expect(apply.stdout).not.toContain("git -d judges against HEAD; deleting the exact measured ref instead");
  expect(sh("git show-ref --verify --quiet refs/heads/unmerged && echo present", repo).trim()).toBe("present");
  expect(sh("git rev-parse --abbrev-ref HEAD", victimWorktree).trim()).toBe("unmerged");
});

// Round 2 decided which of `git branch -d`'s two refusals it was looking at by
// testing the message for `is not fully merged`. Round-3 review pointed out
// that git puts a PATH in that message -- the worktree path in the in-use
// refusal, the repository path in a lock failure -- so an operator who happens
// to have that string anywhere in a path spells whichever classification they
// like. Here the repository itself lives under `is not fully merged`, the
// branch IS merged, and `-d` fails for a third reason entirely (a stale ref
// lock, what a crashed or concurrent git leaves behind). Against the round-2
// script the substring matches, the tool announces the merged-vs-HEAD
// diagnosis it never performed, and escalates to the exact-ref delete. It is
// now decided by asking git the same question `-d` asks.
function repoUnderAMisleadingPath(): string {
  const dir = fixtureDir();
  const repo = join(dir, "is not fully merged", "repo");
  mkdirSync(repo, { recursive: true });
  sh("git init -q -b main .", repo);
  sh("git config user.email hygiene@example.test", repo);
  sh("git config user.name Hygiene", repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh("git add base.txt && git commit -qm base", repo);
  sh("git branch merged", repo);
  writeFileSync(join(repo, ".git", "refs", "heads", "merged.lock"), "");
  return repo;
}

test("branches: the escalation is decided by measurement, not by a refusal whose text a path can spell", () => {
  const repo = repoUnderAMisleadingPath();

  const apply = run(["branches", "--repo", repo, "--apply"]);

  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("merged branch: merged");
  expect(apply.stdout).toContain("git refused -d for merged, re-measuring rather than forcing");
  // The refusal text contains "is not fully merged" -- inside the path -- and
  // the tool must still read it as a refusal it cannot attribute to the merge
  // check. git's own words stay in the log; they just no longer decide.
  expect(apply.stdout).toContain("git refused -d for a reason this tool does not escalate past, retaining: merged");
  expect(apply.stdout).toContain("cannot lock ref");
  expect(apply.stdout).not.toContain("git -d judges against HEAD; deleting the exact measured ref instead");
  expect(sh("git show-ref --verify --quiet refs/heads/merged && echo present", repo).trim()).toBe("present");
});

// --- the escalation primitive's other two outcomes -------------------------
//
// `grep -n update-ref hygiene/reap.test.ts` returned nothing before this round:
// the one primitive in this tool that can delete a ref git itself declined to
// delete had no test at any of its outcomes. The refusal is locked above; the
// success and the git-said-no cases are locked here, so a future change cannot
// quietly disarm the escalation either.

test("branches: the escalation still deletes the branch it was actually written for", () => {
  const { dir, repo } = buildFixture();
  const dispositions = join(dir, "dispositions.txt");
  writeFileSync(dispositions, "unmerged operator ruling: abandoned experiment, safe to drop\n");

  const apply = run(["branches", "--repo", repo, "--dispositions", dispositions, "--apply"]);
  expect(apply.status).toBe(0);
  // `-d` judges against the repository's HEAD (main), which has never seen
  // this branch; the operator's disposition is a judgement `-d` cannot see at
  // all. That -- and only that -- is what the exact-ref delete exists for.
  expect(apply.stdout).toContain(
    "git -d judges against HEAD; deleting the exact measured ref instead (operator disposition): unmerged",
  );
  expect(apply.stdout).toContain("deleted dispositioned branch: unmerged");
  const check = spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/unmerged"], { cwd: repo });
  expect(check.status).not.toBe(0);
});

test("branches: an exact-ref delete that git itself refuses is retained, not retried harder", () => {
  const { dir, repo } = buildFixture();
  const dispositions = join(dir, "dispositions.txt");
  writeFileSync(dispositions, "unmerged operator ruling: abandoned experiment, safe to drop\n");
  // A stale ref lock -- what a crashed or concurrent git process leaves
  // behind. `rev-parse` and `branch -d`'s merge check are unaffected, so the
  // sweep reaches the escalation and the escalation is the thing that fails.
  writeFileSync(join(repo, ".git", "refs", "heads", "unmerged.lock"), "");

  const apply = run(["branches", "--repo", repo, "--dispositions", dispositions, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("git -d judges against HEAD; deleting the exact measured ref instead");
  expect(apply.stdout).toContain("exact-ref delete refused, retaining: unmerged");
  expect(apply.stdout).not.toContain("deleted dispositioned branch: unmerged");
  expect(sh("git show-ref --verify --quiet refs/heads/unmerged && echo present", repo).trim()).toBe("present");
});

test("remote-branches: a lane dispatched while the sweep is running keeps its remote branch", () => {
  const { dir, repo } = buildRemoteFixture();
  // Sorts before ag-merged-remote in `ls-remote --heads` output, so its
  // classification runs while the victim is still ahead of the loop.
  sh("git branch aaa-trigger main && git push -q origin aaa-trigger", repo);
  const trigger = join(dir, "aaa-trigger-wt");
  sh(`git worktree add -q ${JSON.stringify(trigger)} aaa-trigger`, repo);
  const victimWorktree = join(dir, "ag-merged-remote-wt");
  const pidFile = join(dir, "probe.pid");
  const probe = laneDispatchingProbe(dir, "dispatch.sh", repo, "ag-merged-remote", victimWorktree, pidFile);

  const apply = run(["remote-branches", "--repo", repo, "--apply", "--liveness-cmd", probe]);
  adoptProbeLane(pidFile);

  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("deleting merged remote branch: origin/ag-merged-remote");
  expect(apply.stdout).toContain(
    "a lane holds this branch as of right now, refusing the remote delete: origin/ag-merged-remote",
  );
  // The refusal is grounded in a real process inside the new worktree, not in
  // the probe's own answer: a remote ref has no reflog on the other side.
  expect(apply.stdout).toContain("process-working-inside");
  expect(sh("git ls-remote --heads origin", repo)).toContain("refs/heads/ag-merged-remote");
  expect(sh("git rev-parse --abbrev-ref HEAD", victimWorktree).trim()).toBe("ag-merged-remote");
});

// --- a lane whose HEAD is detached -----------------------------------------
//
// Round-3 review's blocking finding. Every liveness guard in this tool was
// reached only through the `branch refs/heads/<name>` line of
// `git worktree list --porcelain`, and git prints `detached` instead of it for
// the whole duration of a rebase or a bisect -- the ordinary state of a lane on
// this installation, where HR-2538 records V3-5.1 alone needing three rebases.
// The census then found no holder, worktree_is_terminal was never called, its
// `operation-in-progress` check never ran, and `remote-branches --apply`
// deleted the running lane's remote branch: the ref with no reflog on the far
// side. Measured against the round-2 script, both fixtures below:
//
//   deleted dispositioned remote branch: origin/ag-lane (c2124b3b...)
//   remote now:  refs/heads/main        <- the lane's branch is gone
//
// Both states are produced by running git, not by writing marker files: a
// fixture that fabricates `rebase-merge` proves something about the fixture.

// A lane stopped in the middle of a real rebase: `--exec false` fails after the
// commit is replayed, so the worktree is left detached, CLEAN, and holding
// `rebase-merge` -- clean on purpose, so the refusal has to come from the
// operation marker and cannot be the dirty-tree check answering by accident.
function buildRebasingLaneFixture(): { dir: string; repo: string; lane: string; dispositions: string } {
  const dir = fixtureDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh("git init -q -b main .", repo);
  sh("git config user.email hygiene@example.test", repo);
  sh("git config user.name Hygiene", repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh("git add base.txt && git commit -qm base", repo);
  const remote = join(dir, "remote.git");
  sh(`git init -q --bare ${JSON.stringify(remote)}`, repo);
  sh(`git remote add origin ${JSON.stringify(remote)}`, repo);
  sh("git push -q origin main", repo);

  sh("git checkout -qb ag-lane", repo);
  writeFileSync(join(repo, "lane.txt"), "lane work nobody else has\n");
  sh("git add lane.txt && git commit -qm lane && git push -q origin ag-lane", repo);
  sh("git checkout -q main", repo);
  writeFileSync(join(repo, "trunk.txt"), "trunk\n");
  sh("git add trunk.txt && git commit -qm trunk && git push -q origin main", repo);

  const lane = join(dir, "lane-wt");
  sh(`git worktree add -q ${JSON.stringify(lane)} ag-lane`, repo);
  spawnSync("git", ["rebase", "--exec", "false", "main"], { cwd: lane, encoding: "utf8" });
  const listed = sh("git worktree list --porcelain", repo);
  if (!listed.includes("detached")) {
    throw new Error(`fixture setup failed: the lane is not detached\n${listed}`);
  }
  if (sh("git status --porcelain", lane) !== "") {
    throw new Error("fixture setup failed: the rebasing lane is dirty, so the refusal would not prove the marker");
  }
  const dispositions = join(dir, "dispositions.txt");
  writeFileSync(dispositions, "ag-lane operator ruling: superseded, safe to drop\n");
  return { dir, repo, lane, dispositions };
}

test("remote-branches: a lane detached in the middle of a rebase keeps its remote branch", () => {
  const { repo, lane, dispositions } = buildRebasingLaneFixture();

  const apply = run(["remote-branches", "--repo", repo, "--dispositions", dispositions, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("remote branch held by a live lane, refusing: origin/ag-lane");
  // The refusal must be the operation marker: that check exists for exactly
  // this state and was never reached before.
  expect(apply.stdout).toContain("operation-in-progress=rebase-merge");
  expect(apply.stdout).toContain(lane);
  expect(apply.stdout).not.toContain("deleting dispositioned remote branch");
  expect(sh("git ls-remote --heads origin", repo)).toContain("refs/heads/ag-lane");
});

test("branches: a lane detached in the middle of a rebase keeps its local branch, with or without --with-worktrees", () => {
  const { repo, dispositions } = buildRebasingLaneFixture();

  for (const argv of [
    ["branches", "--repo", repo, "--dispositions", dispositions, "--apply"],
    ["branches", "--repo", repo, "--dispositions", dispositions, "--with-worktrees", "--apply"],
  ]) {
    const apply = run(argv);
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain("held by live worktree, refusing: ag-lane");
    expect(sh("git show-ref --verify --quiet refs/heads/ag-lane && echo present", repo).trim()).toBe("present");
  }
});

test("worktrees: a detached lane is classified under the branch it is rebasing, not as `detached`", () => {
  const { repo, lane } = buildRebasingLaneFixture();

  const out = run(["worktrees", "--repo", repo, "--apply", "--terminal"]);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain(`live worktree, refusing: ${lane} (branch: ag-lane, operation-in-progress=rebase-merge)`);
  expect(existsSync(lane)).toBe(true);
});

// The other detached state: `git bisect` checks out a midpoint and records the
// branch it will return to in BISECT_START. Here the lane's branch is a plain
// ancestor of main, so the reaper genuinely wants it and no disposition file is
// involved -- the refusal has to come from finding the holder.
function buildBisectingLaneFixture(): { dir: string; repo: string; lane: string } {
  const dir = fixtureDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh("git init -q -b main .", repo);
  sh("git config user.email hygiene@example.test", repo);
  sh("git config user.name Hygiene", repo);
  for (const n of [1, 2, 3, 4, 5]) {
    writeFileSync(join(repo, `c${n}.txt`), `${n}\n`);
    sh(`git add c${n}.txt && git commit -qm c${n}`, repo);
  }
  const remote = join(dir, "remote.git");
  sh(`git init -q --bare ${JSON.stringify(remote)}`, repo);
  sh(`git remote add origin ${JSON.stringify(remote)}`, repo);
  sh("git push -q origin main", repo);
  sh("git branch ag-lane HEAD~4 && git push -q origin ag-lane", repo);

  const lane = join(dir, "lane-wt");
  sh(`git worktree add -q ${JSON.stringify(lane)} ag-lane`, repo);
  sh("git bisect start main ag-lane", lane);
  const listed = sh("git worktree list --porcelain", repo);
  if (!listed.includes("detached")) {
    throw new Error(`fixture setup failed: the bisecting lane is not detached\n${listed}`);
  }
  return { dir, repo, lane };
}

test("a lane detached in the middle of a bisect keeps the branch bisect will return it to", () => {
  const { repo, lane } = buildBisectingLaneFixture();

  const remoteSweep = run(["remote-branches", "--repo", repo, "--apply"]);
  expect(remoteSweep.status).toBe(0);
  expect(remoteSweep.stdout).toContain("remote branch held by a live lane, refusing: origin/ag-lane");
  expect(remoteSweep.stdout).toContain("operation-in-progress=BISECT_LOG");
  expect(remoteSweep.stdout).toContain(lane);
  expect(sh("git ls-remote --heads origin", repo)).toContain("refs/heads/ag-lane");

  const localSweep = run(["branches", "--repo", repo, "--with-worktrees", "--apply"]);
  expect(localSweep.status).toBe(0);
  expect(localSweep.stdout).toContain("held by live worktree, refusing: ag-lane");
  expect(sh("git show-ref --verify --quiet refs/heads/ag-lane && echo present", repo).trim()).toBe("present");
});

test("a worktree whose porcelain record does not parse is UNKNOWN, and UNKNOWN refuses every branch", () => {
  const dir = fixtureDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh("git init -q -b main .", repo);
  sh("git config user.email hygiene@example.test", repo);
  sh("git config user.name Hygiene", repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh("git add base.txt && git commit -qm base", repo);
  sh("git branch merged", repo);
  sh("git branch victim", repo);
  // A newline in a worktree path splits one porcelain record into two, so the
  // `branch` line that follows belongs to a path no line-based parser can name.
  // The round-2 parser answered anyway, with the truncated path. There is one
  // true answer here and it is "I do not know".
  const weird = join(dir, "we\nird-wt");
  // Not through a shell: the newline has to reach `git worktree add` as a
  // newline, and every quoting form a shell offers turns it into something else.
  const added = spawnSync("git", ["worktree", "add", "-q", weird, "victim"], { cwd: repo, encoding: "utf8" });
  if (added.status !== 0 || !sh("git worktree list --porcelain", repo).includes("\nird-wt")) {
    throw new Error(`fixture setup failed: no worktree at a path containing a newline\n${added.stderr}`);
  }

  const apply = run(["branches", "--repo", repo, "--apply"]);
  expect(apply.status).toBe(0);
  expect(apply.stdout).toContain("a worktree's branch could not be determined, refusing: victim");
  // And it refuses the OTHER branch too: an unreadable worktree inventory is a
  // statement about the whole repository, not about one branch in it.
  expect(apply.stdout).toContain("a worktree's branch could not be determined, refusing: merged");
  expect(sh("git show-ref --verify --quiet refs/heads/victim && echo present", repo).trim()).toBe("present");
  expect(sh("git show-ref --verify --quiet refs/heads/merged && echo present", repo).trim()).toBe("present");
});

// --- the prohibition, asserted as a property -------------------------------
//
// Round 1 enforced "no `git branch -D`" by looking for the string. Round 2
// replaced that with a three-alternative regex, which round-3 review defeated
// three ways, each leaving the entire file passing: `git branch --delete
// --force` (the banned command, spelled long), `printf 'delete refs/heads/%s\n'
// | git update-ref --stdin`, and `git push <remote> ":<ref>"` -- a delete
// refspec with no `--delete` in it, which reap_meteorite_refs already uses, so
// the file demonstrated the hole itself.
//
// The question was never "which spellings appear in the source". It is "can any
// code path remove a ref that a live or checked-out worktree depends on", and
// that is answered by taking the full ref inventory, running every entry point
// the tool exposes with --apply against a fleet of live lanes, and taking it
// again. Nothing in that measurement knows what a git verb is.

type RefInventory = { local: string[]; remote: string[] };

function refInventory(repo: string): RefInventory {
  const parse = (out: string) =>
    out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/).pop() as string)
      .map((ref) => ref.replace(/^refs\/heads\//, ""))
      .sort();
  return {
    local: parse(sh("git for-each-ref --format='%(refname)' refs/heads", repo)),
    remote: parse(sh("git ls-remote --heads origin", repo)),
  };
}

// A repository holding three lanes that must not be touched -- one working
// (a real process inside it), one mid-rebase, one mid-bisect -- and one branch
// that genuinely is finished, so a sweep that refuses everything cannot pass
// this by doing nothing.
function buildLiveFleetFixture(): { dir: string; repo: string; dispositions: string } {
  const dir = fixtureDir();
  const repo = join(dir, "repo");
  mkdirSync(repo);
  sh("git init -q -b main .", repo);
  sh("git config user.email hygiene@example.test", repo);
  sh("git config user.name Hygiene", repo);
  writeFileSync(join(repo, "base.txt"), "base\n");
  sh("git add base.txt && git commit -qm base", repo);
  const remote = join(dir, "remote.git");
  sh(`git init -q --bare ${JSON.stringify(remote)}`, repo);
  sh(`git remote add origin ${JSON.stringify(remote)}`, repo);
  sh("git push -q origin main", repo);

  // ag-done: landed and finished. The control.
  sh("git checkout -qb ag-done", repo);
  writeFileSync(join(repo, "done.txt"), "done\n");
  sh("git add done.txt && git commit -qm done && git push -q origin ag-done", repo);
  sh("git checkout -q main && git merge -q --no-ff -m 'merge ag-done' ag-done", repo);

  // ag-working: merged, so the reaper wants it, but a lane is inside it.
  sh("git checkout -qb ag-working main", repo);
  writeFileSync(join(repo, "working.txt"), "working\n");
  sh("git add working.txt && git commit -qm working && git push -q origin ag-working", repo);
  sh("git checkout -q main && git merge -q --no-ff -m 'merge ag-working' ag-working", repo);

  // ag-bisecting: a plain ancestor of main. The filler commits give the bisect
  // a range wide enough that it checks a midpoint out (and so detaches) rather
  // than concluding on the spot.
  sh("git branch ag-bisecting main && git push -q origin ag-bisecting", repo);
  for (const n of [1, 2, 3, 4]) {
    writeFileSync(join(repo, `filler${n}.txt`), `${n}\n`);
    sh(`git add filler${n}.txt && git commit -qm filler${n}`, repo);
  }

  // ag-unmerged: unique content and NO disposition. Nothing authorizes deleting
  // it, ever. This is the ref `git branch -D` is banned over -- git itself
  // refuses -D for a branch a worktree holds, so the banned instrument's real
  // hazard is unheld work like this, not a checked-out lane.
  sh("git checkout -qb ag-unmerged main", repo);
  writeFileSync(join(repo, "unmerged.txt"), "work nobody else has\n");
  sh("git add unmerged.txt && git commit -qm unmerged && git push -q origin ag-unmerged", repo);
  sh("git checkout -q main", repo);

  // ag-rebasing: unique content, dispositioned, so the reaper wants it too.
  sh("git checkout -qb ag-rebasing main", repo);
  writeFileSync(join(repo, "rebasing.txt"), "rebasing\n");
  sh("git add rebasing.txt && git commit -qm rebasing && git push -q origin ag-rebasing", repo);
  sh("git checkout -q main", repo);
  writeFileSync(join(repo, "trunk.txt"), "trunk\n");
  sh("git add trunk.txt && git commit -qm trunk", repo);
  sh("git push -q origin main", repo);

  const working = join(dir, "ag-working-wt");
  sh(`git worktree add -q ${JSON.stringify(working)} ag-working`, repo);
  spawnLaneIn(working);

  const rebasing = join(dir, "ag-rebasing-wt");
  sh(`git worktree add -q ${JSON.stringify(rebasing)} ag-rebasing`, repo);
  spawnSync("git", ["rebase", "--exec", "false", "main"], { cwd: rebasing, encoding: "utf8" });

  const bisecting = join(dir, "ag-bisecting-wt");
  sh(`git worktree add -q ${JSON.stringify(bisecting)} ag-bisecting`, repo);
  sh("git bisect start main ag-bisecting", bisecting);

  const detached = (sh("git worktree list --porcelain", repo).match(/^detached$/gm) ?? []).length;
  if (detached !== 2) {
    throw new Error(`fixture setup failed: expected two detached lanes, saw ${detached}`);
  }
  const dispositions = join(dir, "dispositions.txt");
  writeFileSync(
    dispositions,
    ["ag-rebasing operator ruling: superseded", "ag-bisecting operator ruling: superseded", ""].join("\n"),
  );
  return { dir, repo, dispositions };
}

// Every entry point this tool exposes, each with the flag that lets it mutate.
function sweepEverything(script: string, repo: string, dispositions: string): string {
  const argvs = [
    ["branches", "--repo", repo, "--dispositions", dispositions, "--apply"],
    ["branches", "--repo", repo, "--dispositions", dispositions, "--with-worktrees", "--apply"],
    ["remote-branches", "--repo", repo, "--dispositions", dispositions, "--apply"],
    ["worktrees", "--repo", repo, "--apply", "--terminal"],
    ["meteorite-refs", "--repo", repo, "--max-age-seconds", "0", "--apply"],
  ];
  let combined = "";
  for (const argv of argvs) {
    const result = spawnSync("bash", [script, ...argv], { encoding: "utf8" });
    combined += `\n$ reap.sh ${argv.join(" ")}\n${result.stdout}${result.stderr}`;
  }
  return combined;
}

// Every ref in this fixture that nothing authorizes deleting: three lanes that
// are alive, and one branch of unmerged work with no disposition behind it.
const mustSurvive = ["ag-working", "ag-rebasing", "ag-bisecting", "ag-unmerged"];

// The measurement itself: which of those stopped existing.
function refsDestroyedBy(script: string): { destroyed: string[]; log: string; after: RefInventory } {
  const { repo, dispositions } = buildLiveFleetFixture();
  const before = refInventory(repo);
  for (const ref of mustSurvive) {
    if (!before.local.includes(ref) || !before.remote.includes(ref)) {
      throw new Error(`fixture setup failed: ${ref} is not present on both sides`);
    }
  }
  const log = sweepEverything(script, repo, dispositions);
  const after = refInventory(repo);
  const destroyed: string[] = [];
  for (const ref of mustSurvive) {
    if (!after.local.includes(ref)) destroyed.push(`local:${ref}`);
    if (!after.remote.includes(ref)) destroyed.push(`remote:${ref}`);
  }
  return { destroyed, log, after };
}

test("PROPERTY: no entry point removes a ref nothing authorized it to remove, whatever primitive it is spelled with", () => {
  const { destroyed, after } = refsDestroyedBy(reap);
  expect(destroyed).toEqual([]);
  // ...and it is not passing by refusing everything: the one branch that IS
  // finished was reaped on both sides in the same run.
  expect(after.local).not.toContain("ag-done");
  expect(after.remote).not.toContain("ag-done");
});

// A copy of this repository with one line changed, so the property above is
// exercised against a reaper that really does destroy work. Without this the
// property test proves only that the current script passes it.
function reapWithInjection(anchor: string, injected: string): string {
  const root = fixtureDir();
  // Copied from the tree under test, not from `git archive HEAD`: the script
  // this suite is executing is the one an injection has to be measured against,
  // and an uncommitted change to it must not be silently swapped for its last
  // committed version. reap.sh resolves gate/land-lib.sh and the instance lists
  // relative to its own root, so those come with it.
  mkdirSync(join(root, "hygiene"));
  for (const dir of ["gate", "instance"]) {
    sh(`cp -a ${JSON.stringify(join(repoRoot, dir))} ${JSON.stringify(join(root, dir))}`, root);
  }
  sh(`cp -a ${JSON.stringify(reap)} ${JSON.stringify(join(root, "hygiene", "reap.sh"))}`, root);
  const target = join(root, "hygiene", "reap.sh");
  const source = readFileSync(target, "utf8");
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(`injection anchor is not unique (${occurrences} matches): ${anchor}`);
  }
  writeFileSync(target, source.replace(anchor, `${anchor}\n${injected}`));
  return target;
}

const injections: Array<{ name: string; anchor: string; injected: string }> = [
  {
    // `git branch -D`, spelled long: the round-2 regexes require `\s-[dD]\b`.
    // Placed on the report-only path, because that is where it can actually do
    // harm -- git refuses --delete --force for a branch it can associate with a
    // worktree (measured: it refuses even for a lane detached mid-rebase), so
    // the work this instrument destroys is unmerged work nobody is holding.
    name: "git branch --delete --force",
    anchor: '      say "unmerged branch (report-only, no disposition): $branch (${age}d old)"',
    injected: '      git -C "$repo" branch --delete --force "$branch" >/dev/null 2>&1 || true',
  },
  {
    // A third ref-deleting primitive, on the path that has just REFUSED a live
    // lane, in neither guarded function.
    name: "git update-ref --stdin",
    anchor:
      '        say "remote branch held by a live lane, refusing: $remote/$branch (worktree: $worktree, $reason)"',
    injected:
      '        printf \'delete refs/heads/%s\\n\' "$branch" | git -C "$repo" update-ref --stdin >/dev/null 2>&1 || true',
  },
  {
    // A delete refspec with no --delete in it -- the form reap_meteorite_refs
    // already uses, which is why no blocklist over verbs can see it.
    name: "git push <remote> :<ref>",
    anchor:
      '        say "remote branch held by a live lane, refusing: $remote/$branch (worktree: $worktree, $reason)"',
    injected: '        git -C "$repo" push "$remote" ":refs/heads/$branch" >/dev/null 2>&1 || true',
  },
];

test("the property has teeth: each injected deletion primitive is caught by it", () => {
  for (const injection of injections) {
    const script = reapWithInjection(injection.anchor, injection.injected);
    const { destroyed } = refsDestroyedBy(script);
    if (destroyed.length === 0) {
      throw new Error(`the property test did not catch the injection: ${injection.name}`);
    }
  }
});

// Splits reap.sh into `name() { ... }` bodies so a claim about WHERE a
// primitive may appear can be made about the script rather than about a
// string in it.
function shellFunctionBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  let name = "";
  let body: string[] = [];
  for (const line of source.split("\n")) {
    const opens = line.match(/^([a-z_][a-z0-9_]*)\(\)\s*\{\s*$/);
    if (!name && opens) {
      name = opens[1];
      body = [];
      continue;
    }
    if (name && line === "}") {
      bodies.set(name, body.join("\n"));
      name = "";
      continue;
    }
    if (name) body.push(line);
  }
  return bodies;
}

test("no code path deletes a branch that is checked out or held by a live lane, whatever primitive it uses", () => {
  // This test used to assert the ABSENCE OF A STRING -- that `git branch -D`
  // appears nowhere. That check passed at every commit of the round-4 branch
  // while `git update-ref -d` sat two lines below it deleting checked-out
  // branches that `-D` itself would have refused. A prohibition defended by
  // spelling is not a prohibition, so the claim is now made three ways: the
  // behaviour, the location of every ref-deleting primitive, and only then the
  // banned instruments.

  // 1. BEHAVIOUR. A branch held by a live lane survives every route into a
  //    deletion the tool has: the default sweep, the sweep that is allowed to
  //    remove worktrees, and a lane that appears after the census (locked in
  //    its own tests above, on both the local and the remote path).
  const { repo, worktree } = buildFixture();
  spawnLaneIn(worktree);

  const cronArgv = run(["branches", "--repo", repo, "--apply"]);
  expect(cronArgv.status).toBe(0);
  expect(cronArgv.stdout).toContain("held by live worktree, refusing: worktree-held");
  expect(sh("git show-ref --verify --quiet refs/heads/worktree-held && echo present", repo).trim()).toBe("present");

  const armed = run(["branches", "--repo", repo, "--with-worktrees", "--apply"]);
  expect(armed.status).toBe(0);
  expect(armed.stdout).toContain("process-working-inside");
  expect(armed.stdout).toContain("held by live worktree, refusing: worktree-held");
  expect(sh("git show-ref --verify --quiet refs/heads/worktree-held && echo present", repo).trim()).toBe("present");
  expect(existsSync(worktree)).toBe(true);

  // 2. LOCATION. A cheap tripwire, and only that. It asserts that the ref-
  //    deleting spellings this file KNOWS ABOUT appear only inside the two
  //    functions that re-measure the holding worktree before acting. Round 2's
  //    comment here claimed more -- that a primitive spelled in a way no
  //    blocklist anticipated would fail here -- and round-3 review falsified it
  //    with three such spellings. The claim now rests on the PROPERTY test
  //    above, which measures the ref inventory before and after every entry
  //    point and therefore cannot be spelled around. This survives because a
  //    regex costs nothing and fails faster than a fixture.
  const source = readFileSync(reap, "utf8");
  const bodies = shellFunctionBodies(source);
  const guarded = ["delete_local_branch", "delete_remote_branch"];
  for (const fn of guarded) {
    expect(bodies.has(fn)).toBe(true);
    expect(bodies.get(fn)).toMatch(/worktree list --porcelain|holding_worktree_now/);
  }
  const deletesAHead = (line: string) =>
    /^\s*[^#]*\bgit\b[^\n]*\bbranch\b[^\n]*\s-[dD]\b/.test(line) ||
    /^\s*[^#]*\bgit\b[^\n]*\bupdate-ref\b[^\n]*\s-d\b/.test(line) ||
    /^\s*[^#]*\bgit\b[^\n]*\bpush\b[^\n]*--delete\b/.test(line);
  const outsideGuardedFunctions = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter(deletesAHead)
    .filter((line) => !guarded.some((fn) => bodies.get(fn)?.includes(line)));
  expect(outsideGuardedFunctions).toEqual([]);
  // The one other delete refspec in the file is the meteorite sweep's, and it
  // is confined to its own reserved namespace by an anchored regex rather than
  // by being a different verb.
  expect(bodies.get("reap_meteorite_refs")).toMatch(/\^refs\/meteorite-candidates\//);

  // 3. INSTRUMENTS. Kept, now that it is the third line of defence rather than
  //    the only one. `git branch -D` is how a reaper becomes a work-destroyer;
  //    `worktree remove --force` discards an uncommitted tree; a bare
  //    `push --force` is unconditional where --force-with-lease is a
  //    compare-and-swap.
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  expect(code).not.toMatch(/git\b[^\n]*\bbranch\b[^\n]*\s-D\b/);
  expect(code).not.toMatch(/worktree\s+remove\b[^\n]*--force\b/);
  expect(code).not.toMatch(/push\b[^\n]*\s--force(\s|$)/m);
  expect(code).toMatch(/--force-with-lease=/);
});
