import { createHash } from "crypto";
import { closeSync, lstatSync, mkdirSync, openSync } from "fs";
import { join } from "path";

// Serialisation and liveness for the shell-test tier.
//
// Two separate jobs, deliberately kept apart:
//
//   1. Exclusion. The pinned shell tests contend for host-global names, so only
//      one tier run per repository may execute at a time. That is a real kernel
//      flock, held for the whole tier.
//   2. Liveness. A tier that stops making progress must fail with a named
//      reason rather than hang until something outside it decides to kill it.
//
// What this file must never do is confuse SLOW with HUNG. Tier wall time is
// load-dependent — measured on this 12-core host, the same fully passing run
// took 92.5 s idle and 115.2 s under full load — so any whole-tier wall-clock
// constant small enough to beat an outer kill also sits inside the spread of a
// healthy run. Liveness is therefore measured as time since the last observed
// progress event, a quantity bounded by the slowest single shell test rather
// than by the length of the tier, and so not a function of host load.
//
// It must also never call process.exit(). Measured on bun 1.3.14: a process.exit
// from a timer discards every buffered line, including the failing test's named
// reason and the summary triple, so a hung run and a killed run become textually
// identical. A stall therefore kills the stalled child and fails that test,
// which lets bun's own reporter print the tier's results and exit non-zero.

export const DEFAULT_LOCK_ROOT = "/tmp/bpa-shell-test-tier-locks";

// Derived from measurement, not chosen. Every pinned shell test was timed
// individually under deliberate 12-worker load on this 12-core host; the slowest
// was gate/land.test.sh at 86.35 s (next: gate/land-rollback.test.sh 54.46 s,
// bootstrap/bootstrap.test.sh 27.31 s; whole-tier serial sum 235.4 s against
// 92.5 s idle, so full contention costs about 2.5x). The bound is the worst
// measurement with a safety factor of 4.
//
// The secondary figures were corrected in round 3. The original comment put
// gate/land-rollback.test.sh at 24.37 s; two later independent passes measured
// 52.84 s and 54.46 s, so that figure was wrong by better than 2x. The serial
// sum moved with it (200.5 s originally, 223.5 s and 235.4 s since). What did
// NOT move is the constant, and that is the property worth stating: it is
// derived from the MAXIMUM and not from the sum, and the maximum reproduced
// across all three passes at 86.35 / 86.00 / 87.49 s — a spread of 1.7%. A 2x
// error in the second-slowest test does not reach it.
//
// The factor is deliberately generous and the asymmetry is the reason: a bound
// that is too small manufactures the false red this tier exists to eliminate,
// while a bound that is too large costs only latency in reporting a hang that is
// by definition unbounded. Because the quantity bounded is one test's runtime
// rather than the tier's, adding a pinned shell test does not erode it, and a
// host 4x slower than this one still passes.
export const DEFAULT_STALL_MS = 360_000;

// A contending run waits rather than discarding its work. The holder keeps the
// lock for one whole tier run, measured at 92.5 s idle and ~200 s under full
// contention, so this budget covers roughly four queued lanes ahead of you —
// the five-or-six-lane fleet this guard was written for. Past that the run
// reports lock-wait-expired with a bounded next step instead of pretending the
// tier ran; a larger fleet raises SHELL_TIER_LOCK_WAIT_MS.
export const DEFAULT_LOCK_WAIT_MS = 900_000;

// flock(1) exits with this code, and only this code, when it gives up because
// somebody else holds the lock. Every other non-zero exit is a real failure of
// the locking machinery and must not be reported as contention.
const LOCK_CONFLICT_EXIT = 75;

const WAIT_HEARTBEAT_MS = 15_000;

// Grace for the bounded drain a caller performs after a stall is declared. It is
// exported because it sits between the moment the watchdog decides and the
// moment the caller's test throws, so a caller's timeout has to contain it.
export const DRAIN_GRACE_MS = 5_000;

// Scheduling slack added on top of every quantity a caller's timeout must
// contain. It is slack and nothing else: it may never be the term that makes a
// timeout large enough, because then the timeout is a tuned constant again.
export const TIMEOUT_SLACK_MS = 30_000;

