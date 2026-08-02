import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const CHECK = join(import.meta.dir, "dispatch-check.ts");
const COMPOSE = join(import.meta.dir, "compose.ts");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "dispatch-fullpack-"));

afterAll(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function runCheck(name: string, contents: string) {
  const prompt = join(temporaryDirectory, name);
  writeFileSync(prompt, contents);
  return spawnSync("bun", [CHECK, prompt, "--repo", REPO], {
    encoding: "utf8",
    env: { ...process.env, DISPATCH_OVERRIDE: undefined },
  });
}

const composed = spawnSync("bun", [COMPOSE, "--role", "coder", "--repo", REPO], {
  encoding: "utf8",
});
if (composed.status !== 0) throw new Error(`compose failed: ${composed.stderr}`);
const genuine = composed.stdout;
const marker = genuine.split("\n", 1)[0];

describe("dispatch-check full-pack regression lock", () => {
  test("refuses a valid marker with an empty body", () => {
    const result = runCheck("empty.md", marker + "\n");
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("REFUSED");
  });

  test("refuses a hash mismatch in a declared materialized document", () => {
    const docStart = genuine.indexOf("<!-- doc id=lane-lifecycle ");
    const heading = genuine.indexOf("# Lane Lifecycle", docStart);
    const altered = genuine.slice(0, heading) + genuine.slice(heading).replace(
      "# Lane Lifecycle",
      "# Forged Lane Lifecycle",
    );
    expect(altered).not.toBe(genuine);
    const result = runCheck("hash-mismatch.md", altered);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("hash mismatch");
  });

  test("refuses a missing role baseline document", () => {
    const start = genuine.indexOf("<!-- doc id=lane-lifecycle ");
    const end = genuine.indexOf("<!-- doc id=verification-and-locks ", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const missing = genuine.slice(0, start) + genuine.slice(end);
    const result = runCheck("missing-baseline.md", missing);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("baseline");
  });

  test("refuses a marker stamped with the wrong L1 SHA", () => {
    const wrong = genuine.replace(/ l1=[0-9a-f]{8,40} -->/, " l1=deadbeef -->");
    const result = runCheck("wrong-l1.md", wrong);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("L1 SHA");
  });

  test("accepts an unmodified compose.ts-produced pack", () => {
    const result = runCheck("genuine.md", genuine);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("full pack valid");
  });
});
