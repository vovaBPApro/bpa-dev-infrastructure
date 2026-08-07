import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const runner = process.env.METEORITE_TEST_RUNNER ?? resolve(import.meta.dir, "run.sh");
const roots: string[] = [];

async function git(...args: string[]) {
  const run = Bun.spawnSync(["git", ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

// Every ref the given origin carries, as a ref -> target map. The runner's proof
// anchor is asked of the remote exactly the way a reader asks for it.
async function remoteRefs(origin: string) {
  const out = await git("ls-remote", "--refs", origin);
  const refs = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t");
    refs.set(ref, sha);
  }
  return refs;
}

async function digestOf(path: string) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function anchorNames(treeSha: string, digest: string) {
  return {
    proof: `refs/bpa-meteorite-proofs/${treeSha}/${digest}`,
    mirror: `refs/bpa-meteorite-proof-mirrors/${treeSha}/${digest}`,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The evidence line meteorite/live-orchestrator-stage.sh emits from inside the
// container. The runner judges the orchestrator-live stage on THIS, never on the
// stage's exit status, so the fixture must be able to vary it independently of
// success — which is exactly what the red cases below do.
const LIVENESS_LINE =
  "METEORITE-LIVENESS proven=yes liveness_boundary=full session=meteorite-orchestrator provider=claude" +
  " credential_world=present provider_pid=4242 pulse_interval=5 pulse_first=1786000000 pulse_last=1786000005" +
  " startup_handshake=yes torn_down=yes substitutions=provider" +
  " unproven=cgroup-isolation,provider-session,telegram-transport,watchdog-supervision\n";

// The other boundary, and the one a rebuilt host actually reaches: no
// subscription credential store exists in a credential-free container and none
// can, so the launch path is proven up to and including the auth gate and stops
// there. The runner must accept this as a PASS and must carry WHICH boundary
// applied into the artifact, because the reader of that artifact — not the
// runner — is the thing entitled to decide whether this boundary is enough.
const AUTH_BOUNDARY_LINE =
  "METEORITE-LIVENESS proven=yes liveness_boundary=auth-preflight-refusal" +
  " session=meteorite-orchestrator provider=claude credential_world=absent" +
  " refused_at=auth-preflight refusal_class=subscription-store-missing" +
  " startup_handshake=no torn_down=not-started substitutions=provider" +
  " unproven=cgroup-isolation,provider-session,telegram-transport,watchdog-supervision," +
  "launch-start,startup-handshake,provider-supervision,liveness-pulse,teardown\n";

// The fixture is a REAL repository with a REAL (local, bare) origin, because a
// run now ends by publishing its proof anchor there. A fixture without one would
// either reach the network or exercise a path no real run takes; a local bare
// remote is how gate/land.test.sh proves the same class of ref publication.
// `params` is the tracked instance/params.yaml body, so a test can vary the one
// home the publish destination is read from.
async function fixture(failStage = "", checkedOutSha = "", livenessOutput = LIVENESS_LINE, params?: (origin: string) => string) {
  const root = await mkdtemp(join(tmpdir(), "meteorite-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  await Bun.$`mkdir -p ${bin}`;
  const origin = join(root, "origin.git");
  await git("init", "-q", "--bare", origin);
  const checkout = join(root, "checkout");
  await Bun.$`mkdir -p ${join(checkout, "meteorite")} ${join(checkout, "instance")}`;
  await cp(runner, join(checkout, "meteorite", "run.sh"));
  await writeFile(
    join(checkout, "instance", "params.yaml"),
    params ? params(origin) : `repos:\n  git_remote: ${origin}   # pinned origin\n`,
  );
  await git("-C", checkout, "init", "-q");
  await git("-C", checkout, "add", "-A");
  await git("-C", checkout, "commit", "-qm", "baseline");
  const localRunner = join(checkout, "meteorite", "run.sh");
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
  const sha = await git("-C", checkout, "rev-parse", "HEAD");
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
  return { env, report, artifact, trace, sha, origin, checkout, runner: localRunner };
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
    const stateHome = join(root, "state");

    const f = await fixture();
    const env = { ...f.env, XDG_STATE_HOME: stateHome };
    delete env.METEORITE_REPORT;
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env });
    expect(run.exitCode).toBe(0);
    const report = join(stateHome, "bpa-dev-infrastructure", "evidence", "meteorite-latest.md");
    expect(await Bun.file(report).exists()).toBe(true);
    expect(run.stdout.toString()).toContain(`[meteorite] report: ${report}`);
    // Neither the report nor the proof anchor may leave anything behind in the
    // checkout: an artifact in the tree makes the next landing refuse a dirty
    // worktree, and publishing a ref must not be an exception to that.
    expect(Bun.spawnSync(["git", "-C", f.checkout, "status", "--porcelain"]).stdout.toString()).toBe("");
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
      const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env });
    expect(run.exitCode).toBe(2);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("blocker: METEORITE_DONOR_REF has an unsupported shape; use meteorite/prove-candidate.sh --ref <40-character-commit-sha>");
    expect(await Bun.file(f.trace).exists()).toBe(false);
  });

  test("a bare run fails closed instead of selecting origin/main", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", f.runner], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref"], { env: f.env });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("--ref requires a value");
    expect(await Bun.file(f.trace).exists()).toBe(false);
  });

  test("records the selected ref, report shape, stages, and named unproven boundaries", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "/tmp/local-candidate"], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("sha-verification: NO-GO");
    expect(report).toContain(`checked-out SHA ${otherSha} differs from requested SHA ${f.sha}`);
    expect(report).not.toContain("bootstrap-dry-run: PASS");
  });

  test("a failed stage exits non-zero, reports NO-GO and names its blocker", async () => {
    const f = await fixture("bun test");
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
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
    const f = await fixture();
    // Written INSIDE the fixture checkout so the mutant resolves the same
    // repository root, and therefore the same tracked origin pin, as the runner
    // it is a mutation of.
    const stripped = join(f.checkout, "meteorite", "run-without-live-stage.sh");
    const source = await readFile(runner, "utf8");
    const withoutStage = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith('"orchestrator-live|'))
      .join("\n");
    expect(withoutStage).not.toBe(source);
    await writeFile(stripped, withoutStage);

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

  // The same lock for the stage this branch met on main rather than wrote. The
  // contract array gained `whisper` when V3-5.40's stage was rebased under it,
  // and a contract line nobody has ever seen refuse is not a contract line —
  // it is a comment that happens to be inside an array.
  test("a stage list without the whisper stage fails closed instead of reporting clean", async () => {
    const f = await fixture();
    const stripped = join(f.checkout, "meteorite", "run-without-whisper-stage.sh");
    const source = await readFile(runner, "utf8");
    const withoutStage = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith('"whisper|'))
      .join("\n");
    expect(withoutStage).not.toBe(source);
    await writeFile(stripped, withoutStage);

    const run = Bun.spawnSync(["bash", stripped, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("stage-contract: NO-GO");
    expect(report).toContain("blocker: required stage(s) not executed: whisper");
    expect(report).not.toContain("result: clean");
    const result = await readArtifact(f.artifact);
    expect(result.finished).toBe(false);
  });

  test("a liveness assertion that produces no evidence fails the stage", async () => {
    const f = await fixture("", "", "");
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("blocker: the orchestrator did not reach a live state: liveness-stamp-not-advancing");
    const result = await readArtifact(f.artifact);
    expect(result.liveness).toEqual({ proven: false, reason: "liveness-stamp-not-advancing" });
  });

  // ── The credential boundary, at the runner ───────────────────────────────
  //
  // A rebuilt host has no subscription credential store and structurally cannot
  // have one, so the launch path stops at the auth gate there. The stage may
  // declare that as its boundary; the runner's job is to accept it as a PASS,
  // to refuse a PASS that declares no boundary at all, and to refuse a boundary
  // it does not know — a stage that could mint its own boundary token could
  // green any rebuild by inventing a shallow enough one.
  test("a rebuild that proves the launch path up to its auth gate is a pass, and says which boundary it stopped at", async () => {
    const f = await fixture("", "", AUTH_BOUNDARY_LINE);
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: clean");
    expect(report).toContain("orchestrator-live: PASS");
    const result = await readArtifact(f.artifact);
    expect(result.result).toBe("clean");
    expect(result.finished).toBe(true);
    expect(result.liveness.proven).toBe(true);
    // The whole point of the field: a reader can tell this apart from a run
    // that started an orchestrator, without parsing prose.
    expect(result.liveness.liveness_boundary).toBe("auth-preflight-refusal");
    expect(result.liveness.credential_world).toBe("absent");
    expect(result.liveness.refusal_class).toBe("subscription-store-missing");
    expect(result.liveness.unproven).toContain("launch-start");
    expect(result.liveness.unproven).toContain("teardown");
  });

  test("a pass that declares no boundary is refused, because how much was proven would be unstated", async () => {
    const f = await fixture("", "", LIVENESS_LINE.replace("liveness_boundary=full ", ""));
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("declaring a liveness_boundary");
    const result = await readArtifact(f.artifact);
    expect(result.liveness).toEqual({ proven: false, reason: "liveness-boundary-undeclared" });
  });

  test("a stage cannot mint its own boundary: an unknown one is refused by name", async () => {
    const f = await fixture("", "", LIVENESS_LINE.replace("liveness_boundary=full", "liveness_boundary=good-enough"));
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("unknown liveness boundary: good-enough");
    const result = await readArtifact(f.artifact);
    expect(result.liveness).toEqual({ proven: false, reason: "unknown-liveness-boundary" });
  });

  // The contract compared in the other direction. The locks above catch a stage
  // deleted from `commands`; nothing caught a stage that was never added to
  // `required_stages`, and that is precisely a stage whose later deletion would
  // still report `clean`. `whisper` arrived exactly that way.
  test("a stage executed but absent from the contract fails closed, before any stage runs", async () => {
    const f = await fixture();
    const mutant = join(f.checkout, "meteorite", "run-with-uncontracted-stage.sh");
    const source = await readFile(runner, "utf8");
    const withExtra = source.replace(
      '  "prerequisites|',
      '  "newly-added-stage|true"\n  "prerequisites|',
    );
    expect(withExtra).not.toBe(source);
    await writeFile(mutant, withExtra);

    const run = Bun.spawnSync(["bash", mutant, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const report = await readFile(f.report, "utf8");
    expect(report).toContain("result: NO-GO");
    expect(report).toContain("blocker: stage(s) executed but absent from required_stages: newly-added-stage");
    expect(report).not.toContain("result: clean");
    // Refused on the file's own shape, so nothing was executed for it: the run
    // must not have spent fifteen container-minutes to report a typo.
    const trace = await readFile(f.trace, "utf8");
    expect(trace).not.toContain("newly-added-stage");
  });

  test("a launcher mechanism replaced by a stand-in cannot produce a clean rebuild", async () => {
    // The provider binary is the one substitution a credential-free container
    // forces. Anything beyond it means the launcher's own fail-closed wiring was
    // stubbed, and a rebuild proof that accepted that would be proving the
    // fixture rather than the repository.
    const f = await fixture("", "", LIVENESS_LINE.replace("substitutions=provider", "substitutions=provider,auth-preflight,mission-cli"));
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner], { env: f.env });
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
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env });
    expect(run.exitCode).toBe(0);
    const artifact = join(root, "bpa-dev-infrastructure", "evidence", "meteorite-latest.json");
    expect((await readArtifact(artifact)).result).toBe("clean");
  });
});