// The watchdog is a poll, so a stall beginning just after a tick is declared up
// to one whole period late: worst-case detection is stallMs + period, not
// stallMs. The period must therefore stay bounded rather than grow with the
// budget it polices. Round 2 derived it as stallMs / 10 with no ceiling, which at
// DEFAULT_STALL_MS meant a 36 s period and 396 s worst-case detection inside a
// 390 s per-test timeout — the watchdog armed to decide later than the runner
// containing it, which is the failure this cap and watchedTestTimeoutMs close.
export const MONITOR_PERIOD_MIN_MS = 1_000;
export const MONITOR_PERIOD_MAX_MS = 15_000;

export type ShellTierGuardOptions = {
  /** Directory holding lock files. Tests point this at their own temp tree so
   *  fixtures never mint locks in the shared host root. */
  lockRoot?: string;
  lockWaitMs?: number;
  stallMs?: number;
  /** Where the guard's own event lines go. Defaults to stderr, which bun does
   *  not buffer, so the lines survive whatever happens to the run. */
  onEvent?: (line: string) => void;
};

export type WatchableChild = {
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  /** Set by bun when the child was terminated by a signal rather than by its own
   *  exit. The guard reads it to tell "this child finished" from "somebody else
   *  killed this child", which is how an abandoned watch is detected. */
  readonly signalCode?: string | null;
};

export type ShellTierGuard = {
  readonly lockPath: string;
  readonly waitedMs: number;
  readonly stallMs: number;
  readonly lockWaitMs: number;
  /** Records that the tier is still moving. */
  noteProgress(label: string): void;
  /** Throws the named stall reason once a stall has been declared. */
  assertRunning(): void;
  /** The stall reason, or null while the tier is making progress. */
  stallReason(): string | null;
  /** Runs a child under the stall watchdog; resolves with its exit status. */
  watch(label: string, child: WatchableChild): Promise<number>;
  release(): Promise<void>;
};

export type CollectedStream = {
  /** Everything that has arrived so far. Never blocks. */
  text(): string;
  /** Resolves at end of stream. May never resolve, which is the point. */
  settled: Promise<void>;
};

/**
 * Accumulates a child's output as it arrives instead of reading to EOF at the
 * end. Killing a stalled child does not kill grandchildren that inherited its
 * pipes, so an end-of-stream read can block indefinitely on a process nobody is
 * waiting for — turning a named stall into a generic timeout and losing the
 * output with it. Whatever arrived is always available here.
 */
export function collectStream(stream: ReadableStream<Uint8Array>): CollectedStream {
  const decoder = new TextDecoder();
  let buffer = "";
  const settled = (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
      }
    } catch {
      // A torn-down stream still leaves everything received before the tear.
    }
  })();
  return { text: () => buffer, settled };
}

/** Bounded drain: EOF normally arrives at once, and when it does not, the
 *  output already collected is the evidence rather than a reason to hang. */
export async function drain(streams: CollectedStream[], graceMs = DRAIN_GRACE_MS): Promise<void> {
  await Promise.race([Promise.all(streams.map((s) => s.settled)), Bun.sleep(graceMs)]);
}

export class ShellTierIncomplete extends Error {
  readonly reason: string;

  constructor(reason: string, fields: Record<string, string | number> = {}) {
    const rendered = Object.entries(fields)
      .map(([key, value]) => ` ${key}=${value}`)
      .join("");
    super(`SHELL_TIER_INCOMPLETE reason=${reason}${rendered}`);
    this.name = "ShellTierIncomplete";
    this.reason = reason;
  }
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ShellTierIncomplete("guard-misconfigured", { setting: name, value: raw });
  }
  return parsed;
}

/** The effective bounds, including any environment override. A bun hook or test
 *  timeout below the bound it is meant to contain would abort the wait or the
 *  watchdog before either decides, which is how a tuned constant reintroduces
 *  the failure it was tuned against. Callers must therefore size their timeouts
 *  with lockAcquireTimeoutMs / watchedTestTimeoutMs below, never by adding a
 *  constant of their own to these. */
