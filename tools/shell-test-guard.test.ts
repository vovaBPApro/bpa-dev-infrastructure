import { expect, test } from "bun:test";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_LOCK_ROOT,
  DEFAULT_STALL_MS,
  DRAIN_GRACE_MS,
  MONITOR_PERIOD_MAX_MS,
  TIMEOUT_SLACK_MS,
  lockAcquireTimeoutMs,
  monitorPeriodMs,
  watchedTestTimeoutMs,
} from "./shell-test-guard";

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

// The stall budget this file's end-to-end alignment lock runs at. It must exceed
// 300 000 ms: below that, round 2's per-test timeout of `stallMs + 30_000` is
// large enough to contain its own uncapped `stallMs / 10` watchdog period, so no
// run below that budget can red on the defect and a lock below it is decoration.
// Tracks the shipped default whenever the shipped default is itself in that
// regime, so the lock keeps measuring the value the tier actually ships.
const ALIGNMENT_STALL_MS = Math.max(DEFAULT_STALL_MS, 300_001);

test(
  "REGRESSION V3-0.23: every bun timeout the guard hands out contains the whole detection latency it must survive",
  () => {
    // The arithmetic half of the round-2 rejection, checked directly. Round 2
    // wrote `resolveStallMs() + 30_000` at the call site, which at the shipped
    // default gave a 390 000 ms timeout around a watchdog whose worst case was
    // 396 000 ms. Whatever the budget, the timeout must strictly contain the
    // budget, one whole watchdog period, and the drain that follows a kill.
    for (const stallMs of [1_000, 3_000, 30_000, 250_000, 300_000, ALIGNMENT_STALL_MS, 5_000_000]) {
      const period = monitorPeriodMs(stallMs);
      // Worst case: the stall begins just after a tick, so it is seen a whole
      // period late, and the caller then drains before it can throw.
      const worstCaseSurfacedAt = stallMs + period + DRAIN_GRACE_MS;
      expect(
        watchedTestTimeoutMs(stallMs) - worstCaseSurfacedAt,
        `stallMs=${stallMs}: the per-test timeout must contain worst-case detection`,
      ).toBe(TIMEOUT_SLACK_MS);
      // The period is what made the round-2 sum diverge: unbounded, it grew with
      // the very budget it was policing.
      expect(period, `stallMs=${stallMs}`).toBeLessThanOrEqual(MONITOR_PERIOD_MAX_MS);
      // And the same sum evaluated against round 2's own arithmetic — uncapped
      // period, timeout written as a flat stallMs + 30_000 — to show which
      // budgets it could not contain. The crossover is stallMs > 250_000, where
      // the uncapped period alone exceeds 30_000 - DRAIN_GRACE_MS.
      const round2Period = Math.max(1_000, Math.floor(stallMs / 10));
      const round2SurfacedAt = stallMs + round2Period + DRAIN_GRACE_MS;
      const round2Contains = stallMs + 30_000 >= round2SurfacedAt;
      expect(round2Contains, `round 2's constant at stallMs=${stallMs}`).toBe(stallMs <= 250_000);
    }
    // The hook timeout has one term to contain, and flock(1) enforces it.
    expect(lockAcquireTimeoutMs(900_000)).toBe(900_000 + TIMEOUT_SLACK_MS);
  },
);

test("REGRESSION V3-0.23: the shell tier derives its bun timeouts from the guard instead of adding its own constant", () => {
  // The arithmetic above is only worth anything while the tier actually uses it.
  // Round 2's defect was not a wrong function, it was a constant written at the
  // call site, so what has to be locked is the call site.
  const tier = readFileSync(join(import.meta.dir, "shell-test-tier.test.ts"), "utf8");
  expect(tier).toContain("watchedTestTimeoutMs()");
  expect(tier).toContain("lockAcquireTimeoutMs()");
  // Any locally added millisecond constant on a resolved bound is the regression.
  const locallyTunedTimeout = /resolve(?:Stall|LockWait)Ms\(\)\s*[+-]/;
  expect(
    locallyTunedTimeout.test(tier),
    "shell-test-tier.test.ts must not size a bun timeout by adding a constant to a resolved bound",
  ).toBe(false);
});

