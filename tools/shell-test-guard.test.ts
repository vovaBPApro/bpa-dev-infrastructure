import { expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_LOCK_ROOT } from "./shell-test-guard";

const guard = join(import.meta.dir, "shell-test-guard.ts");
const imports = `import { acquireShellTierGuard, collectStream, drain } from ${JSON.stringify(guard)};`;

// Every fixture origin this file mints. The guard's own locks must never appear
// in the shared host lock root; recording the origins here is what lets the last
// test check that exactly, by name, instead of counting directory entries that
// a concurrently running lane also writes to.
const fixtureOrigins: string[] = [];

function lockFileName(origin: string): string {
  return `${createHash("sha256").update(origin).digest("hex").slice(0, 20)}.lock`;
}

type Fixture = { root: string; lockRoot: string; origin: string; lockPath: string };

function makeFixtureRepo(name: string, options: { withOrigin?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), `shell-tier-${name}-`));
  const origin = `fixture://s10-8-r2/${name}`;
  Bun.spawnSync(["git", "init", "-q", root]);
  if (options.withOrigin !== false) {
    fixtureOrigins.push(origin);
    Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", origin]);
  }
  // The lock root is inside the disposable fixture tree. A fixture that mints
  // locks in the shared host root is the defect V3-0.20 landed a fix for.
  const lockRoot = join(root, "locks");
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  return { root, lockRoot, origin, lockPath: join(lockRoot, lockFileName(origin)) };
}

function guardCall(fixture: Fixture, options: string): string {
  return `await acquireShellTierGuard(${JSON.stringify(fixture.root)}, { lockRoot: ${JSON.stringify(
    fixture.lockRoot,
  )}, ${options} })`;
}

