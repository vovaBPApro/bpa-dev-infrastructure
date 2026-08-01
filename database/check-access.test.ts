import { expect, test } from "bun:test";

test("database grants and ownership declaration detects drift", () => {
  const result = Bun.spawnSync(["bash", new URL("./check-access.test.sh", import.meta.url).pathname], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0);
  expect(result.stdout.toString()).toContain("scheduled drift lock PASS");
}, 60_000);
