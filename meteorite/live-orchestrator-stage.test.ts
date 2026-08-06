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
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  test("an unknown argument is refused rather than treated as the default run", () => {
    const run = Bun.spawnSync(["bash", stage, "--start-everything"]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("unknown argument");
  });
});

// ── The live rehearsal ─────────────────────────────────────────────────────
const tmuxAvailable = Bun.which("tmux") !== null;

describe.if(tmuxAvailable)("live-orchestrator stage rehearsal", () => {
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