test(
  "REGRESSION V3-0.23: at a budget above 300 000 ms a genuine stall is still decided by the guard and not by bun's timeout",
  async () => {
    // The end-to-end half. Everything else in this file drives the guard at
    // stallMs: 3_000, where the round-2 arithmetic is 31x inside its timeout and
    // therefore cannot fail — which is exactly why round 2 shipped with the
    // defect and a green suite. This runs at the shipped budget instead, and
    // costs roughly ALIGNMENT_STALL_MS of wall clock to do it.
    expect(ALIGNMENT_STALL_MS).toBeGreaterThan(300_000);
    const fixture = makeFixtureRepo("stall-race-at-default");
    try {
      const period = monitorPeriodMs(ALIGNMENT_STALL_MS);
      const tier = join(fixture.root, "aligned.test.ts");
      writeFileSync(
        tier,
        [
          `import { afterAll, beforeAll, expect, test } from "bun:test";`,
          `import { lockAcquireTimeoutMs, watchedTestTimeoutMs } from ${JSON.stringify(guard)};`,
          imports,
          `const STALL = ${ALIGNMENT_STALL_MS};`,
          `const PERIOD = ${period};`,
          `let g; let armedAt = 0;`,
          `beforeAll(async () => {`,
          `  g = ${guardCall(fixture, `stallMs: STALL, lockWaitMs: 60_000`)};`,
          `  armedAt = Date.now();`,
          `}, lockAcquireTimeoutMs(60_000));`,
          `afterAll(async () => { await g?.release(); });`,
          // Phase alignment, and it is the difference between a deterministic
          // lock and one that reds about one run in six. The watchdog is a poll
          // whose ticks start at acquisition; a stall that begins just AFTER a
          // tick is the worst case, because it waits a whole further period to
          // be seen. Park the hang 500 ms past a tick and the worst case is what
          // gets measured every time, rather than whatever phase we landed on.
          `test("park the watchdog phase just past a tick", async () => {`,
          `  const phase = (Date.now() - armedAt) % PERIOD;`,
          `  await Bun.sleep(PERIOD - phase + 500);`,
          `  expect(g.stallReason()).toBe(null);`,
          `}, 120_000);`,
          `test("a genuine hang at the shipped budget", async () => {`,
          `  g.assertRunning();`,
          `  const child = Bun.spawn(["bash", "-c", "echo hung-child-started; sleep 3000 & wait"], { stdout: "pipe", stderr: "pipe" });`,
          `  const stdout = collectStream(child.stdout);`,
          `  const status = await g.watch("hangs", child);`,
          `  await drain([stdout]);`,
          `  const stall = g.stallReason();`,
          `  if (stall) throw new Error(stall + " partial-output=" + stdout.text().trim());`,
          `  expect(status).toBe(0);`,
          `}, watchedTestTimeoutMs(STALL));`,
          `test("the stall is terminal for the tier", async () => {`,
          `  g.assertRunning();`,
          `}, 60_000);`,
        ].join("\n"),
      );
      const started = Date.now();
      const result = Bun.spawnSync([process.execPath, "test", tier], {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
        // The shipped default must be what is measured; an operator's override
        // in the ambient environment would silently drop this run out of the
        // only regime in which it can fail.
        env: { ...process.env, SHELL_TIER_STALL_MS: undefined },
      });
      const output = result.stdout.toString() + result.stderr.toString();
      const elapsedMs = Date.now() - started;
      expect(result.exitCode, output).not.toBe(0);

      // 1. The guard decided, and said why. Round 2 produced a bare
      //    "this test timed out after 390000ms" here and named nothing.
      expect(output).toContain("SHELL_TIER_INCOMPLETE reason=no-progress");
      expect(output).toContain("running=hangs");
      expect(output, "bun's per-test timeout must not be what decides a stall").not.toContain(
        "timed out after",
      );
      // 2. The evidence survives the decision.
      expect(output).toContain("partial-output=hung-child-started");
      // 3. The stall is terminal: the test after the hang must not pass, and the
      //    release record must not report a hung run as unstalled. Round 2 wrote
      //    stalled=no here, which is false evidence inside the evidence gate.
      expect(output).toContain("stalled=yes");
      expect(output).toContain("2 fail");
      expect(output).toContain("Ran 3 tests");
      // 4. It was decided on the guard's clock, and within one watchdog period
      //    of the budget expiring. idle-ms is the detection latency itself, so
      //    this is phase-independent in a way an elapsed-wall-clock bound is not:
      //    an uncapped period would show up here as idle-ms near 1.1 * stallMs.
      const idleMs = Number(output.match(/reason=no-progress idle-ms=(\d+)/)?.[1]);
      expect(idleMs, output).toBeGreaterThanOrEqual(ALIGNMENT_STALL_MS);
      expect(idleMs, output).toBeLessThanOrEqual(
        ALIGNMENT_STALL_MS + monitorPeriodMs(ALIGNMENT_STALL_MS) + 5_000,
      );
      // And the whole run still sat out a genuine budget rather than short-cutting.
      expect(elapsedMs, output).toBeGreaterThan(ALIGNMENT_STALL_MS);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  // Wall clock is dominated by ALIGNMENT_STALL_MS itself: the fixture has to sit
  // out the whole budget for the stall to be genuine. Under a regression it runs
  // longer still, because bun's timeout is then what ends it.
  ALIGNMENT_STALL_MS + 4 * monitorPeriodMs(ALIGNMENT_STALL_MS) + 180_000,
);

test(
  "REGRESSION V3-0.23: a hang decided by the outer runner instead of the guard is never recorded as a healthy run",
  async () => {
    // Defence in depth for the lock above, and cheap enough to run at 3 s. The
    // arithmetic is what stops bun from winning the race; this is what happens
    // if anything ever wins it anyway — an outer harness, a hook timeout, a
    // future runner. The deliberately undersized per-test timeout below plays
    // that part. What must not happen is what round 2 did at its own default:
    // no named reason, a re-armed budget for the next test, and a release record
    // affirmatively reporting stalled=no for a run that hung.
    const fixture = makeFixtureRepo("outer-runner-decides");
    try {
      const tier = join(fixture.root, "abandoned.test.ts");
      writeFileSync(
        tier,
        [
          `import { afterAll, beforeAll, expect, test } from "bun:test";`,
          imports,
          `let g;`,
          `beforeAll(async () => { g = ${guardCall(fixture, "stallMs: 60_000, lockWaitMs: 60_000")}; }, 90_000);`,
          `afterAll(async () => { await g?.release(); });`,
          `test("hangs, with a per-test timeout too small to contain the budget", async () => {`,
          `  g.assertRunning();`,
          `  const child = Bun.spawn(["bash", "-c", "echo hung-child-started; sleep 600 & wait"], { stdout: "pipe", stderr: "pipe" });`,
          `  await g.watch("hangs", child);`,
          // A per-test timeout well inside the 60 s budget: bun kills the child
          // and fails the test while the watchdog still has 55 s to run. This is
          // the hand-sized timeout the derivation exists to prevent, standing in
          // for any outer decider.
          `}, 5_000);`,
          `test("the next test must not get a fresh budget", async () => {`,
          `  g.assertRunning();`,
          `}, 60_000);`,
        ].join("\n"),
      );
      const result = Bun.spawnSync([process.execPath, "test", tier], {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).not.toBe(0);
      // The guard noticed it had been out-raced, and named it.
      expect(output).toContain("SHELL_TIER_INCOMPLETE reason=watch-abandoned");
      expect(output).toContain("abandoned-label=hangs");
      // Terminal, not re-armed: the test after the hang fails too, so the run
      // cannot go on spending a fresh budget per test after it has hung once.
      expect(output).toContain("0 pass");
      expect(output).toContain("2 fail");
      // The record cannot claim health. This single assertion is the one round 2
      // could not satisfy.
      expect(output, "a run that hung must never release with stalled=no").toContain("stalled=yes");
      expect(output).not.toContain("stalled=no");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  120_000,
);

test(
  "REGRESSION V3-0.23: an abandoned watch that nobody asks about is still caught, by the watch itself",
  async () => {
    // The scenario above is caught when the next test asks whether the tier is
    // running. Bun resolves the killed child's `exited` promise asynchronously,
    // so which of the guard's checks gets there first depends on timing the
    // guard does not control — and a hang in the LAST watched test has no next
    // test to ask at all. This drives that ordering instead: one hanging test,
    // and a teardown that yields before releasing, so the watch's own finally is
    // what notices. It is the only path that can name the signal.
    const fixture = makeFixtureRepo("abandoned-last-test");
    try {
      const tier = join(fixture.root, "last.test.ts");
      writeFileSync(
        tier,
        [
          `import { afterAll, beforeAll, test } from "bun:test";`,
          imports,
          `let g;`,
          `beforeAll(async () => { g = ${guardCall(fixture, "stallMs: 60_000, lockWaitMs: 60_000")}; }, 90_000);`,
          `afterAll(async () => { await Bun.sleep(500); await g?.release(); });`,
          `test("the last test hangs", async () => {`,
          `  g.assertRunning();`,
          `  const child = Bun.spawn(["bash", "-c", "echo hung-child-started; sleep 600 & wait"], { stdout: "pipe", stderr: "pipe" });`,
          `  await g.watch("hangs", child);`,
          `}, 5_000);`,
        ].join("\n"),
      );
      const result = Bun.spawnSync([process.execPath, "test", tier], {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(result.exitCode, output).not.toBe(0);
      expect(output).toContain("SHELL_TIER_INCOMPLETE reason=watch-abandoned");
      expect(output).toContain("abandoned-label=hangs");
      // Killed by a signal the guard did not send: that, and not the control
      // flow, is what distinguishes this from a healthy exit.
      expect(output).toContain("signal=SIGTERM");
      expect(output, "a run that hung must never release with stalled=no").toContain("stalled=yes");
      expect(output).not.toContain("stalled=no");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  120_000,
);

test(
  "REGRESSION V3-0.23: a symlinked lock path is refused rather than silently locking another inode",
  async () => {
    const fixture = makeFixtureRepo("lock-path-symlink");
    try {
      // statSync resolves symlinks, so the "assert it is the regular file we
      // manage" check passed while flock(1) took its lock on whatever the link
      // pointed at. Two lanes, one symlinked and one not, then exclude nothing.
      const elsewhere = join(fixture.root, "elsewhere");
      writeFileSync(elsewhere, "");
      symlinkSync(elsewhere, fixture.lockPath);
      const script = join(fixture.root, "symlinked.ts");
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

test(
  "REGRESSION V3-0.23: the expiry next-step names a remedy that survives the landing gate's env -i",
  async () => {
    const fixture = makeFixtureRepo("next-step-under-env-i");
    try {
      // The gate runs the tier through land_run_declared_checks, which invokes
      // bun under `env -i` with HOME, CI and PATH and nothing else. First,
      // establish that this is what makes the old wording wrong.
      const probe = Bun.spawnSync(
        [
          "env",
          "-i",
          `HOME=${process.env.HOME ?? "/nonexistent"}`,
          "CI=1",
          `PATH=${process.env.PATH ?? ""}`,
          process.execPath,
          "-e",
          'console.log("LOCK_WAIT=" + process.env.SHELL_TIER_LOCK_WAIT_MS)',
        ],
        { env: { ...process.env, SHELL_TIER_LOCK_WAIT_MS: "12345" }, stdout: "pipe", stderr: "pipe" },
      );
      expect(probe.stdout.toString().trim()).toBe("LOCK_WAIT=undefined");

      // Now the message itself, produced inside that same environment.
      const holder = Bun.spawn(
        ["flock", "-x", fixture.lockPath, "bash", "-c", "printf HELD; sleep 30"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("HELD");
      reader.releaseLock();

      const script = join(fixture.root, "expire-env-i.ts");
      writeFileSync(script, [imports, `${guardCall(fixture, "lockWaitMs: 1_500")};`].join("\n"));
      const result = Bun.spawnSync(
        [
          "env",
          "-i",
          `HOME=${process.env.HOME ?? "/nonexistent"}`,
          "CI=1",
          `PATH=${process.env.PATH ?? ""}`,
          process.execPath,
          script,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stderr = result.stderr.toString();
      expect(stderr).toContain("SHELL_TIER_INCOMPLETE reason=lock-wait-expired");
      const nextStep = stderr.match(/next-step=(\S+)/)?.[1] ?? "";
      expect(nextStep.length, stderr).toBeGreaterThan(0);
      // A next step naming a variable this environment has just been shown to
      // strip is advice the reader cannot take, at the one place they cannot
      // route around it.
      expect(nextStep, stderr).not.toContain("SHELL_TIER_");
      // Where the number came from stays reportable, so a reader can still tell
      // an override that took effect from one that was stripped.
      expect(stderr).toContain("budget-from=");
      holder.kill("SIGKILL");
      await holder.exited;
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  },
  120_000,
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
