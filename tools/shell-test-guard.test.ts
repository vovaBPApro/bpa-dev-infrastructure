import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const guard = join(import.meta.dir, "shell-test-guard.ts");

test("REGRESSION V3-0.23: a concurrent shell tier exits non-zero with the real kernel lock held", async () => {
  const root = mkdtempSync(join(tmpdir(), "shell-tier-contention-"));
  try {
    Bun.spawnSync(["git", "init", "-q", root]);
    Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", "fixture://same-suite"]);
    const holderTmp = join(root, "holder-tmp");
    const contenderTmp = join(root, "contender-tmp");
    Bun.spawnSync(["mkdir", "-p", holderTmp, contenderTmp]);
    const holderScript = join(root, "holder.ts");
    writeFileSync(holderScript, `import { acquireShellTierGuard } from ${JSON.stringify(guard)};\nconst lock = await acquireShellTierGuard(${JSON.stringify(root)}, 5000);\nconsole.log("HELD");\nawait Bun.sleep(3000);\nawait lock.release();\n`);
    const holder = Bun.spawn([process.execPath, holderScript], {
      env: { ...process.env, TMPDIR: holderTmp }, stdout: "pipe", stderr: "pipe",
    });
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("HELD");

    const contenderScript = join(root, "contender.ts");
    writeFileSync(contenderScript, `import { acquireShellTierGuard } from ${JSON.stringify(guard)};\nawait acquireShellTierGuard(${JSON.stringify(root)}, 5000);\n`);
    const contender = Bun.spawnSync([process.execPath, contenderScript], {
      env: { ...process.env, TMPDIR: contenderTmp }, stdout: "pipe", stderr: "pipe",
    });
    expect(contender.exitCode).not.toBe(0);
    expect(contender.stderr.toString()).toContain("SHELL_TIER_INCOMPLETE reason=exclusive-lock-held");
    holder.kill();
    await holder.exited;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("REGRESSION V3-0.23: an unfinished shell tier beats the outer timeout with exit 70", () => {
  const root = mkdtempSync(join(tmpdir(), "shell-tier-deadline-"));
  try {
    Bun.spawnSync(["git", "init", "-q", root]);
    Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", "fixture://deadline-suite"]);
    const script = join(root, "deadline.ts");
    writeFileSync(script, `import { acquireShellTierGuard } from ${JSON.stringify(guard)};\nawait acquireShellTierGuard(${JSON.stringify(root)}, 50);\nawait Bun.sleep(5000);\n`);
    const result = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(70);
    expect(result.stderr.toString()).toContain("SHELL_TIER_INCOMPLETE reason=deadline-exceeded deadline-ms=50");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