function privateTmp(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test(
  "REGRESSION V3-0.23: a contending tier run waits for the lock and then runs, instead of losing its round",
  async () => {
    const fixture = makeFixtureRepo("bounded-wait");
    try {
      const holderScript = join(fixture.root, "holder.ts");
      writeFileSync(
        holderScript,
        [
          imports,
          `const g = ${guardCall(fixture, "lockWaitMs: 30_000")};`,
          `console.log("HELD");`,
          `await Bun.sleep(4000);`,
          `await g.release();`,
        ].join("\n"),
      );
      // Distinct TMPDIRs on purpose: lane launchers give each lane a private one,
      // so a lock that did not cross that boundary would exclude nothing.
      const holder = Bun.spawn([process.execPath, holderScript], {
        env: { ...process.env, TMPDIR: privateTmp(fixture.root, "holder-tmp") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("HELD");
      reader.releaseLock();

      const contenderScript = join(fixture.root, "contender.ts");
      writeFileSync(
        contenderScript,
        [
          imports,
          `const g = ${guardCall(fixture, "lockWaitMs: 60_000")};`,
          `console.log("ACQUIRED waited-ms=" + g.waitedMs);`,
          `await g.release();`,
        ].join("\n"),
      );
      const contender = Bun.spawnSync([process.execPath, contenderScript], {
        env: { ...process.env, TMPDIR: privateTmp(fixture.root, "contender-tmp") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = contender.stdout.toString() + contender.stderr.toString();
      expect(contender.exitCode, output).toBe(0);
      const waitedMs = Number(output.match(/ACQUIRED waited-ms=(\d+)/)?.[1]);
      // The point of the finding: it must have queued behind the holder rather
      // than failing instantly and discarding its whole verification round.
      expect(waitedMs, output).toBeGreaterThan(2_000);
      await holder.exited;
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  120_000,
);

test(
  "REGRESSION V3-0.23: an expired wait against a real flock(1) holder is named as contention with a bounded next step",
  async () => {
    const fixture = makeFixtureRepo("wait-expiry");
    try {
      // A plain flock(1) holder: interoperating with it proves the guard
      // contends on a genuine kernel lock, not on a lockfile convention.
      const holder = Bun.spawn(
        ["flock", "-x", fixture.lockPath, "bash", "-c", "printf HELD; sleep 30"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("HELD");
      reader.releaseLock();

      const script = join(fixture.root, "expire.ts");
      writeFileSync(script, [imports, `${guardCall(fixture, "lockWaitMs: 1_500")};`].join("\n"));
      const result = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).not.toBe(0);
      expect(stderr).toContain("SHELL_TIER_INCOMPLETE reason=lock-wait-expired");
      expect(stderr).toContain("next-step=");
      expect(stderr).toContain("wait-budget-ms=1500");
      // It waited out its budget rather than reporting contention in 54 ms.
      const waitedMs = Number(stderr.match(/waited-ms=(\d+)/)?.[1]);
      expect(waitedMs, stderr).toBeGreaterThan(1_400);
      holder.kill("SIGKILL");
      await holder.exited;
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  120_000,
);

test(
  "REGRESSION V3-0.23: a slow tier whose wall time far exceeds the stall budget still passes",
  async () => {
    const fixture = makeFixtureRepo("slow-not-hung");
    try {
      const tier = join(fixture.root, "slow.test.ts");
      writeFileSync(
        tier,
        [
          `import { afterAll, beforeAll, expect, test } from "bun:test";`,
          imports,
          `let g;`,
          `beforeAll(async () => { g = ${guardCall(fixture, "stallMs: 3_000, lockWaitMs: 60_000")}; }, 90_000);`,
          `afterAll(async () => { await g?.release(); });`,
          `for (const i of [1, 2, 3, 4, 5, 6]) {`,
          `  test("slow step " + i, async () => {`,
          `    g.assertRunning();`,
          `    const child = Bun.spawn(["bash", "-c", "sleep 2; echo step-done"], { stdout: "pipe", stderr: "pipe" });`,
          `    const status = await g.watch("step" + i, child);`,
          `    const stall = g.stallReason();`,
          `    if (stall) throw new Error(stall);`,
          `    expect(status).toBe(0);`,
          `  }, 60_000);`,
          `}`,
        ].join("\n"),
      );
      const started = Date.now();
      const result = Bun.spawnSync([process.execPath, "test", tier], {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      const elapsedMs = Date.now() - started;
      // A whole-tier wall clock set to this run's stall budget would have failed
      // it four times over. Progress, not total wall time, is what is bounded.
      expect(elapsedMs, output).toBeGreaterThan(4 * 3_000);
      expect(result.exitCode, output).toBe(0);
      expect(output).toContain("6 pass");
      expect(output).toContain("0 fail");
      expect(output).not.toContain("no-progress");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  180_000,
);

test(
  "REGRESSION V3-0.23: a hung tier fails with a named reason and every result it already produced survives",
  async () => {
    const fixture = makeFixtureRepo("hung-tier");
    try {
      const tier = join(fixture.root, "hung.test.ts");
      writeFileSync(
        tier,
        [
          `import { afterAll, beforeAll, expect, test } from "bun:test";`,
          imports,
          `let g;`,
          `beforeAll(async () => { g = ${guardCall(fixture, "stallMs: 3_000, lockWaitMs: 60_000")}; }, 90_000);`,
          `afterAll(async () => { await g?.release(); });`,
          `test("quick", async () => {`,
          `  g.assertRunning();`,
          `  const child = Bun.spawn(["bash", "-c", "echo quick-done"], { stdout: "pipe", stderr: "pipe" });`,
          `  expect(await g.watch("quick", child)).toBe(0);`,
          `}, 60_000);`,
          `test("hangs", async () => {`,
          `  g.assertRunning();`,
          `  // The backgrounded grandchild outlives the kill and keeps the pipe`,
          `  // open, so reading this child's output to end-of-stream would block`,
          `  // forever and turn the named stall into a generic timeout.`,
          `  const child = Bun.spawn(["bash", "-c", "echo hung-child-started; sleep 600 & wait"], { stdout: "pipe", stderr: "pipe" });`,
          `  const stdout = collectStream(child.stdout);`,
          `  const status = await g.watch("hangs", child);`,
          `  await drain([stdout], 2_000);`,
          `  const stall = g.stallReason();`,
          `  if (stall) throw new Error(stall + " partial-output=" + stdout.text().trim());`,
          `  expect(status).toBe(0);`,
          `}, 120_000);`,
          `test("after the stall", async () => {`,
          `  g.assertRunning();`,
          `  expect(true).toBe(true);`,
          `}, 60_000);`,
        ].join("\n"),
      );
      const started = Date.now();
      const result = Bun.spawnSync([process.execPath, "test", tier], {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const elapsedMs = Date.now() - started;
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).not.toBe(0);
      // Decided by the guard, not by an outer timeout waiting on a dead pipe.
      expect(elapsedMs, output).toBeLessThan(60_000);
      expect(output).toContain("SHELL_TIER_INCOMPLETE reason=no-progress");
      expect(output).toContain("running=hangs");
      // The evidence this row exists to produce. A process.exit here would print
      // none of it: measured on bun 1.3.14, an exit from a timer discards the
      // passing tests, the failure reasons and the summary triple alike.
      expect(output).toContain("partial-output=hung-child-started");
      expect(output).toContain("1 pass");
      expect(output).toContain("2 fail");
      expect(output).toContain("Ran 3 tests");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  180_000,
);

test(
  "REGRESSION V3-0.23: an unresolvable lock identity is refused instead of degrading to a per-worktree lock",
  async () => {
    // Two checkouts with no origin. The old fallback keyed the lock on the
    // worktree path, so each got a private lock and mutual exclusion silently
    // disappeared in exactly the topology the guard exists for.
    const first = makeFixtureRepo("no-origin-a", { withOrigin: false });
    const second = makeFixtureRepo("no-origin-b", { withOrigin: false });
    try {
      for (const fixture of [first, second]) {
        const script = join(fixture.root, "identity.ts");
        writeFileSync(
          script,
          [imports, `${guardCall(fixture, "lockWaitMs: 5_000")};`, `console.log("ACQUIRED");`].join(
            "\n",
          ),
        );
        const result = Bun.spawnSync([process.execPath, script], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = result.stdout.toString() + result.stderr.toString();
        expect(result.exitCode, output).not.toBe(0);
        expect(output).toContain("SHELL_TIER_INCOMPLETE reason=lock-identity-unresolved");
        expect(output).not.toContain("ACQUIRED");
        expect(readdirSync(fixture.lockRoot)).toEqual([]);
      }
    } finally {
      rmSync(first.root, { recursive: true, force: true });
      rmSync(second.root, { recursive: true, force: true });
    }
  },
  60_000,
);

test(
  "REGRESSION V3-0.23: a lock failure that is not contention is not reported as contention",
  async () => {
    const fixture = makeFixtureRepo("lock-unavailable");
    try {
      // flock(1) that fails for a reason other than a conflict. The old code
      // labelled every non-zero acquisition exclusive-lock-held, which sends a
      // lane to wait for a holder that does not exist.
      const binDir = privateTmp(fixture.root, "bin");
      writeFileSync(
        join(binDir, "flock"),
        "#!/bin/bash\necho 'flock: cannot open lock file: simulated' >&2\nexit 1\n",
        { mode: 0o700 },
      );
      const script = join(fixture.root, "broken.ts");
      writeFileSync(script, [imports, `${guardCall(fixture, "lockWaitMs: 5_000")};`].join("\n"));
      const result = Bun.spawnSync([process.execPath, script], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = result.stderr.toString();
      expect(result.exitCode, stderr).not.toBe(0);
      expect(stderr).toContain("SHELL_TIER_INCOMPLETE reason=lock-unavailable");
      expect(stderr).toContain("flock-exit=1");
      expect(stderr).toContain("simulated");
      expect(stderr).not.toContain("lock-wait-expired");
      expect(stderr).not.toContain("exclusive-lock-held");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  60_000,
);

test(
  "REGRESSION V3-0.23: a lock path that is not the regular file the guard manages is refused, not locked",
  async () => {
    const fixture = makeFixtureRepo("lock-path-not-a-file");
    try {
      // flock(1) locks a directory inode happily and reports success, which is
      // indistinguishable from a healthy acquisition.
      mkdirSync(fixture.lockPath, { recursive: true });
      const script = join(fixture.root, "notafile.ts");
      writeFileSync(
        script,
        [imports, `${guardCall(fixture, "lockWaitMs: 5_000")};`, `console.log("ACQUIRED");`].join(
          "\n",
        ),
      );
      const result = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).not.toBe(0);
      expect(output).toContain("SHELL_TIER_INCOMPLETE reason=lock-path-not-a-file");
      expect(output).not.toContain("ACQUIRED");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  60_000,
);

test("REGRESSION V3-0.23: the guard's own fixtures leave no lock files in the shared host lock root", () => {
  // Named check, not a count: another lane's real tier run legitimately holds a
  // lock in this directory while these tests execute.
  expect(fixtureOrigins.length).toBeGreaterThan(0);
  const leaked = fixtureOrigins
    .map((origin) => join(DEFAULT_LOCK_ROOT, lockFileName(origin)))
    .filter((path) => existsSync(path));
  expect(leaked).toEqual([]);
});
