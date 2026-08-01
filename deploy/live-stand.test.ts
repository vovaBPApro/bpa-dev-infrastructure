import { expect, test } from "bun:test";

test("live stand deploy regression locks", () => {
  const result = Bun.spawnSync(["bash", "deploy/live-stand.test.sh"], {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stdout).toContain("preflight lock: PASS");
  expect(stdout).toContain("disposable-schema startup-preflight refusal before restart: PASS");
  expect(stdout).toContain("explicit fix-forward lock: PASS");
  expect(stdout).toContain("settled-state delay lock: PASS");
  expect(stdout).toContain("exact-SHA wait lock: PASS");
  expect(stdout).toContain("fail-loud contract lock: PASS");
}, 60_000);
