import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const runner = process.env.METEORITE_TEST_RUNNER ?? resolve(import.meta.dir, "run.sh");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(failStage = "", checkedOutSha = "") {
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
    EXPECTED_SHA: checkedOutSha || sha,
    METEORITE_DONOR_SHA: sha,
    METEORITE_DONOR_REF: `refs/meteorite-candidates/1700000000-123-${sha}/v2-deprecated`,
  };
  return { env, report, trace, sha };
}

describe("meteorite runner", () => {
  test("the default report stays outside the checkout and the run names its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "meteorite-clean-tree-test-"));
    roots.push(root);
    const checkout = join(root, "checkout");
    const stateHome = join(root, "state");
    await Bun.$`mkdir -p ${join(checkout, "meteorite")}`;
    await cp(runner, join(checkout, "meteorite", "run.sh"));
    await cp(resolve(import.meta.dir, "budget.sh"), join(checkout, "meteorite", "budget.sh"));
    await cp(resolve(import.meta.dir, "stage-budgets.tsv"), join(checkout, "meteorite", "stage-budgets.tsv"));
    await Bun.$`git -C ${checkout} init -q`;
    await Bun.$`git -C ${checkout} add meteorite`;
    await Bun.$`git -C ${checkout} -c user.name=test -c user.email=test@example.invalid commit -qm baseline`;

    const f = await fixture();
    const env = { ...f.env, XDG_STATE_HOME: stateHome };
    delete env.METEORITE_REPORT;
    const localRunner = join(checkout, "meteorite", "run.sh");
    const run = Bun.spawnSync(["bash", localRunner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env });
    expect(run.exitCode).toBe(0);
    const report = join(stateHome, "bpa-dev-infrastructure", "evidence", "meteorite-latest.md");
    expect(await Bun.file(report).exists()).toBe(true);
    expect(run.stdout.toString()).toContain(`[meteorite] report: ${report}`);
    expect(Bun.spawnSync(["git", "-C", checkout, "status", "--porcelain"]).stdout.toString()).toBe("");
  });

  test("every publisher-supplied test prerequisite is validated by environment name before Docker starts", async () => {
    const source = await readFile(runner, "utf8");
    const prerequisiteCommand = source.match(/"test-prerequisites\|([^\n]+)"/)?.[1] ?? "";
    const shellNames = new Map([
      ["donor_sha", "METEORITE_DONOR_SHA"],
      ["donor_ref", "METEORITE_DONOR_REF"],
    ]);
    const requiredInputs = [...prerequisiteCommand.matchAll(/test -n '\$([a-z_]+)'/g)].map((match) => shellNames.get(match[1]));
    expect(requiredInputs.length).toBeGreaterThan(0);
    expect(requiredInputs.every(Boolean)).toBe(true);

    for (const input of requiredInputs as string[]) {
      const f = await fixture();
      const env = { ...f.env };
      delete env[input];
      const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env });
      expect(run.exitCode).toBe(2);
      const report = await readFile(f.report, "utf8");
      expect(report).toContain(`blocker: required input ${input} is unset or empty; use meteorite/prove-candidate.sh --ref <40-character-commit-sha>`);
      expect(report).toContain("input-validation: NO-GO");
      expect(await Bun.file(f.trace).exists()).toBe(false);
    }
  });

  test("a malformed donor ref names the input and supported entry point before Docker starts", async () => {
    const f = await fixture();
    const env = { ...f.env, METEORITE_DONOR_REF: "refs/meteorite-candidates/bad/v2-deprecated" };
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env });
    expect(run.exitCode).toBe(2);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("blocker: METEORITE_DONOR_REF has an unsupported shape; use meteorite/prove-candidate.sh --ref <40-character-commit-sha>");
    expect(await Bun.file(f.trace).exists()).toBe(false);
  });

  test("a bare run fails closed instead of selecting origin/main", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", runner], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("ref-validation: NO-GO");
    expect(report).toContain("requested SHA: `UNMEASURED`");
    expect(report).not.toContain("result: clean");
    expect(await Bun.file(f.trace).exists()).toBe(false);
  });

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
    expect(report).toContain(`requested SHA: \`${f.sha}\``);
    expect(report).toContain("source: `https://example.invalid/infra.git`");
    expect(report).toContain("source mechanism: `tracked-remote`");
    expect(report).toContain("sha-verification: PASS");
    expect(report).toContain("container image: `ubuntu:24.04`");
    expect(report).toContain("container isolation: `Docker bridge network; no host mounts or published ports`");
    expect(report).toContain("pinned test environment: `FULL_SUITE_ON_CALENDAR=*-*-* 03:30:00; ORCH_WATCHDOG_INTERVAL=60`");
    expect(report).toContain("result: clean");
    expect(report).toContain("bootstrap-dry-run: PASS");
    expect(report).toContain("bootstrap-test-prerequisites: PASS");
    expect(report).toContain("bootstrap-verify-source: PASS");
    expect(report).toContain("test-prerequisites: PASS");
    expect(report).toContain("full-test-suite: PASS");
    expect(report).toContain("unit-drift: PASS");
    expect(report).toContain("unit activation —");
    expect(report).toContain("watchdog arm —");
    expect(report).toContain("Telegram transport —");
    expect(await readFile(f.trace, "utf8")).toContain("stop -t 5 container-id");
    expect(await readFile(f.trace, "utf8")).toContain("run -d --rm --network bridge --label io.bpa.meteorite.run=manual-");
  });

  test("pins the donor before bootstrap executes its embedded full suite", async () => {
    const source = await readFile(runner, "utf8");
    const donor = source.indexOf('"bootstrap-test-prerequisites|');
    const install = source.indexOf('"bootstrap-install|');
    expect(donor).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(donor);
    expect(source.slice(donor, install)).toContain("refs/heads/v2-deprecated");
    expect(source.slice(donor, install)).toContain("/usr/local/bin/bun");
  });

  test("a local source cannot yield a clean report", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "/tmp/local-candidate"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("source-validation: NO-GO");
    expect(report).toContain("source: `/tmp/local-candidate`");
    expect(report).not.toContain("result: clean");
    expect(await Bun.file(f.trace).exists()).toBe(false);
  });

  test("a checkout at a different SHA is NO-GO and names both SHAs", async () => {
    const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
    const f = await fixture("", otherSha);
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("sha-verification: NO-GO");
    expect(report).toContain(`checked-out SHA ${otherSha} differs from requested SHA ${f.sha}`);
    expect(report).not.toContain("bootstrap-dry-run: PASS");
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
