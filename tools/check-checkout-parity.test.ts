import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DECLARED_CHECKS,
  EXIT_CODES,
  WORLD_NAMES,
  buildWorlds,
  checkParity,
  mirrorWorkingTree,
  runCheck,
  type ParityCheck,
} from "./check-checkout-parity";

const REAL_REPO = join(import.meta.dir, "..");
const CHECKER = join(REAL_REPO, "tools/check-checkout-parity.ts");

// A synthetic repository, because the point of every case below is to make ONE
// property differ between checkout kinds and see what the comparison says. The
// real tree cannot be bent that way without mutating it, and this checker's own
// promise is that it mutates nothing it reads.
function fixtureRepo(options: { tracked?: Record<string, string>; untracked?: Record<string, string>; ignored?: Record<string, string> } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "parity-fixture-"));
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  run("init", "--quiet", "-b", "main");
  run("config", "user.email", "fixture@example.invalid");
  run("config", "user.name", "Fixture");
  write(repo, ".gitignore", "ignored-here/\n");
  for (const [path, contents] of Object.entries(options.tracked ?? {})) write(repo, path, contents);
  run("add", "-A");
  run("commit", "--quiet", "-m", "fixture");
  for (const [path, contents] of Object.entries(options.untracked ?? {})) write(repo, path, contents);
  for (const [path, contents] of Object.entries(options.ignored ?? {})) write(repo, join("ignored-here", path), contents);
  return repo;
}

function write(repo: string, path: string, contents: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** A check written as a shell script INSIDE the world, so each world runs its own copy. */
function scriptCheck(id: string, relative: string): ParityCheck {
  return { id, argv: (world) => ["/bin/bash", join(world, relative), world] };
}

function withRepo<T>(options: Parameters<typeof fixtureRepo>[0], body: (repo: string) => T): T {
  const repo = fixtureRepo(options);
  try {
    return body(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// --- the green direction --------------------------------------------------

test("a check reading only tracked content agrees in all three worlds", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\ntest -f \"$1/tracked.txt\"\n", "tracked.txt": "present\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("tracked-only", "check.sh")] });
    expect(result.verdict).toBe("PASS");
    expect(result.evidence.join("\n")).toContain("check=tracked-only pass in primary, lane-worktree, land-main");
    expect(result.findings).toEqual([]);
  });
});

test("a check that fails everywhere is parity, not a defect — the verdict is what is compared", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 7\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("always-red", "check.sh")] });
    expect(result.verdict).toBe("PASS");
    expect(result.evidence.join("\n")).toContain("check=always-red fail in primary, lane-worktree, land-main");
  });
});

// --- the red direction: the consilium's own failure ------------------------

test("a check reading an UNTRACKED file diverges, and the finding names world and check", () => {
  // This is instance/decisions/inbox.jsonl in miniature: present in the primary
  // repository, structurally absent from a lane worktree and from land-main, so
  // the check that reads it passes in one world and fails in two.
  withRepo(
    { tracked: { "check.sh": "#!/bin/bash\ntest -f \"$1/inbox.jsonl\"\n" }, untracked: { "inbox.jsonl": "{}\n" } },
    (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("reads-untracked", "check.sh")] });
      expect(result.verdict).toBe("FAIL");
      const finding = result.findings.find((line) => line.includes("DIVERGED"));
      expect(finding).toBeDefined();
      expect(finding).toContain("check=reads-untracked");
      expect(finding).toContain("primary=pass");
      expect(finding).toContain("lane-worktree=fail");
      expect(finding).toContain("land-main=fail");
    },
  );
});

test("a check reading an IGNORED file diverges the same way", () => {
  withRepo(
    { tracked: { "check.sh": "#!/bin/bash\ntest -f \"$1/ignored-here/runtime.env\"\n" }, ignored: { "runtime.env": "TOKEN=\n" } },
    (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("reads-ignored", "check.sh")] });
      expect(result.verdict).toBe("FAIL");
      expect(result.findings.join("\n")).toContain("primary=pass");
    },
  );
});

test("a check reading repository-GLOBAL state separates a worktree from a clone", () => {
  // refs/stash is shared with the parent clone and private to an independent
  // one, which is the structural difference no file content can stand in for.
  withRepo(
    {
      tracked: {
        "check.sh": "#!/bin/bash\ntest \"$(git -C \"$1\" rev-parse --git-dir)\" = \"$(git -C \"$1\" rev-parse --git-common-dir)\"\n",
      },
    },
    (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("git-dir-shape", "check.sh")] });
      expect(result.verdict).toBe("FAIL");
      const finding = result.findings.find((line) => line.includes("DIVERGED"));
      expect(finding).toContain("lane-worktree=fail");
      expect(finding).toContain("primary=pass");
      expect(finding).toContain("land-main=pass");
    },
  );
});

// --- UNKNOWN, never PASS ---------------------------------------------------