export function resolveLockWaitMs(): number {
  return envMs("SHELL_TIER_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS);
}

export function resolveStallMs(): number {
  return envMs("SHELL_TIER_STALL_MS", DEFAULT_STALL_MS);
}

/** How often the stall watchdog looks, bounded above so that worst-case
 *  detection stays stallMs + a constant instead of stallMs * 1.1. */
export function monitorPeriodMs(stallMs: number): number {
  return Math.min(
    MONITOR_PERIOD_MAX_MS,
    Math.max(MONITOR_PERIOD_MIN_MS, Math.floor(stallMs / 10)),
  );
}

/**
 * The bun per-test timeout a watched child requires, derived from every quantity
 * that must elapse before the caller can throw the named stall — never tuned.
 *
 *   stallMs            the budget itself
 * + monitorPeriodMs    the watchdog is a poll; it may see the stall a period late
 * + DRAIN_GRACE_MS     the caller drains the killed child's output before throwing
 * + TIMEOUT_SLACK_MS   scheduling slack, and only slack
 *
 * If this is smaller than that sum, bun's timeout decides a genuine hang before
 * the guard does: the failure carries no named reason, the release record says
 * `stalled=no` for a run that hung, and the tier keeps going. That is V3-0.23's
 * round-2 rejection, and `shell-test-guard.test.ts` locks this sum directly and
 * end-to-end at a budget above 300 000 ms, which is the smallest budget at which
 * the round-2 arithmetic could fail.
 */
export function watchedTestTimeoutMs(stallMs: number = resolveStallMs()): number {
  return stallMs + monitorPeriodMs(stallMs) + DRAIN_GRACE_MS + TIMEOUT_SLACK_MS;
}

/** The bun hook timeout the acquisition requires. flock(1) enforces the wait
 *  budget itself, so the only extra term is slack for spawn and identity
 *  resolution. */
export function lockAcquireTimeoutMs(lockWaitMs: number = resolveLockWaitMs()): number {
  return lockWaitMs + TIMEOUT_SLACK_MS;
}

// The lock is shared across worktrees, so its identity must be a property of the
// repository and not of the checkout. An unresolvable identity is a refusal:
// falling back to the worktree path would give every lane a private lock and
// silently remove the exclusion this guard exists to provide.
function lockIdentity(repoRoot: string): string {
  let origin;
  try {
    origin = Bun.spawnSync(["git", "-C", repoRoot, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    throw new ShellTierIncomplete("lock-identity-unresolved", {
      repo: repoRoot,
      detail: String(cause),
    });
  }
  const url = origin.stdout.toString().trim();
  if (origin.exitCode !== 0 || url === "") {
    throw new ShellTierIncomplete("lock-identity-unresolved", {
      repo: repoRoot,
      "git-exit": origin.exitCode ?? -1,
      detail: origin.stderr.toString().trim() || "empty-origin-url",
    });
  }
  return url;
}

function prepareLockPath(lockRoot: string, repoRoot: string): string {
  const digest = createHash("sha256").update(lockIdentity(repoRoot)).digest("hex").slice(0, 20);
  try {
    mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new ShellTierIncomplete("lock-root-unusable", { root: lockRoot, detail: String(cause) });
  }
  const lockPath = join(lockRoot, `${digest}.lock`);
  // flock(1) will lock a directory inode and report success, which is
  // indistinguishable from a healthy acquisition while saying nothing about the
  // file we believe we hold. Assert the target is the regular file we manage.
  // lstat, not stat: stat resolves symlinks, so a symlinked lock path passed
  // isFile() while the kernel lock landed on some other inode entirely — the
  // guard would report holding <digest>.lock and exclude nobody.
  let existing = null;
  try {
    existing = lstatSync(lockPath);
  } catch {
    existing = null;
  }
  if (existing && !existing.isFile()) {
    throw new ShellTierIncomplete("lock-path-not-a-file", { lock: lockPath });
  }
  try {
    closeSync(openSync(lockPath, "a", 0o600));
  } catch (cause) {
    throw new ShellTierIncomplete("lock-path-unusable", { lock: lockPath, detail: String(cause) });
  }
  return lockPath;
}

export async function acquireShellTierGuard(
  repoRoot: string,
  options: ShellTierGuardOptions = {},
): Promise<ShellTierGuard> {
  const lockRoot = options.lockRoot ?? DEFAULT_LOCK_ROOT;
  const lockWaitMs = options.lockWaitMs ?? resolveLockWaitMs();
  const stallMs = options.stallMs ?? resolveStallMs();
  const lockWaitFrom =
    options.lockWaitMs !== undefined
      ? "caller-option"
      : (process.env.SHELL_TIER_LOCK_WAIT_MS ?? "").trim() !== ""
        ? "SHELL_TIER_LOCK_WAIT_MS"
        : "DEFAULT_LOCK_WAIT_MS";
  const emit = options.onEvent ?? ((line: string) => void process.stderr.write(`${line}\n`));

  const lockPath = prepareLockPath(lockRoot, repoRoot);

  // Lane launchers deliberately give each lane a private TMPDIR. The lock must
  // cross that boundary because the contended refs and host services do.
  const startedAt = Date.now();
  let holder;
  try {
    holder = Bun.spawn(
      [
        "flock",
        "--timeout",
        (lockWaitMs / 1000).toFixed(3),
        "--conflict-exit-code",
        String(LOCK_CONFLICT_EXIT),
        lockPath,
        "bash",
        "-c",
        "printf READY; cat >/dev/null",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  } catch (cause) {
    throw new ShellTierIncomplete("lock-tool-unavailable", {
      lock: lockPath,
      detail: String(cause),
    });
  }

  // A wait is not a hang, but in a truncated log the two look the same. Say so.
  const heartbeat = setInterval(() => {
    emit(
      `SHELL_TIER_LOCK_WAIT waited-ms=${Date.now() - startedAt}` +
        ` wait-budget-ms=${lockWaitMs} lock=${lockPath}`,
    );
  }, WAIT_HEARTBEAT_MS);
  heartbeat.unref?.();

  let ready = "";
  try {
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    ready = first.value ? new TextDecoder().decode(first.value) : "";
    reader.releaseLock();
  } finally {
    clearInterval(heartbeat);
  }

  const waitedMs = Date.now() - startedAt;
  if (ready !== "READY") {
    const exitCode = await holder.exited;
    const detail = (await new Response(holder.stderr).text()).trim();
    if (exitCode === LOCK_CONFLICT_EXIT) {
      // The next step must name only a remedy that exists where this message is
      // read. The landing gate invokes the tier under `env -i` with HOME, CI and
      // PATH and nothing else (gate/land-lib.sh, land_run_declared_checks), so
      // SHELL_TIER_LOCK_WAIT_MS is unset there by construction and telling the
      // reader to raise it would be advice they cannot take. Rerunning the tier
      // when the fleet is idle always works. `budget-from` says where the number
      // actually came from, so a reader who does have the override knows whether
      // it took effect, and a reader inside the gate can see that it did not.
      throw new ShellTierIncomplete("lock-wait-expired", {
        lock: lockPath,
        "waited-ms": waitedMs,
        "wait-budget-ms": lockWaitMs,
        "budget-from": lockWaitFrom,
        "next-step": "rerun-the-tier-alone-when-the-fleet-is-idle",
      });
    }
    throw new ShellTierIncomplete("lock-unavailable", {
      lock: lockPath,
      "flock-exit": exitCode,
      detail: detail || "no-stderr",
    });
  }

  const acquiredAt = Date.now();
  emit(
    `SHELL_TIER_ACQUIRED lock=${lockPath} waited-ms=${waitedMs}` +
      ` stall-budget-ms=${stallMs} wait-budget-ms=${lockWaitMs}`,
  );

  let released = false;
  let lastProgressAt = Date.now();
  let lastLabel = "tier-start";
  let progressEvents = 0;
  let stalled: string | null = null;
  let watched: { label: string; child: WatchableChild; startedAt: number } | null = null;

  /** Records a stall exactly once and says so on the event stream. Every path
   *  that ends the tier's liveness goes through here, so `stalled` can never be
   *  false while the run is known to have hung. */
  function declareStall(reason: string, fields: Record<string, string | number>): void {
    if (stalled) return;
    stalled = new ShellTierIncomplete(reason, fields).message;
    emit(stalled);
  }

  function noteProgress(label: string): void {
    lastProgressAt = Date.now();
    lastLabel = label;
    progressEvents += 1;
  }

  function stallReason(): string | null {
    return stalled;
  }

  /**
   * A watch is outstanding only while `watch()` is awaiting that child. Nothing
   * else in the tier runs during it, so finding one outstanding from anywhere
   * else means the caller stopped awaiting it without the guard deciding —
   * bun's per-test timeout, a hook timeout, an outer harness.
   *
   * This has to be checked from `assertRunning()` and not only from the next
   * `watch()`, because bun resolves the killed child's `exited` promise
   * asynchronously: measured here, the next test can start and ask whether the
   * tier is running BEFORE `watch()`'s own finally has run. Without this the
   * answer to that question is "yes" for a run that has already hung.
   */
  function noticeAbandonedWatch(detail: string): void {
    if (stalled || !watched) return;
    declareStall("watch-abandoned", {
      "abandoned-label": watched.label,
      "abandoned-elapsed-ms": Date.now() - watched.startedAt,
      "stall-budget-ms": stallMs,
      detail,
      "next-step": "treat-this-tier-run-as-incomplete",
    });
    // Do not leave it watched: the watchdog would otherwise kill it later and
    // attribute the hang to whichever test happened to be running by then.
    killWatched();
    watched = null;
  }

  function assertRunning(): void {
    noticeAbandonedWatch("outer-runner-stopped-awaiting-a-watched-child");
    if (stalled) throw new Error(stalled);
  }

  function killWatched(): void {
    // Kill the stalled child so its awaited test fails through bun's own
    // reporter. Exiting the process here would destroy every result the tier
    // has already produced, which is the evidence this tier exists to produce.
    try {
      watched?.child.kill("SIGKILL");
    } catch {
      // The child may already be gone; the declared stall still stands.
    }
  }

  const monitor = setInterval(() => {
    if (released || stalled) return;
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs < stallMs) return;
    declareStall("no-progress", {
      "idle-ms": idleMs,
      "stall-budget-ms": stallMs,
      "last-progress": lastLabel,
      running: watched ? watched.label : "none",
    });
    killWatched();
  }, monitorPeriodMs(stallMs));
  monitor.unref?.();

  async function watch(label: string, child: WatchableChild): Promise<number> {
    // Covers re-entry with a previous watch still outstanding: assertRunning
    // notices it, so this never reassigns `watched` out from under the watchdog.
    assertRunning();
    noteProgress(`start:${label}`);
    const startedAt = Date.now();
    watched = { label, child, startedAt };
    let exitedOnItsOwn = false;
    try {
      const status = await child.exited;
      exitedOnItsOwn = true;
      return status;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      // Measured on bun 1.2.22 and 1.3.14: when a per-test timeout fires, bun
      // SIGTERMs the dangling child, so `exited` resolves and this block runs
      // exactly as it does on a healthy exit — the guard cannot tell the two
      // apart by control flow. The signal is what tells them apart. A watched
      // child that the guard did not kill, and that did not exit on its own
      // terms, was killed by somebody else, and that somebody decided a hang
      // before the watchdog could. Left unrecorded it becomes `stalled=no` on a
      // run that hung plus a re-armed budget for the next test, which is
      // V3-0.23 round 2's rejection.
      //
      // Deliberately not conditioned on elapsedMs reaching the budget: a runner
      // that kills EARLIER than the budget has out-raced the watchdog by more,
      // not less, and that is the case a caller who sizes a timeout by hand
      // produces. `abandoned-elapsed-ms` reports which of the two happened.
      const signalled = (child.signalCode ?? null) !== null;
      if (!stalled && exitedOnItsOwn && signalled) {
        declareStall("watch-abandoned", {
          "abandoned-label": label,
          "abandoned-elapsed-ms": elapsedMs,
          "stall-budget-ms": stallMs,
          signal: String(child.signalCode),
          detail: "killed-by-something-other-than-the-watchdog",
          "next-step": "treat-this-tier-run-as-incomplete",
        });
      }
      watched = null;
      noteProgress(`end:${label}`);
    }
  }

  async function release(): Promise<void> {
    if (released) return;
    released = true;
    clearInterval(monitor);
    // The last watch never came back and there is no next test to notice it for
    // us. Checked before the release record is written, so that record can never
    // say stalled=no about a run that was still holding a hung child.
    noticeAbandonedWatch("released-while-a-watched-child-was-still-outstanding");
    emit(
      `SHELL_TIER_RELEASE lock=${lockPath} held-ms=${Date.now() - acquiredAt}` +
        ` waited-ms=${waitedMs} progress-events=${progressEvents}` +
        ` stalled=${stalled ? "yes" : "no"}`,
    );
    holder.stdin.end();
    await holder.exited;
  }

  return {
    lockPath,
    waitedMs,
    stallMs,
    lockWaitMs,
    noteProgress,
    assertRunning,
    stallReason,
    watch,
    release,
  };
}
