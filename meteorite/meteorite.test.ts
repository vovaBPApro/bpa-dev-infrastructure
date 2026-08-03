import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const runner = resolve(import.meta.dir, "run.sh");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(failStage = "") {
  const root = await mkdtemp(join(tmpdir(), "meteorite-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  await Bun.$`mkdir -p ${bin}`;
  const docker = join(bin, "docker");
  await writeFile(docker, `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$DOCKER_TRACE"
case "$1" in
  run) printf 'container-id\\n' ;;
  exec)
    command="\${*:3}"
    if [[ "$command" == *"$FAIL_STAGE"* && -n "$FAIL_STAGE" ]]; then exit 19; fi
    if [[ "$command" == *"git -C /work/"*" rev-parse HEAD"* ]]; then printf '%s\\n' "$EXPECTED_SHA"; fi
    ;;
  stop|rm) ;;
  *) exit 91 ;;
esac
`);
  await chmod(docker, 0o755);
  const report = join(root, "report.md");
  const trace = join(root, "docker.trace");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    METEORITE_REPORT: report,
    DOCKER_TRACE: trace,
    FAIL_STAGE: failStage,
    EXPECTED_SHA: sha,
  };
  return { env, report, trace, sha };
}

describe("meteorite runner", () => {
  test("rejects an option with a missing value before starting Docker", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", runner, "--ref"], { env: f.env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("--ref requires a value");
    expect(await Bun.file(f.trace).exists()).toBe(false);
  });

  test("records the selected ref, report shape, stages, and named unproven boundaries", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain(`tested SHA: \`${f.sha}\``);
    expect(report).toContain("container image: `ubuntu:24.04`");
    expect(report).toContain("result: clean");
    expect(report).toContain("bootstrap-dry-run: PASS");
    expect(report).toContain("bootstrap-verify-source: PASS");
    expect(report).toContain("full-test-suite: PASS");
    expect(report).toContain("unit-drift: PASS");
    expect(report).toContain("unit activation —");
    expect(report).toContain("watchdog arm —");
    expect(report).toContain("Telegram transport —");
    expect(await readFile(f.trace, "utf8")).toContain("stop -t 5 container-id");
  });

  test("a failed stage exits non-zero, reports NO-GO and names its blocker", async () => {
    const f = await fixture("bun test");
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("full-test-suite: NO-GO");
    expect(report).toContain("blocker: full-test-suite command failed");
    expect(report).toContain("Telegram transport —");
    expect(await readFile(f.trace, "utf8")).toContain("rm -f container-id");
  });
});
