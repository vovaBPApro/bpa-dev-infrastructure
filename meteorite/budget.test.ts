import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const parser = join(import.meta.dir, "budget.sh");
const tracked = join(import.meta.dir, "stage-budgets.tsv");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("tracked budget is the sum of stage rows and grows with a stage", async () => {
  const baseline = Bun.spawnSync(["bash", parser, "--total", tracked]);
  expect(baseline.exitCode).toBe(0);
  expect(baseline.stdout.toString().trim()).toBe("1590");

  const root = await mkdtemp(join(tmpdir(), "meteorite-budget-"));
  roots.push(root);
  const extended = join(root, "extended.tsv");
  await writeFile(extended, `${await Bun.file(tracked).text()}new-proof-stage\t17\n`);
  const grown = Bun.spawnSync(["bash", parser, "--total", extended]);
  expect(grown.exitCode).toBe(0);
  expect(grown.stdout.toString().trim()).toBe("1607");
});

test("runner/config drift and malformed rows fail closed", async () => {
  const missing = Bun.spawnSync([
    "bash",
    parser,
    "--total",
    tracked,
    "--require-exact",
    "container-start",
  ]);
  expect(missing.exitCode).not.toBe(0);
  expect(missing.stderr.toString()).toContain("tracked stage is not executed by runner");

  const root = await mkdtemp(join(tmpdir(), "meteorite-budget-bad-"));
  roots.push(root);
  const malformed = join(root, "malformed.tsv");
  await writeFile(malformed, "_overhead\t60\nfull-test-suite\t0\n");
  const invalid = Bun.spawnSync(["bash", parser, "--total", malformed]);
  expect(invalid.exitCode).not.toBe(0);
  expect(invalid.stderr.toString()).toContain("seconds must be a positive integer");
});
