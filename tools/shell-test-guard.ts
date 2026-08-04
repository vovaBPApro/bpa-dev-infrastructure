import { createHash } from "crypto";
import { closeSync, mkdirSync, openSync, statSync } from "fs";
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
// was gate/land.test.sh at 86.35 s (next: bootstrap/bootstrap.test.sh 26.14 s,
// gate/land-rollback.test.sh 24.37 s; whole-tier sum 200.5 s against 92.5 s
// idle, so full contention costs about 2.2x). The bound is the worst measurement
// with a safety factor of 4.
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
export async function drain(streams: CollectedStream[], graceMs = 5_000): Promise<void> {
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

/** The effective bounds, including any environment override. Callers need these
 *  to size their own timeouts: a bun hook or test timeout below the bound it is
 *  meant to contain would abort the wait or the watchdog before either decides,
 *  which is how a tuned constant reintroduces the failure it was tuned against. */
export function resolveLockWaitMs(): number {
  return envMs("SHELL_TIER_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS);
}

export function resolveStallMs(): number {
  return envMs("SHELL_TIER_STALL_MS", DEFAULT_STALL_MS);
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
  let existing = null;
  try {
    existing = statSync(lockPath);
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
      throw new ShellTierIncomplete("lock-wait-expired", {
        lock: lockPath,
        "waited-ms": waitedMs,
        "wait-budget-ms": lockWaitMs,
        "next-step": "rerun-the-tier-alone-or-raise-SHELL_TIER_LOCK_WAIT_MS",
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
  let watched: { label: string; child: WatchableChild } | null = null;

  function noteProgress(label: string): void {
    lastProgressAt = Date.now();
    lastLabel = label;
    progressEvents += 1;
  }

  function stallReason(): string | null {
    return stalled;
  }

  function assertRunning(): void {
    if (stalled) throw new Error(stalled);
  }

  const monitor = setInterval(
    () => {
      if (released || stalled) return;
      const idleMs = Date.now() - lastProgressAt;
      if (idleMs < stallMs) return;
      stalled =
        `SHELL_TIER_INCOMPLETE reason=no-progress idle-ms=${idleMs}` +
        ` stall-budget-ms=${stallMs} last-progress=${lastLabel}` +
        ` running=${watched ? watched.label : "none"}`;
      emit(stalled);
      // Kill the stalled child so its awaited test fails through bun's own
      // reporter. Exiting the process here would destroy every result the tier
      // has already produced, which is the evidence this tier exists to produce.
      try {
        watched?.child.kill("SIGKILL");
      } catch {
        // The child may already be gone; the declared stall still stands.
      }
    },
    Math.max(1_000, Math.floor(stallMs / 10)),
  );
  monitor.unref?.();

  async function watch(label: string, child: WatchableChild): Promise<number> {
    assertRunning();
    noteProgress(`start:${label}`);
    watched = { label, child };
    try {
      return await child.exited;
    } finally {
      watched = null;
      noteProgress(`end:${label}`);
    }
  }

  async function release(): Promise<void> {
    if (released) return;
    released = true;
    clearInterval(monitor);
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