test("a source with no resolvable HEAD is UNKNOWN, not PASS", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "parity-bare-"));
  try {
    const result = checkParity({ repo: notARepo, checks: [scriptCheck("never-runs", "check.sh")] });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("no resolvable HEAD");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("a check absent from a world is UNKNOWN for that world, and one measured world is never a parity", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [{ id: "absent", argv: (world) => ["/bin/bash", join(world, "no-such-check.sh")] }] });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("check=absent world=primary UNKNOWN");
    expect(result.findings.join("\n")).toContain("was measured in 0 world(s)");
  });
});

test("a check killed by the bound is UNKNOWN named as a kill, never a pass and never a fail", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nsleep 30\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("hangs", "check.sh")], timeoutMs: 300 });
    expect(result.verdict).toBe("UNKNOWN");
    const finding = result.findings.find((line) => line.includes("check=hangs world=primary"));
    expect(finding).toContain("was killed by");
    expect(result.findings.join("\n")).not.toContain("DIVERGED");
  });
});

test("an empty declared check set measures nothing and says so", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [] });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("declared check set is empty");
  });
});

test("an observed divergence outranks an unbuildable world", () => {
  // A world nobody could build does not un-observe a disagreement between two
  // worlds that WERE built, so the verdict is FAIL and the UNKNOWN rides along.
  withRepo(
    { tracked: { "check.sh": "#!/bin/bash\ntest -f \"$1/inbox.jsonl\"\n" }, untracked: { "inbox.jsonl": "{}\n" } },
    (repo) => {
      const root = mkdtempSync(join(tmpdir(), "parity-root-"));
      try {
        // Occupy the lane-worktree path so `git worktree add` cannot create it.
        mkdirSync(join(root, "lane-worktree"), { recursive: true });
        writeFileSync(join(root, "lane-worktree", "in-the-way"), "");
        const result = checkParity({ repo, root, checks: [scriptCheck("reads-untracked", "check.sh")] });
        expect(result.verdict).toBe("FAIL");
        expect(result.evidence.join("\n")).toContain("world=lane-worktree UNBUILT");
        expect(result.findings.join("\n")).toContain("DIVERGED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

// --- world construction ----------------------------------------------------

test("building the lane worktree does not add a sibling to the primary world", () => {
  withRepo({ tracked: { "a.txt": "a\n" } }, (repo) => {
    const root = mkdtempSync(join(tmpdir(), "parity-root-"));
    try {
      const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
      const worlds = buildWorlds(repo, sha, root);
      expect(worlds.map((world) => world.name)).toEqual([...WORLD_NAMES]);
      const primary = worlds.find((world) => world.name === "primary")!;
      expect("path" in primary).toBe(true);
      const listed = Bun.spawnSync(["git", "-C", (primary as { path: string }).path, "worktree", "list", "--porcelain"]).stdout.toString();
      expect(listed.split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("the primary world says out loud when the source carried nothing extra", () => {
  withRepo({ tracked: { "a.txt": "a\n" } }, (repo) => {
    const root = mkdtempSync(join(tmpdir(), "parity-root-"));
    try {
      const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
      const primary = buildWorlds(repo, sha, root).find((world) => world.name === "primary")!;
      expect((primary as { note: string }).note).toContain("differs from land-main structurally only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("an over-bound mirror makes the primary world UNKNOWN rather than a second land-main", () => {
  const repo = fixtureRepo({ tracked: { "a.txt": "a\n" } });
  const destination = mkdtempSync(join(tmpdir(), "parity-dest-"));
  try {
    for (let index = 0; index < 12; index += 1) writeFileSync(join(repo, `untracked-${index}.txt`), "xxxx");
    // Below the bound the mirror is faithful; above it the world is UNKNOWN.
    // A bound that silently produced a thinner primary would make the primary
    // world compare as a second land-main, which is the fail-open shape gate E
    // exists to remove.
    expect(mirrorWorkingTree(repo, destination, { maxPaths: 12 })).toEqual({ note: "mirrored 12 untracked/ignored path(s) from the source checkout" });
    const overPaths = mirrorWorkingTree(repo, destination, { maxPaths: 11 });
    expect(overPaths).toEqual({ unknown: "the source checkout carries 12 untracked/ignored path(s), over the 11 bound this harness will mirror" });
    const overBytes = mirrorWorkingTree(repo, destination, { maxBytes: 8 });
    expect("unknown" in overBytes && overBytes.unknown).toContain("exceeds the 8-byte bound");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("a symlink is mirrored as a symlink, not resolved into its target's bytes", () => {
  const repo = fixtureRepo({ tracked: { "a.txt": "a\n" }, untracked: { "real.txt": "real\n" } });
  const destination = mkdtempSync(join(tmpdir(), "parity-dest-"));
  try {
    symlinkSync("real.txt", join(repo, "link.txt"));
    // Dangling too: an installed dependency tree carries both, and a mirror
    // that refused either would leave the primary world permanently UNKNOWN on
    // the one repository gate E is about.
    symlinkSync("gone.txt", join(repo, "dangling"));
    expect(mirrorWorkingTree(repo, destination)).toEqual({ note: "mirrored 3 untracked/ignored path(s) from the source checkout" });
    expect(lstatSync(join(destination, "link.txt")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(destination, "link.txt"))).toBe("real.txt");
    expect(lstatSync(join(destination, "dangling")).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("a mirror that cannot be completed is UNKNOWN, not a thinner primary world", () => {
  const repo = fixtureRepo({ tracked: { "a.txt": "a\n" }, untracked: { "nested/file.txt": "x\n" } });
  const destination = mkdtempSync(join(tmpdir(), "parity-dest-"));
  try {
    // `nested` is already a regular FILE in the destination, so creating the
    // directory the mirror needs cannot succeed even for root.
    writeFileSync(join(destination, "nested"), "in the way");
    const mirrored = mirrorWorkingTree(repo, destination);
    expect("unknown" in mirrored).toBe(true);
    expect((mirrored as { unknown: string }).unknown).toContain("nested/file.txt");
    expect((mirrored as { unknown: string }).unknown).toContain("could not be mirrored into the primary world");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("an unbuildable primary world is UNKNOWN and never compared as if it were built", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const root = mkdtempSync(join(tmpdir(), "parity-root-"));
    try {
      // Occupy the primary path so `git clone` cannot create it.
      mkdirSync(join(root, "primary"), { recursive: true });
      writeFileSync(join(root, "primary", "in-the-way"), "");
      const result = checkParity({ repo, root, checks: [scriptCheck("green", "check.sh")] });
      expect(result.verdict).toBe("UNKNOWN");
      expect(result.evidence.join("\n")).toContain("world=primary UNBUILT");
      expect(result.evidence.join("\n")).toContain("clone-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- the declared set is declared -----------------------------------------

test("every declared check names a file the real tree tracks", () => {
  const tracked = new Set(Bun.spawnSync(["git", "-C", REAL_REPO, "ls-files", "-z"]).stdout.toString().split("\0").filter(Boolean));
  expect(DECLARED_CHECKS.length).toBeGreaterThan(0);
  for (const check of DECLARED_CHECKS) {
    const argv = check.argv(REAL_REPO, process.execPath);
    const relative = argv[1]!.slice(REAL_REPO.length + 1);
    expect(tracked.has(relative), `${check.id} -> ${relative}`).toBe(true);
  }
});

test("the declared set stays a bounded sample and every member is justified in the header", () => {
  const source = readFileSync(join(import.meta.dir, "check-checkout-parity.ts"), "utf8");
  const header = source.slice(0, source.indexOf("import {"));
  expect(DECLARED_CHECKS.length).toBeLessThanOrEqual(6);
  for (const check of DECLARED_CHECKS) expect(header, `header must justify ${check.id}`).toContain(check.id);
  expect(header).toContain("THE DECLARED CHECK SET");
});

test("the checker carries no numeric verify count and no verify-count field", () => {
  const source = readFileSync(join(import.meta.dir, "check-checkout-parity.ts"), "utf8");
  expect(source).not.toContain("verify-count");
});

// --- the executable, end to end -------------------------------------------

test("the CLI exits 0 on parity, 1 on divergence, 3 on unknown", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const green = Bun.spawnSync([process.execPath, CHECKER, "--repo", repo, "--timeout-ms", "60000"], { stdout: "pipe", stderr: "pipe" });
    // The real declared set is absent from this fixture, so every check is
    // UNKNOWN there -- which is itself the fail-closed answer under test.
    expect(green.exitCode).toBe(EXIT_CODES.UNKNOWN);
    expect(green.stdout.toString()).toContain("CHECKOUT-PARITY UNKNOWN");
  });

  const real = Bun.spawnSync([process.execPath, CHECKER, "--repo", REAL_REPO], { stdout: "pipe", stderr: "pipe" });
  expect([EXIT_CODES.PASS, EXIT_CODES.FAIL, EXIT_CODES.UNKNOWN]).toContain(real.exitCode);
  expect(real.stdout.toString()).toContain(`worlds=${WORLD_NAMES.join(",")}`);
});

test("a missing argument value is UNKNOWN, never a silent default", () => {
  const run = Bun.spawnSync([process.execPath, CHECKER, "--repo"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(EXIT_CODES.UNKNOWN);
  expect(run.stderr.toString()).toContain("argument-missing");
});

test("runCheck reports a non-zero exit as a fail verdict rather than an error", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 3\n" } }, (repo) => {
    const outcome = runCheck(scriptCheck("red", "check.sh"), repo, process.execPath, 30_000);
    expect(outcome).toEqual({ verdict: "fail", status: 3 });
  });
});

// --- registration ----------------------------------------------------------

test("the checker is registered under the id gate E looks for, in both manifests", () => {
  for (const manifest of ["instance/required-mechanisms.tsv", "instance/expected-mechanisms.tsv"]) {
    const contents = readFileSync(join(REAL_REPO, manifest), "utf8");
    expect(contents, manifest).toContain("checker:checkout-parity\tchecker\ttools/check-checkout-parity.ts");
  }
});
