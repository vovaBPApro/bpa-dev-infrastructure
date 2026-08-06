import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const runner = process.env.METEORITE_TEST_RUNNER ?? resolve(import.meta.dir, "run.sh");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The evidence line meteorite/live-orchestrator-stage.sh emits from inside the
// container. The runner judges the orchestrator-live stage on THIS, never on the
// stage's exit status, so the fixture must be able to vary it independently of
// success — which is exactly what the red cases below do.
const LIVENESS_LINE =
  "METEORITE-LIVENESS proven=yes session=meteorite-orchestrator provider=claude" +
  " provider_pid=4242 pulse_interval=5 pulse_first=1786000000 pulse_last=1786000005" +
  " startup_handshake=yes torn_down=yes substitutions=provider" +
  " unproven=cgroup-isolation,provider-session,telegram-transport,watchdog-supervision\n";

async function fixture(failStage = "", checkedOutSha = "", livenessOutput = LIVENESS_LINE) {
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
    if [[ "$command" == *"live-orchestrator-stage.sh"* ]]; then printf '%s' "$LIVENESS_OUTPUT"; fi
    ;;
  stop|rm) ;;
  *) exit 91 ;;
esac
`);
  await chmod(docker, 0o755);
  const report = join(root, "report.md");
  const artifact = join(root, "result.json");
  const trace = join(root, "docker.trace");
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    METEORITE_REPORT: report,
    METEORITE_ARTIFACT: artifact,
    DOCKER_TRACE: trace,
    FAIL_STAGE: failStage,
    EXPECTED_SHA: checkedOutSha || sha,
    LIVENESS_OUTPUT: livenessOutput,
    METEORITE_DONOR_SHA: sha,
    METEORITE_DONOR_REF: `refs/meteorite-candidates/1700000000-123-${sha}/v2-deprecated`,
  };
  return { env, report, artifact, trace, sha };
}

async function readArtifact(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function verdictOf(result: { stages: { name: string; verdict: string }[] }, stage: string) {
  return result.stages.find((entry) => entry.name === stage)?.verdict;
}

describe("meteorite runner", () => {
  test("the default report stays outside the checkout and the run names its path", async () => {
    const root = await mkdtemp(join(tmpdir(), "meteorite-clean-tree-test-"));
    roots.push(root);
    const checkout = join(root, "checkout");
    const stateHome = join(root, "state");
    await Bun.$`mkdir -p ${join(checkout, "meteorite")}`;
    await cp(runner, join(checkout, "meteorite", "run.sh"));
    await Bun.$`git -C ${checkout} init -q`;
    await Bun.$`git -C ${checkout} add meteorite/run.sh`;
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
    expect(await readFile(f.trace, "utf8")).toContain("run -d --rm --network bridge ubuntu:24.04 sleep infinity");
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

// ── The orchestrator-live stage and the result artifact (V3-5.36) ──────────
//
// Cutover gate D: the meteorite must START the orchestrator and assert it
// reaches a live state, rather than assert that files copied. The stage's
// verdict is carried by the evidence line the container emits, so every case
// here varies that line rather than the stage's exit status — a stage that
// exits 0 having proven nothing is the precise failure being locked out.
describe("meteorite orchestrator-live stage", () => {
  test("the run starts the orchestrator and records its liveness evidence", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).toBe(0);
    const trace = await readFile(f.trace, "utf8");
    expect(trace).toContain("meteorite/live-orchestrator-stage.sh");
    // The stage runs against the installed tree and the state database bootstrap
    // created: the launcher's lease/reap branch is guarded by that file existing,
    // and skipping it would prove the one configuration a real host never runs in.
    expect(trace).toContain("METEORITE_LIVE_INSTALL_ROOT=/work/install");
    expect(trace).toContain("METEORITE_LIVE_STATE_DB=/work/runtime/state.db");
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("orchestrator-live: PASS");
    expect(report).toContain("orchestrator liveness boundary —");
  });

  test("a stage list without the start stage fails closed instead of reporting clean", async () => {
    const root = await mkdtemp(join(tmpdir(), "meteorite-no-live-stage-"));
    roots.push(root);
    const stripped = join(root, "run.sh");
    const source = await readFile(runner, "utf8");
    const withoutStage = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith('"orchestrator-live|'))
      .join("\n");
    expect(withoutStage).not.toBe(source);
    await writeFile(stripped, withoutStage);

    const f = await fixture();
    const run = Bun.spawnSync(["bash", stripped, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("stage-contract: NO-GO");
    expect(report).toContain("blocker: required stage(s) not executed: orchestrator-live");
    expect(report).not.toContain("result: clean");
    const result = await readArtifact(f.artifact);
    expect(result.finished).toBe(false);
    expect(result.liveness.proven).toBe(false);
  });

  test("a liveness assertion that produces no evidence fails the stage", async () => {
    const f = await fixture("", "", "");
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("orchestrator-live: NO-GO");
    expect(report).toContain("exactly one is required");
    const result = await readArtifact(f.artifact);
    expect(result.liveness).toEqual({ proven: false, reason: "evidence-line-count-0" });
    expect(verdictOf(result, "orchestrator-live")).toBe("NO-GO");
  });

  test("an unproven liveness verdict is refused and carries its reason", async () => {
    const f = await fixture("", "", "METEORITE-LIVENESS proven=no reason=liveness-stamp-not-advancing\n");
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("blocker: the orchestrator did not reach a live state: liveness-stamp-not-advancing");
    const result = await readArtifact(f.artifact);
    expect(result.liveness).toEqual({ proven: false, reason: "liveness-stamp-not-advancing" });
  });

  test("a launcher mechanism replaced by a stand-in cannot produce a clean rebuild", async () => {
    // The provider binary is the one substitution a credential-free container
    // forces. Anything beyond it means the launcher's own fail-closed wiring was
    // stubbed, and a rebuild proof that accepted that would be proving the
    // fixture rather than the repository.
    const f = await fixture("", "", LIVENESS_LINE.replace("substitutions=provider", "substitutions=provider,auth-preflight,mission-cli"));
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("substituted launcher mechanisms: substitutions=provider,auth-preflight,mission-cli");
    const result = await readArtifact(f.artifact);
    expect(result.liveness).toEqual({ proven: false, reason: "unexpected-substitutions" });
  });
});

describe("meteorite result artifact", () => {
  test("a green run writes a finished artifact with every stage verdict and the liveness summary", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toContain(`[meteorite] artifact: ${f.artifact}`);
    const result = await readArtifact(f.artifact);
    expect(result.schema).toBe("meteorite-result/v1");
    expect(result.finished).toBe(true);
    expect(result.result).toBe("clean");
    expect(result.blocker).toBe("none");
    expect(result.tree_sha).toBe(f.sha);
    expect(result.requested_sha).toBe(f.sha);
    expect(result.finished_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    for (const stage of [
      "container-start", "prerequisites", "clone", "sha-verification",
      "bootstrap-test-prerequisites", "bootstrap-dry-run", "bootstrap-install",
      "bootstrap-verify-source", "test-prerequisites", "full-test-suite",
      "unit-drift", "orchestrator-live",
    ]) {
      expect(verdictOf(result, stage), `${stage} verdict`).toBe("PASS");
    }
    expect(result.liveness.proven).toBe(true);
    expect(result.liveness.session).toBe("meteorite-orchestrator");
    expect(result.liveness.provider).toBe("claude");
    expect(result.liveness.substitutions).toBe("provider");
    expect(result.liveness.pulse_first).toBe("1786000000");
    expect(result.liveness.pulse_last).toBe("1786000005");
    expect(result.liveness.torn_down).toBe("yes");
    // The boundaries the container cannot cross travel WITH the proof. A reader
    // that only sees `proven: true` would otherwise read a stand-in provider as
    // a live orchestrator session.
    expect(result.liveness.unproven).toContain("provider-session");
    expect(result.liveness.unproven).toContain("cgroup-isolation");
  });

  test("a killed run writes finished:false, the failing stage, and no later stages", async () => {
    const f = await fixture("bun test");
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const result = await readArtifact(f.artifact);
    expect(result.finished).toBe(false);
    expect(result.result).toBe("NO-GO");
    expect(result.blocker).toBe("full-test-suite command failed");
    expect(verdictOf(result, "full-test-suite")).toBe("NO-GO");
    expect(verdictOf(result, "bootstrap-install")).toBe("PASS");
    expect(verdictOf(result, "unit-drift")).toBeUndefined();
    expect(verdictOf(result, "orchestrator-live")).toBeUndefined();
    expect(result.liveness).toEqual({ proven: false, reason: "stage-not-reached" });
  });

  test("a refusal before Docker still writes a parseable artifact", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", runner], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const result = await readArtifact(f.artifact);
    expect(result.finished).toBe(false);
    expect(result.result).toBe("NO-GO");
    expect(result.tree_sha).toBe("UNMEASURED");
    expect(result.requested_sha).toBe("UNMEASURED");
    expect(verdictOf(result, "ref-validation")).toBe("NO-GO");
  });

  test("the default artifact path is the evidence area beside the report, outside any checkout", async () => {
    const source = await readFile(runner, "utf8");
    expect(source).toContain("bpa-dev-infrastructure/evidence/meteorite-latest.json");
    const root = await mkdtemp(join(tmpdir(), "meteorite-artifact-home-"));
    roots.push(root);
    const f = await fixture();
    const env = { ...f.env, XDG_STATE_HOME: root };
    delete env.METEORITE_ARTIFACT;
    const run = Bun.spawnSync(["bash", runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env });
    expect(run.exitCode).toBe(0);
    const artifact = join(root, "bpa-dev-infrastructure", "evidence", "meteorite-latest.json");
    expect((await readArtifact(artifact)).result).toBe("clean");
  });
});
