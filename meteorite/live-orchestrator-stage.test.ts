// Locks for the meteorite's orchestrator-live stage (V3-5.36).
//
// The stage's job is to make "the repository rebuilds this host" mean the
// orchestrator STARTS, not that the files copied. Two levels are covered here:
//
//   1. The assertion itself, driven against fabricated runtime directories. It
//      must read durable evidence and refuse every shape of absence — a stamp
//      that exists but never advances is the one that matters, because that is
//      exactly what a launcher that seeded a file over a dead pane leaves.
//   2. A live rehearsal of the whole stage against the real orchestrator/launch.sh
//      on a private tmux socket. Without it, the stage's only exercise would be
//      an expensive container run, and a failure there could not be told apart
//      from a failure of the repository the run is judging.
//
// The rehearsal declares its substitutions rather than hiding them, and asserts
// the stage REPORTS them: meteorite/run.sh refuses any evidence line whose
// substitution set is larger than `provider`, so this rehearsal is by
// construction incapable of producing a green rebuild proof.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = resolve(import.meta.dir, "..");
const stage = join(repoRoot, "meteorite", "live-orchestrator-stage.sh");
const roots: string[] = [];
const sessions: { socket: string; name: string }[] = [];

afterEach(async () => {
  for (const { socket } of sessions.splice(0)) {
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"], { stderr: "ignore", stdout: "ignore" });
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function assertLiveness(dir: string, interval: number, deadline: number) {
  return Bun.spawnSync(["bash", stage, "--assert-liveness", dir, String(interval), String(deadline)]);
}

/** A runtime directory holding exactly what a completed launch leaves behind. */
async function liveRuntimeDir(pid: number, stampAt = Math.floor(Date.now() / 1000)) {
  const dir = await scratch("live-stage-runtime-");
  await writeFile(join(dir, "orchestrator.startup"), "export ORCH_FENCING_TOKEN=1\n");
  await writeFile(join(dir, "orchestrator.liveness.identity"), `pid=${pid}\nstarttime=1\n`);
  await writeFile(join(dir, "orchestrator.liveness"), `${stampAt}\n`);
  return dir;
}

function holdOpen() {
  const proc = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
  return proc;
}

describe("live-orchestrator liveness assertion", () => {
  test("an advancing stamp over a live provider is the proof of life", async () => {
    const proc = holdOpen();
    try {
      const dir = await liveRuntimeDir(proc.pid, 1_700_000_000);
      // The renewal the pulse loop performs, simulated. It has to run in another
      // PROCESS, not a timer: the assertion below is synchronous and would block
      // this loop until well past any timer that was meant to unblock it.
      const renewer = Bun.spawn([
        "bash", "-c", `sleep 1.5; printf '1700000005\\n' > ${JSON.stringify(join(dir, "orchestrator.liveness"))}`,
      ], { stdout: "ignore", stderr: "ignore" });
      const run = assertLiveness(dir, 5, 15);
      renewer.kill();
      expect(run.stdout.toString()).toContain("LIVENESS-ASSERT ok");
      expect(run.stdout.toString()).toContain(`pid=${proc.pid}`);
      expect(run.stdout.toString()).toContain("last=1700000005");
      expect(run.exitCode).toBe(0);
    } finally {
      proc.kill();
    }
  });

  test("a stamp that never advances fails, even though the file exists", async () => {
    // launch.sh SEEDS this file before returning. A checker that only tested for
    // its existence would call a launcher-over-a-corpse alive, which is the
    // failure the whole stage exists to detect.
    const proc = holdOpen();
    try {
      const dir = await liveRuntimeDir(proc.pid);
      const run = assertLiveness(dir, 5, 3);
      expect(run.exitCode).toBe(1);
      expect(run.stdout.toString().trim()).toBe("LIVENESS-ASSERT fail reason=liveness-stamp-not-advancing");
    } finally {
      proc.kill();
    }
  });

  test("each missing piece of evidence fails with its own named reason", async () => {
    const proc = holdOpen();
    try {
      const cases: [string, string][] = [
        ["orchestrator.startup", "startup-handshake-missing"],
        ["orchestrator.liveness.identity", "provider-identity-missing"],
        ["orchestrator.liveness", "liveness-stamp-missing"],
      ];
      for (const [file, reason] of cases) {
        const dir = await liveRuntimeDir(proc.pid);
        await rm(join(dir, file));
        const run = assertLiveness(dir, 5, 3);
        expect(run.exitCode, reason).toBe(1);
        expect(run.stdout.toString().trim()).toBe(`LIVENESS-ASSERT fail reason=${reason}`);
      }
    } finally {
      proc.kill();
    }
  });

  test("a recorded provider that is not running fails", async () => {
    // 4194304 is above the default pid_max, so it can never be live and the case
    // cannot flake on pid reuse.
    const dir = await liveRuntimeDir(4194304);
    const run = assertLiveness(dir, 5, 3);
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString().trim()).toBe("LIVENESS-ASSERT fail reason=provider-not-running");
  });

  test("a malformed identity record is refused rather than read past", async () => {
    const dir = await liveRuntimeDir(1);
    await writeFile(join(dir, "orchestrator.liveness.identity"), "pid=\nstarttime=\n");
    const run = assertLiveness(dir, 5, 3);
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString().trim()).toBe("LIVENESS-ASSERT fail reason=provider-identity-malformed");
  });
});

describe("live-orchestrator stage refusals", () => {
  test("a missing state database refuses before anything is started", async () => {
    // The launcher's lease/reap branch is guarded by this file existing, and that
    // branch is where the 2026-08-04 unstartable-launcher regression lived —
    // armed, as the incident put it, by ordinary successful work creating the
    // database. Proving the no-database configuration would prove the one shape a
    // working host never runs in.
    const root = await scratch("live-stage-no-db-");
    await mkdir(join(root, "install", "orchestrator"), { recursive: true });
    await writeFile(join(root, "install", "orchestrator", "launch.sh"), "#!/usr/bin/env bash\nexit 0\n");
    const run = Bun.spawnSync(["bash", stage], {
      env: {
        ...process.env,
        METEORITE_LIVE_INSTALL_ROOT: join(root, "install"),
        METEORITE_LIVE_STATE_DB: join(root, "absent.db"),
        METEORITE_LIVE_RUNTIME_DIR: join(root, "runtime"),
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain("METEORITE-LIVENESS proven=no reason=state-db-missing");
  });

  test("a missing launcher refuses and names itself", async () => {
    const root = await scratch("live-stage-no-launcher-");
    const run = Bun.spawnSync(["bash", stage], {
      env: {
        ...process.env,
        METEORITE_LIVE_INSTALL_ROOT: join(root, "install"),
        METEORITE_LIVE_STATE_DB: join(root, "absent.db"),
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain("METEORITE-LIVENESS proven=no reason=launcher-missing");
  });

  test("a refusing launcher has its own error token carried into the reason", async () => {
    // Measured on 2026-08-06: inside a container the launcher refuses with
    // `ERROR orchestrator-singleton-owner-unverified`, because /proc/locks is
    // namespace-filtered and its singleton-owner check cannot observe the lock it
    // just took. A bare `launch-refused` in the artifact sends the next reader to
    // a container log by hand, so the launcher's own token travels with it.
    const root = await scratch("live-stage-refusal-token-");
    await mkdir(join(root, "install", "orchestrator"), { recursive: true });
    await writeFile(
      join(root, "install", "orchestrator", "launch.sh"),
      "#!/usr/bin/env bash\nprintf 'ERROR orchestrator-singleton-owner-unverified provider_pid=1 kernel_owner=unknown\\n' >&2\nexit 1\n",
    );
    await writeFile(join(root, "state.db"), "");
    const run = Bun.spawnSync(["bash", stage], {
      env: {
        ...process.env,
        METEORITE_LIVE_INSTALL_ROOT: join(root, "install"),
        METEORITE_LIVE_STATE_DB: join(root, "state.db"),
        METEORITE_LIVE_RUNTIME_DIR: join(root, "runtime"),
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(
      "METEORITE-LIVENESS proven=no reason=launch-refused:orchestrator-singleton-owner-unverified",
    );
  });

  test("a launcher refusal with no error token is still named, not left bare", async () => {
    // This is the refusal a rebuilt host actually hits first today:
    // orchestrator/preflight-cli-auth.sh is absent from the repository, and
    // launch.sh says so in bare prose with no ERROR token to harvest. The path is
    // deliberately dropped at the first colon so the token stays a token.
    const root = await scratch("live-stage-bare-refusal-");
    await mkdir(join(root, "install", "orchestrator"), { recursive: true });
    await writeFile(
      join(root, "install", "orchestrator", "launch.sh"),
      "#!/usr/bin/env bash\nprintf 'auth preflight missing or not executable: /work/install/orchestrator/preflight-cli-auth.sh\\n' >&2\nexit 2\n",
    );
    await writeFile(join(root, "state.db"), "");
    const run = Bun.spawnSync(["bash", stage], {
      env: {
        ...process.env,
        METEORITE_LIVE_INSTALL_ROOT: join(root, "install"),
        METEORITE_LIVE_STATE_DB: join(root, "state.db"),
        METEORITE_LIVE_RUNTIME_DIR: join(root, "runtime"),
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(
      "METEORITE-LIVENESS proven=no reason=launch-refused:auth-preflight-missing-or-not-executable",
    );
  });

  test("an unknown argument is refused rather than treated as the default run", () => {
    const run = Bun.spawnSync(["bash", stage, "--start-everything"]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("unknown argument");
  });
});

// ── The credential boundary ────────────────────────────────────────────────
//
// A rebuilt host has no subscription credential store and cannot have one: the
// store is written by a human answering /login, so Hard Floor 5 deliberately
// keeps it out of git. The launch path therefore refuses at the auth gate on
// every rebuilt host, forever. The stage's answer is to define its pass
// boundary honestly per world and to say which boundary applied — and both
// halves need locking in both directions, because a boundary that can be
// claimed in the wrong world is just a way of greening a broken launcher.
//
// Every case below drives the REAL orchestrator/preflight-cli-auth.sh, at the
// path the stage resolves by default, so the refusal contract under test is the
// tracked one rather than a retelling of it. What varies is the launcher.

/** The banned-and-guarded environment, removed so a case measures its fixture. */
function cleanEnv(extra: Record<string, string>) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const name of Object.keys(env)) {
    // Guarded knobs would be reported as substitutions and change the evidence
    // line; a banned key would make the preflight refuse for the wrong reason
    // and put the world in `indeterminate` on a host that happens to export one.
    if (name.startsWith("ORCH_") || name.startsWith("ANTHROPIC_") || name.startsWith("OPENAI_") ||
        name.startsWith("GEMINI_") || name.startsWith("GOOGLE_") || name.startsWith("AWS_") ||
        name.startsWith("CLAUDE_CODE_") || name.startsWith("TELEGRAM_")) {
      delete env[name];
    }
  }
  return { ...env, ...extra };
}

/**
 * An install root carrying the TRACKED auth preflight at its default path plus
 * a fixture launcher whose body the case supplies.
 */
async function boundaryFixture(launcher: string) {
  const root = await scratch("live-stage-boundary-");
  const install = join(root, "install");
  await mkdir(join(install, "orchestrator"), { recursive: true });
  await copyFile(
    join(repoRoot, "orchestrator", "preflight-cli-auth.sh"),
    join(install, "orchestrator", "preflight-cli-auth.sh"),
  );
  await chmod(join(install, "orchestrator", "preflight-cli-auth.sh"), 0o755);
  await writeFile(join(install, "orchestrator", "launch.sh"), launcher);
  await writeFile(join(root, "state.db"), "");
  return { root, install };
}

/** A launcher that consults the tracked gate in launch.sh's own order. */
const LAUNCHER_THAT_REACHES_THE_GATE = `#!/usr/bin/env bash
# Fixture launcher. Reproduces the ORDER launch.sh uses: everything that must
# happen before the auth gate, then the gate, then (never, when it refuses) a
# session. Only the gate is real, and that is the mechanism under test here.
set -u
printf 'REAP leases-reaped=0 leases-live=0 leases-expired=0\\n'
"$(dirname "$0")/preflight-cli-auth.sh" "\${ORCH_PROVIDER:-claude}" || exit 2
printf 'fixture launcher: started a session\\n'
exit 0
`;

/** A credential store the tracked gate accepts. Contains no secret. */
const SUBSCRIPTION_FIXTURE = JSON.stringify({
  claudeAiOauth: {
    accessToken: "fixture-not-a-secret",
    expiresAt: 4102444800000,
    refreshToken: "fixture-not-a-secret",
    refreshTokenExpiresAt: 4102444800000,
  },
});

function runStage(install: string, root: string, extra: Record<string, string> = {}) {
  return Bun.spawnSync(["bash", stage], {
    env: cleanEnv({
      METEORITE_LIVE_INSTALL_ROOT: install,
      METEORITE_LIVE_STATE_DB: join(root, "state.db"),
      METEORITE_LIVE_RUNTIME_DIR: join(root, "runtime"),
      METEORITE_LIVE_SESSION: "meteorite-boundary-fixture",
      ...extra,
    }),
    stderr: "pipe",
  });
}

function evidenceOf(run: { stdout: Buffer }) {
  return run.stdout.toString().split("\n").find((line) => line.startsWith("METEORITE-LIVENESS "));
}

describe("live-orchestrator credential boundary — a world with NO credentials", () => {
  test("the launch path proven up to and including its auth gate is a PASS, and names the boundary", async () => {
    // The measured shape of a real rebuild: singleton, reap and lease all ran —
    // launch.sh reaches its auth gate only through them — and the gate then
    // refused for the one reason a rebuilt host always refuses for.
    const f = await boundaryFixture(LAUNCHER_THAT_REACHES_THE_GATE);
    const run = runStage(f.install, f.root, {
      ORCH_CLAUDE_CRED_FILE: join(f.root, "no-such-credentials.json"),
    });
    const evidence = evidenceOf(run);
    expect(evidence, `no evidence line\nstderr:\n${run.stderr.toString()}`).toBeDefined();
    expect(evidence).toContain("proven=yes");
    expect(evidence).toContain("liveness_boundary=auth-preflight-refusal");
    expect(evidence).toContain("credential_world=absent");
    expect(evidence).toContain("refusal_class=subscription-store-missing");
    // The boundary is a PASS, not a green light: everything past the gate is
    // declared unproven on the same line that claims the pass.
    expect(evidence).toContain("unproven=");
    for (const boundary of ["launch-start", "startup-handshake", "liveness-pulse", "teardown"]) {
      expect(evidence).toContain(boundary);
    }
    // meteorite/run.sh refuses any substitution set larger than `provider`, so
    // this must be a line a real rebuild proof could carry.
    expect(evidence).toContain("substitutions=provider ");
    expect(run.exitCode).toBe(0);
  });

  test("a failure BEFORE the gate still fails, even though the world qualifies for the boundary", async () => {
    // Both container blockers that preceded this one — unknown-action and
    // singleton-owner-unverified — stop short of the auth gate. The boundary
    // must not swallow them, or it becomes a way to pass a launcher that never
    // starts for reasons that have nothing to do with credentials.
    const f = await boundaryFixture(`#!/usr/bin/env bash
printf 'ERROR orchestrator-singleton-owner-unverified provider_pid=1\\n' >&2
exit 1
`);
    const run = runStage(f.install, f.root, {
      ORCH_CLAUDE_CRED_FILE: join(f.root, "no-such-credentials.json"),
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(
      "METEORITE-LIVENESS proven=no reason=launch-refused:orchestrator-singleton-owner-unverified",
    );
  });

  test("the gate's refusal class alone does not buy the boundary; its own sentence must be there too", async () => {
    // A launcher that prints the token and stops somewhere else entirely. The
    // stage compares the launch log against what the gate ACTUALLY said when
    // the stage ran it moments earlier, so a token echoed by anything other
    // than the gate proves nothing.
    const f = await boundaryFixture(`#!/usr/bin/env bash
printf 'AUTH-PREFLIGHT refused=subscription-unproven\\n' >&2
printf 'provider not found: claude\\n' >&2
exit 2
`);
    const run = runStage(f.install, f.root, {
      ORCH_CLAUDE_CRED_FILE: join(f.root, "no-such-credentials.json"),
    });
    expect(run.exitCode).toBe(1);
    const evidence = evidenceOf(run);
    expect(evidence).toContain("proven=no");
    expect(evidence).not.toContain("auth-preflight-refusal");
  });

  test("the gate's sentence without its class does not buy the boundary either", async () => {
    const f = await boundaryFixture(`#!/usr/bin/env bash
printf 'refusing unproven subscription auth: %s is missing; run claude once and /login with the subscription account\\n' "$ORCH_CLAUDE_CRED_FILE" >&2
exit 2
`);
    const run = runStage(f.install, f.root, {
      ORCH_CLAUDE_CRED_FILE: join(f.root, "no-such-credentials.json"),
    });
    expect(run.exitCode).toBe(1);
    const evidence = evidenceOf(run);
    expect(evidence).toContain("proven=no");
    expect(evidence).not.toContain("auth-preflight-refusal");
  });

  test("real auth refusal text cannot launder a later provider failure", async () => {
    // Tier-A R4-1 red-before construction. The launcher really invokes the
    // tracked preflight, so BOTH exact refusal lines appear in its log. It then
    // ignores that refusal and fails later at provider lookup. Presence of the
    // auth text proves the gate ran; it does not prove the gate caused the
    // launcher's terminal result.
    const f = await boundaryFixture(`#!/usr/bin/env bash
"$(dirname "$0")/preflight-cli-auth.sh" "\${ORCH_PROVIDER:-claude}" || true
printf 'provider not found: claude\n' >&2
exit 2
`);
    const run = runStage(f.install, f.root, {
      ORCH_CLAUDE_CRED_FILE: join(f.root, "no-such-credentials.json"),
    });
    expect(run.exitCode).toBe(1);
    const evidence = evidenceOf(run);
    expect(evidence).toContain("proven=no");
    expect(evidence).toContain("reason=launch-refused:provider-not-found");
    expect(evidence).not.toContain("auth-preflight-refusal");
    expect(run.stderr.toString()).toContain("AUTH-PREFLIGHT refused=subscription-store-missing");
    expect(run.stderr.toString()).toContain("provider not found: claude");
  });

  test("a launcher that starts anyway, in a world the gate refuses, fails as an unenforced gate", async () => {
    // The auth preflight is not on the launch path it claims to be on. That is
    // a hole in the launcher, and it is the one thing a boundary defined by
    // "the gate refused" would otherwise report as a pass.
    const f = await boundaryFixture(`#!/usr/bin/env bash
printf 'fixture launcher: started without consulting the gate\\n'
exit 0
`);
    const run = runStage(f.install, f.root, {
      ORCH_CLAUDE_CRED_FILE: join(f.root, "no-such-credentials.json"),
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(
      "METEORITE-LIVENESS proven=no reason=auth-preflight-not-enforced",
    );
  });
});

describe("live-orchestrator credential boundary — worlds the boundary does not cover", () => {
  test("a metered-billing signal is not a credential-free world; no boundary applies", async () => {
    // The gate refuses here too, and for a reason that is a real problem with
    // this environment rather than a property of a rebuilt host. Reading it as
    // the boundary would let a misconfigured machine produce a green proof.
    const f = await boundaryFixture(LAUNCHER_THAT_REACHES_THE_GATE);
    const run = runStage(f.install, f.root, {
      ORCH_CLAUDE_CRED_FILE: join(f.root, "no-such-credentials.json"),
      ANTHROPIC_API_KEY: "fixture-not-a-secret",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(
      "METEORITE-LIVENESS proven=no reason=auth-preflight-indeterminate:metered-billing-signal",
    );
  });

  test("an unreadable credential store is not an absent one", async () => {
    const f = await boundaryFixture(LAUNCHER_THAT_REACHES_THE_GATE);
    const credentials = join(f.root, "corrupt-credentials.json");
    await writeFile(credentials, "{ this is not json");
    const run = runStage(f.install, f.root, { ORCH_CLAUDE_CRED_FILE: credentials });
    expect(run.exitCode).toBe(1);
    const evidence = evidenceOf(run);
    expect(evidence).toContain("proven=no");
    expect(evidence).toContain("auth-preflight-indeterminate");
    expect(evidence).not.toContain("auth-preflight-refusal");
  });

  test("WITH credentials, stopping at the auth gate is a FAIL and says so", async () => {
    // The locked direction. On a host that IS logged in, a launcher that
    // refuses at its auth gate is a regression, and the boundary must never
    // reach far enough to excuse it — that host is the one this control plane
    // actually runs on.
    const f = await boundaryFixture(`#!/usr/bin/env bash
printf 'AUTH-PREFLIGHT refused=subscription-unproven\\n' >&2
printf 'refusing unproven subscription auth: something regressed\\n' >&2
exit 2
`);
    const credentials = join(f.root, "credentials.json");
    await writeFile(credentials, SUBSCRIPTION_FIXTURE);
    const run = runStage(f.install, f.root, { ORCH_CLAUDE_CRED_FILE: credentials });
    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toContain(
      "METEORITE-LIVENESS proven=no reason=auth-refused-with-credentials-present:subscription-unproven",
    );
  });

  test("WITH credentials, a launcher that starts is held to full liveness, not to the boundary", async () => {
    // It starts, so the gate is not the stopping point; the stage must go on to
    // demand a startup handshake it will not get from this fixture. The failure
    // being asserted is the LIVENESS one — proof that the run did not stop at
    // the boundary and call it a day.
    const f = await boundaryFixture(`#!/usr/bin/env bash
case "\${1:-}" in
  status) exit 0 ;;
  stop) exit 0 ;;
esac
"$(dirname "$0")/preflight-cli-auth.sh" "\${ORCH_PROVIDER:-claude}" || exit 2
printf 'fixture launcher: started a session\\n'
exit 0
`);
    const credentials = join(f.root, "credentials.json");
    await writeFile(credentials, SUBSCRIPTION_FIXTURE);
    const run = runStage(f.install, f.root, { ORCH_CLAUDE_CRED_FILE: credentials });
    expect(run.exitCode).toBe(1);
    const evidence = evidenceOf(run);
    expect(evidence).toContain("proven=no");
    expect(evidence).toContain("reason=startup-handshake-missing");
    expect(evidence).not.toContain("auth-preflight-refusal");
  });
});

// ── The live rehearsal ─────────────────────────────────────────────────────
//
// Capability-gated, and the gate is measured rather than assumed. `launch.sh`
// verifies its singleton owner by locating the lock in /proc/locks, and that
// file is namespace-filtered: inside a container it reads EMPTY while a flock is
// held, so the launcher fails closed and no rehearsal is possible there. This
// suite runs inside the meteorite container, so an ungated rehearsal would fail
// the rebuild proof on an environment property rather than on a defect — the
// exact host-dependent-test shape V3-2.8 was filed for. An excluded case
// announces itself by name; it is never silently green.
const tmuxAvailable = Bun.which("tmux") !== null;

function singletonOwnershipObservable(): boolean {
  const probe = Bun.spawnSync([
    "bash", "-c", 'f=$(mktemp); exec 9>"$f"; flock -n 9 || exit 1; grep -c FLOCK /proc/locks 2>/dev/null || printf 0',
  ]);
  return Number(probe.stdout.toString().trim() || "0") > 0;
}

const rehearsalRunnable = tmuxAvailable && singletonOwnershipObservable();
if (!rehearsalRunnable) {
  console.log(
    "live-orchestrator-stage: EXCLUDED case=launch-rehearsal capability=" +
      (tmuxAvailable ? "proc-locks-visibility" : "tmux"),
  );
}

describe.if(rehearsalRunnable)("live-orchestrator stage rehearsal", () => {
  test("the stage starts the real launcher, proves a renewing pulse, and tears it down", async () => {
    const root = await scratch("live-stage-rehearsal-");
    const socket = `meteorite-live-stage-${process.pid}`;
    const session = `meteorite-live-${process.pid}`;
    sessions.push({ socket, name: session });
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });

    // Every fixture tmux session lives on a private `-L` socket, never the
    // default one a live orchestrator owns. launch.sh calls bare `tmux` for
    // has-session/list-panes/pipe-pane, so the redirection has to be a PATH shim
    // rather than an argument.
    await writeFile(join(bin, "tmux"), `#!/usr/bin/env bash\nexec /usr/bin/tmux -L ${socket} "$@"\n`);
    await chmod(join(bin, "tmux"), 0o755);

    // The launcher's callee, stubbed: core/mission-cli.ts implements neither
    // `reap` nor `lease`, which is blocker 1 of the 2026-08-04 incident and is
    // still open. Stubbing it here is what lets this rehearsal exercise the
    // handshake at all — and it is REPORTED, so the container run cannot inherit
    // the same excuse.
    const missionCli = join(root, "mission-cli.ts");
    await writeFile(missionCli, `const args = Bun.argv.slice(2);
if (args[0] === "reap") process.exit(0);
if (args[0] === "status") { console.log('{"missions":[],"lanes":[],"leases":[]}'); process.exit(0); }
if (args[0] === "lease" && args[1] === "acquire") {
  console.log(\`LEASE key=orchestrator owner=\${args[2]} token=1\`);
  process.exit(0);
}
process.exit(0);
`);
    const preflight = join(root, "preflight.sh");
    await writeFile(preflight, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(preflight, 0o755);
    const stateDb = join(root, "state.db");
    await writeFile(stateDb, "");
    const runtimeDir = join(root, "runtime");

    // A scratch HOME. The launcher's trust preflights read ~/.codex/config.toml
    // and ~/.claude.json, so on THIS host the verdict would depend on which
    // directories the operator happens to have accepted — a test whose result
    // moves with host state cannot survive a clean rebuild either (V3-2.8). A
    // rebuilt container has neither file, so an empty HOME is also the honest
    // reproduction of what the stage meets there.
    const home = join(root, "home");
    await mkdir(home, { recursive: true });

    const bunDir = dirname(Bun.which("bun") ?? "/usr/local/bin/bun");
    const run = Bun.spawnSync(["bash", stage], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${bunDir}:${process.env.PATH}`,
        METEORITE_LIVE_INSTALL_ROOT: repoRoot,
        METEORITE_LIVE_RUNTIME_DIR: runtimeDir,
        METEORITE_LIVE_STATE_DB: stateDb,
        METEORITE_LIVE_SESSION: session,
        METEORITE_LIVE_PROVIDER: "codex",
        METEORITE_LIVE_PULSE_INTERVAL: "5",
        // Declared substitutions. orchestrator/preflight-cli-auth.sh is absent
        // from the tree (blocker 2 of the same incident); ORCH_CONFIG_FILE is
        // pointed at nothing so a host runtime.env cannot leak into the proof.
        ORCH_AUTH_PREFLIGHT: preflight,
        ORCH_MISSION_CLI: missionCli,
        ORCH_CONFIG_FILE: join(root, "absent-runtime.env"),
        // Keep the singleton lock out of the checkout this rehearsal borrows.
        ORCH_SINGLETON_LOCK_FILE: join(root, "singleton.lock"),
      },
      stderr: "pipe",
    });

    const evidence = run.stdout.toString().split("\n").find((line) => line.startsWith("METEORITE-LIVENESS "));
    expect(evidence, `stage produced no evidence line\nstderr:\n${run.stderr.toString()}`).toBeDefined();
    expect(evidence).toContain("proven=yes");
    expect(evidence).toContain(`session=${session}`);
    expect(evidence).toContain("provider=codex");
    expect(evidence).toContain("startup_handshake=yes");
    expect(evidence).toContain("torn_down=yes");
    // The stub preflight exits 0, so this rehearsal is the credentialed world:
    // the boundary does not apply and the FULL path had to be walked.
    expect(evidence).toContain("liveness_boundary=full");
    expect(evidence).toContain("credential_world=present");
    expect(run.exitCode).toBe(0);

    // Derived from the environment, never self-declared: this is the guard that
    // stops a fixture-shaped run from being read as a rebuild proof.
    expect(evidence).toContain("substitutions=provider,auth-preflight,mission-cli,config-file");

    // The pulse actually advanced — the two stamps on the line are distinct and
    // ordered, which only an in-pane renewal loop can produce.
    const first = Number(evidence!.match(/pulse_first=(\d+)/)![1]);
    const last = Number(evidence!.match(/pulse_last=(\d+)/)![1]);
    expect(last).toBeGreaterThan(first);

    // Teardown is part of the proof: the session is gone and nothing is left running.
    const survivors = Bun.spawnSync(["tmux", "-L", socket, "has-session", "-t", session], { stderr: "ignore", stdout: "ignore" });
    expect(survivors.exitCode).not.toBe(0);
  }, 120_000);
});
