import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join } from "path";

// This test IS the executor for check-shared-stash.test.sh. The landing gate
// discovers tracked .test.ts files, but not shell tests, so invoke the complete
// shell regression lock by its exact path and surface its output on failure.

const shellLock = join(import.meta.dir, "check-shared-stash.test.sh");

function runLock(env: Record<string, string> = {}) {
  return spawnSync("bash", [shellLock], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
    env: { ...process.env, ...env, BUN_BIN: undefined },
  });
}

test("scratch commits isolate concurrent lanes and shared stash is rejected", () => {
  const result = runLock();
  expect(`${result.stdout}${result.stderr}`).toContain(
    "PASS: two concurrent lanes restored only their own scratch-committed files",
  );
  expect(`${result.stdout}${result.stderr}`).toContain(
    "PASS: checker rejects a shared stash and names the collision and safe alternative",
  );
  expect(result.status).toBe(0);
});

test("the shell lock goes red when the checker accepts a shared stash", () => {
  const result = runLock({ CHECK_SHARED_STASH_CHECKER: "/bin/true" });
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "FAIL: checker accepted refs/stash with multiple worktrees",
  );
});
