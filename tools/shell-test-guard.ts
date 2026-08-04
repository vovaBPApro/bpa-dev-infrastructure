import { createHash } from "crypto";
import { mkdirSync } from "fs";
import { join } from "path";

const DEADLINE_EXIT = 70;

export type ShellTierGuard = {
  release(): Promise<void>;
};

function lockName(repoRoot: string): string {
  const origin = Bun.spawnSync(["git", "-C", repoRoot, "remote", "get-url", "origin"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const identity = origin.exitCode === 0 ? origin.stdout.toString().trim() : repoRoot;
  return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export async function acquireShellTierGuard(
  repoRoot: string,
  deadlineMs = 115_000,
): Promise<ShellTierGuard> {
  // Lane launchers deliberately give each lane a private TMPDIR. The lock must
  // cross that boundary because the contended refs and host services do.
  const lockRoot = join("/tmp", "bpa-shell-test-tier-locks");
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(lockRoot, `${lockName(repoRoot)}.lock`);
  const holder = Bun.spawn(
    ["flock", "--nonblock", lockPath, "bash", "-c", "printf READY; cat >/dev/null"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = holder.stdout.getReader();
  const first = await reader.read();
  const ready = new TextDecoder().decode(first.value);
  reader.releaseLock();
  if (holder.exitCode !== null || ready !== "READY") {
    const detail = (await new Response(holder.stderr).text()).trim();
    throw new Error(
      `SHELL_TIER_INCOMPLETE reason=exclusive-lock-held lock=${lockPath}${detail ? ` detail=${detail}` : ""}`,
    );
  }

  let released = false;
  const deadline = setTimeout(() => {
    process.stderr.write(
      `SHELL_TIER_INCOMPLETE reason=deadline-exceeded deadline-ms=${deadlineMs}\n`,
    );
    process.exit(DEADLINE_EXIT);
  }, deadlineMs);

  return {
    async release() {
      if (released) return;
      released = true;
      clearTimeout(deadline);
      holder.stdin.end();
      await holder.exited;
    },
  };
}
