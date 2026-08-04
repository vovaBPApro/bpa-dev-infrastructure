import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

const fixture = join(import.meta.dir, "launch-lane.test.sh");

function runFixture(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", 'umask 0077; exec env -u BUN_BIN bash "$1"', "_", fixture], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test(
  "two launch fixtures concurrently own disjoint repositories and refs at umask 0077",
  async () => {
    const results = await Promise.all([runFixture(), runFixture()]);
    for (const result of results) {
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("launch-lane dispatch proof: PASS");
    }
  },
  30_000,
);