// ── The proof anchor (V3-5.36) ─────────────────────────────────────────────
//
// The artifact is a file on a host, and anyone who can write that path can write
// a green verdict into it — which is exactly the forge the readiness command's
// review round produced with one `printf`. The anchor is what makes the artifact
// evidence: a digest published to the tracked origin, under a ref NAME that is
// the digest and a ref TARGET that is the proven commit. These locks are all
// fixture-level: a local bare repository stands in for origin, the way
// gate/land.test.sh proves its own attempt refs, so nothing here reaches a
// network.
describe("meteorite proof anchor", () => {
  test("a run publishes both anchor refs, named by the artifact digest and targeting the proven tree", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).toBe(0);

    const anchors = anchorNames(f.sha, await digestOf(f.artifact));
    const refs = await remoteRefs(f.origin);
    // Both namespaces, so a record forged or suppressed on one side is visible.
    expect(refs.get(anchors.proof)).toBe(f.sha);
    expect(refs.get(anchors.mirror)).toBe(f.sha);
    // The run names the anchor it published, so the next reader re-derives the
    // verdict with `git ls-remote` instead of trusting this host.
    expect(run.stdout.toString()).toContain(`[meteorite] proof anchor: ${anchors.proof} -> ${f.sha}`);
    expect(run.stdout.toString()).toContain(`[meteorite] proof mirror: ${anchors.mirror}`);
  });

  test("the anchor names the artifact's exact bytes: a mutated artifact matches nothing on origin", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).toBe(0);
    const published = anchorNames(f.sha, await digestOf(f.artifact));

    // The forge: rewrite the verdict in place on this host, exactly as anyone
    // with write access to the evidence directory can.
    const forged = (await readFile(f.artifact, "utf8")).replace('"blocker": "none"', '"blocker": "none "');
    await writeFile(f.artifact, forged);
    const mutated = anchorNames(f.sha, await digestOf(f.artifact));
    expect(mutated.proof).not.toBe(published.proof);

    const refs = await remoteRefs(f.origin);
    expect(refs.has(mutated.proof)).toBe(false);
    expect(refs.has(mutated.mirror)).toBe(false);
    // And the anchor that does exist still names the bytes it was published for,
    // so it cannot be read as vouching for the mutated file.
    expect(refs.get(published.proof)).toBe(f.sha);
  });

  test("the anchor targets the commit the run measured, not the checkout's current HEAD", async () => {
    const f = await fixture();
    // The host moves on while the proof is in flight — a lane commits, a rebase
    // lands. The anchor must still name the tree the container actually proved,
    // or it vouches for code that was never rebuilt.
    await writeFile(join(f.checkout, "unrelated.txt"), "work that happened afterwards\n");
    await git("-C", f.checkout, "add", "-A");
    await git("-C", f.checkout, "commit", "-qm", "later work");
    const head = await git("-C", f.checkout, "rev-parse", "HEAD");
    expect(head).not.toBe(f.sha);

    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).toBe(0);
    const anchors = anchorNames(f.sha, await digestOf(f.artifact));
    const refs = await remoteRefs(f.origin);
    expect(refs.get(anchors.proof)).toBe(f.sha);
    expect(refs.get(anchors.mirror)).toBe(f.sha);
    expect([...refs.values()]).not.toContain(head);
  });

  test("a failed run anchors its artifact too, because a failed rebuild is evidence", async () => {
    const f = await fixture("bun test");
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    const result = await readArtifact(f.artifact);
    expect(result.result).toBe("NO-GO");

    const anchors = anchorNames(f.sha, await digestOf(f.artifact));
    const refs = await remoteRefs(f.origin);
    expect(refs.get(anchors.proof)).toBe(f.sha);
    expect(refs.get(anchors.mirror)).toBe(f.sha);
  });

  test("a run whose anchor cannot be published exits non-zero even though every stage passed", async () => {
    const f = await fixture();
    // Origin is gone at publication time. Every stage still passes and the
    // artifact still says `clean` — the ONLY thing wrong is that the proof was
    // never published, and that alone must decide the exit status.
    await rm(f.origin, { recursive: true, force: true });
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    expect((await readArtifact(f.artifact)).result).toBe("clean");
    expect(run.stderr.toString()).toContain("proof anchor NOT published");
    expect(run.stderr.toString()).toContain("is unanchored and is not evidence");
  });

  test("the anchor goes to the tracked pin, not to whatever remote this host configured", async () => {
    const f = await fixture();
    const decoy = join(f.checkout, "..", "decoy.git");
    await git("init", "-q", "--bare", decoy);
    await git("-C", f.checkout, "remote", "add", "origin", decoy);
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).toBe(0);

    const anchors = anchorNames(f.sha, await digestOf(f.artifact));
    expect((await remoteRefs(f.origin)).get(anchors.proof)).toBe(f.sha);
    // A host-local config edit cannot redirect the proof: the destination is
    // read from tracked content in the tree the run measured.
    expect((await remoteRefs(decoy)).size).toBe(0);
  });

  test("a proven tree that tracks no origin pin cannot anchor, and the run says so", async () => {
    const f = await fixture("", "", LIVENESS_LINE, () => "repos:\n  # no git_remote pin\n");
    const run = Bun.spawnSync(["bash", f.runner, "--ref", f.sha, "--repo-url", "https://example.invalid/infra.git"], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("tracks no repos.git_remote pin");
    expect((await remoteRefs(f.origin)).size).toBe(0);
  });

  test("a run that measured no tree publishes nothing and refuses to call the artifact evidence", async () => {
    const f = await fixture();
    const run = Bun.spawnSync(["bash", f.runner], { env: f.env });
    expect(run.exitCode).not.toBe(0);
    expect((await readArtifact(f.artifact)).tree_sha).toBe("UNMEASURED");
    expect(run.stderr.toString()).toContain("no measured tree (tree_sha=UNMEASURED)");
    expect((await remoteRefs(f.origin)).size).toBe(0);
  });
});
