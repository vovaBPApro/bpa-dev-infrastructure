import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATES,
  anchorReadContext,
  anchorReadEnv,
  checkReadiness,
  definitionDrift,
  executableShellLines,
  missionCliCalls,
  probeOutcome,
  report,
  requiredLauncherPaths,
} from "./check-cutover-readiness";

const REAL_REPO = join(import.meta.dir, "..");

// A repository in which every gate holds, so each case below changes exactly
// one input and the verdict it moves is attributable to that one change.
//
// Everything the fixture writes into the repo is COMMITTED: the checker
// measures git's tracked set, and a fixture that reached PASS from a dirty tree
// would be testing a state the definition ("from a clean clone, with no file
// from this host") does not allow. `untracked` writes files after the commit
// precisely so the tests below can prove such a file moves nothing.
//
// The ONE input that is deliberately outside the tree is the rebuild proof's
// artifact: meteorite/run.sh writes it outside any checkout, because an
// artifact inside the tree would make the next landing refuse a dirty worktree.
// It lives in a sibling directory of each fixture repo and is addressed exactly
// as the runner addresses it.
//
// The fixture scripts are RUNNABLE, because the gates execute them: the
// bootstrap really runs and the ledger checker really reports on the tree it is
// pointed at. A fixture that only LOOKED like a script would be re-importing
// the defect these revisions removed.
type Options = {
  synthesis?: string;
  launcher?: string;
  meteorite?: string;
  ledgerChecker?: string;
  hostState?: string;
  bootstrap?: string;
  registry?: string;
  omit?: string[];
  // Extra files committed with the fixture. `untracked` proves an untracked
  // file moves nothing; this is for inputs the gates must actually SEE —
  // package manifests, and the real materializer the rehearsal runs.
  tracked?: Record<string, string>;
  untracked?: Record<string, string>;
  // Overrides merged into the green `meteorite-result/v1` artifact; `null`
  // writes no artifact at all, which is this repository's state today.
  artifact?: Record<string, unknown> | null;
  // How the artifact's trust anchor is published to the fixture's origin.
  // `null` publishes none, which is the state of the real writer today and the
  // state every forgery leaves behind.
  anchor?: AnchorOptions | null;
};

// A runnable meteorite with the given stage lines. Nothing in this file's gates
// reads its text any more -- that is one of the properties under test -- but a
// fixture runner that could not run would be a worse fixture, not a safer one.
function meteoriteWith(...stages: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'repo_url="https://example.invalid/repo.git"',
    'ref="0000000000000000000000000000000000000000"',
    "commands=(",
    ...stages.map((stage) => `  ${stage}`),
    ")",
    'cid="$(docker run -d --rm ubuntu:24.04 sleep infinity)"',
    'for entry in "${commands[@]}"; do',
    '  docker exec "$cid" bash -lc "${entry#*|}"',
    "done",
    'docker rm -f "$cid" >/dev/null',
    "",
  ].join("\n");
}

const PREREQ_STAGE = '"prerequisites|apt-get update && apt-get install -y git"';
const CLONE_STAGE = `"clone|git clone --no-checkout 'https://example.invalid/repo.git' /work/source"`;
const LIVE_STAGE = '"orchestrator-live|bash meteorite/live-orchestrator-stage.sh"';

// The stage list meteorite/run.sh declares as its own contract, with the
// verdicts a clean run records.
const GREEN_STAGES = [
  "container-start",
  "prerequisites",
  "clone",
  "sha-verification",
  "bootstrap-install",
  "full-test-suite",
  "unit-drift",
  "orchestrator-live",
].map((name) => ({ name, verdict: "PASS" }));

const GREEN_LIVENESS = {
  proven: true,
  session: "meteorite-rehearsal",
  provider: "codex",
  pulse_first: "1786018973",
  pulse_last: "1786018975",
  startup_handshake: "yes",
  torn_down: "yes",
  substitutions: "provider",
  unproven: "cgroup-isolation,provider-session,telegram-transport,watchdog-supervision",
};

// A miniature of tools/instructions/check.ts, and a real one: it reads the tree
// it was pointed at, reports UNKNOWN for each input it cannot see and a
// measured outcome for each it can, counts its own UNKNOWNs in its summary, and
// blocks on them only under --strict. `channel` decides whether it also
// publishes the structured outcome set.
function checkerScript(options: { channel?: boolean } = {}): string {
  return [
    "#!/usr/bin/env bun",
    'import { existsSync } from "node:fs";',
    'import { join } from "node:path";',
    "const argv = process.argv.slice(2);",
    'const index = argv.indexOf("--repo");',
    'const repo = index >= 0 ? argv[index + 1] : ".";',
    'const strict = argv.includes("--strict");',
    "const findings = [",
    '  existsSync(join(repo, "instructions/lane-lifecycle.md"))',
    '    ? { level: "PASS", file: "instructions/lane-lifecycle.md", check: "schema" }',
    '    : { level: "UNKNOWN", file: "instructions/", check: "schema" },',
    '  existsSync(join(repo, "instance/params.yaml"))',
    '    ? { level: "WARN", file: "instance/params.yaml", check: "ledger" }',
    '    : { level: "UNKNOWN", file: "instance/params.yaml", check: "ledger" },',
    "];",
    "for (const finding of findings) console.log(`${finding.level} ${finding.file} [${finding.check}] detail`);",
    'const unknown = findings.filter((finding) => finding.level === "UNKNOWN").length;',
    "console.log(`\\nsummary: 0 FAIL, ${unknown} UNKNOWN, 0 WARN, 0 SKIP, 0 PASS (0 docs)`);",
    options.channel === false
      ? "// this checker publishes no structured outcome channel"
      : 'const channel = process.env.CHECK_OUTCOMES_JSON;\nif (channel) await Bun.write(channel, JSON.stringify({ findings }));',
    "process.exit(strict && unknown > 0 ? 1 : 0);",
    "",
  ].join("\n");
}

const DEFAULTS = {
  // Enough of orchestrator/launch.sh to carry the two things the gates read:
  // the executable paths it requires, and the mission-cli vocabulary it speaks.
  launcher: [
    'source "$SCRIPT_DIR/proc-identity.sh"',
    'AUTH_PREFLIGHT="${ORCH_AUTH_PREFLIGHT:-$SCRIPT_DIR/preflight-cli-auth.sh}"',
    'MISSION_CLI="${ORCH_MISSION_CLI:-$REPO_DIR/core/mission-cli.ts}"',
    'STATE_DB="${ORCH_STATE_DB:-$REPO_DIR/runtime/state.db}"',
    'LOCK_FILE="${ORCH_LOCK_FILE:-$RUNTIME_DIR/launch.lock}"',
    'mission_cli() { "$BUN_BIN" "$MISSION_CLI" "$@"; }',
    'mission_cli lane claim "$lane" "$owner" "$ttl"',
    'status_output="$(mission_cli status)"',
  ].join("\n"),
  meteorite: meteoriteWith(
    PREREQ_STAGE,
    "# a comment inside the array is not a stage",
    CLONE_STAGE,
    LIVE_STAGE,
  ),
  ledgerChecker: checkerScript(),
  hostState: "# id\tlocation\tverify\nbot-token\t/root/.config/bpa/orchestrator.env\ttest -s /root/.config/bpa/orchestrator.env\n",
  // Runnable: really invokes the installer beside it, whatever directory the
  // rehearsal world put the tree in.
  bootstrap: '#!/usr/bin/env bash\nbash "$(dirname "$0")/../tools/whisper/install.sh"\n',
  registry: [
    "# id\tkind\ttracked target",
    "runner:meteorite\trunner\tmeteorite/run.sh",
    "checker:checkout-parity\tchecker\tgate/checkout-parity.sh",
    "checker:stranded-work\tchecker\thygiene/check-stranded-work.sh",
    "",
  ].join("\n"),
} as const;

// The gate text as the synthesis file carries it. Built from GATES so a fixture
// can never disagree with the checker about what a gate says; that the checker
// agrees with the REAL synthesis file is locked separately, below.
function synthesisText(): string {
  return ["## Definition of cutover-ready (the part nobody had written)", "", ...GATES.map((gate) => `- **${gate.id}.** ${gate.definition}`), ""].join("\n");
}

function write(repo: string, path: string, content: string): void {
  mkdirSync(join(repo, path.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function git(repo: string, ...args: string[]) {
  return Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
}

function porcelain(repo: string): string {
  return git(repo, "status", "--porcelain").stdout.toString().trim();
}

function headSha(repo: string): string {
  return git(repo, "rev-parse", "HEAD").stdout.toString().trim();
}

// Outside the repository, exactly as meteorite/run.sh writes it: the fixture's
// own XDG state root plus the tracked path constant. There is no override to
// hand over any more, so `${repo}-state` IS the address, and pointing
// XDG_STATE_HOME at it is how a fixture's artifact becomes findable.
function stateHomeFor(repo: string): string {
  return `${repo}-state`;
}

function artifactPathFor(repo: string): string {
  return join(stateHomeFor(repo), "bpa-dev-infrastructure/evidence/meteorite-latest.json");
}

// The fixture's origin: a local bare repository, so the anchor lookup is a real
// `git ls-remote` against a real remote and the suite still touches no network.
function originFor(repo: string): string {
  return `${repo}-origin.git`;
}

// A second bare repository a lane could create anywhere, standing in for the
// one every round-6 forgery redirects the anchor read at. It is never origin.
function forgedOriginFor(repo: string): string {
  return `${repo}-forged.git`;
}

function bareRepo(path: string): string {
  Bun.spawnSync(["git", "init", "--bare", "-q", path]);
  return path;
}

function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// The writer half of the trust anchor, in the shape specified for
// meteorite/run.sh: the artifact's sha256 is the ref name, the commit the run
// proved is the ref target, and a mirror in a second namespace is pushed with
// it. `options` exists so a test can publish a DEFECTIVE anchor -- one side
// only, a digest for different bytes, a ref pointing elsewhere -- because each
// of those is a way a forged artifact could try to look anchored.
// `remote` publishes a perfectly well-formed anchor somewhere that is NOT
// origin, which is what every config rewrite tries to make the reader read.
type AnchorOptions = { digest?: string; target?: string; mirror?: boolean; namespaceOnly?: boolean; remote?: string };

function publishAnchor(repo: string, options: AnchorOptions = {}): void {
  const sha = headSha(repo);
  const digest = options.digest ?? sha256Of(artifactPathFor(repo));
  const leaf = `${sha}/${digest}`;
  const target = options.target ?? sha;
  const refs = [`${target}:refs/bpa-meteorite-proofs/${leaf}`];
  if (options.mirror !== false) refs.push(`${target}:refs/bpa-meteorite-proof-mirrors/${leaf}`);
  const pushed = git(repo, "push", "-q", "--force", options.remote ?? originFor(repo), ...refs);
  if (pushed.exitCode !== 0) throw new Error(`fixture anchor push failed: ${pushed.stderr.toString()}`);
}

function writeArtifact(repo: string, overrides: Record<string, unknown> = {}): void {
  const sha = headSha(repo);
  const artifact = {
    schema: "meteorite-result/v1",
    finished: true,
    result: "clean",
    blocker: "none",
    requested_sha: sha,
    tree_sha: sha,
    stages: GREEN_STAGES,
    liveness: GREEN_LIVENESS,
    finished_at: "2026-08-06T18:04:11Z",
    ...overrides,
  };
  const path = artifactPathFor(repo);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

function fixture(options: Options = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "cutover-readiness-"));
  const omit = new Set(options.omit ?? []);
  const files: Record<string, string> = {
    "instance/consilium-cutover-2026-08-04-evening-synthesis.md": options.synthesis ?? synthesisText(),
    "orchestrator/launch.sh": options.launcher ?? DEFAULTS.launcher,
    "orchestrator/proc-identity.sh": "# identity\n",
    "orchestrator/preflight-cli-auth.sh": "# preflight\n",
    "core/mission-cli.ts": "// mission cli\n",
    "bootstrap/check-unit-drift.sh": "# unit drift\n",
    "bootstrap/install.sh": options.bootstrap ?? DEFAULTS.bootstrap,
    "tools/whisper/install.sh": "# whisper\n",
    "meteorite/run.sh": options.meteorite ?? DEFAULTS.meteorite,
    "tools/instructions/check.ts": options.ledgerChecker ?? DEFAULTS.ledgerChecker,
    // The ledger checker's inputs, so a probe of the tracked tree can tell a
    // checker from a constant.
    "instructions/lane-lifecycle.md": "---\nid: lane-lifecycle\n---\n",
    "instance/params.yaml": "phase: fixture\n",
    "instance/host-state.tsv": options.hostState ?? DEFAULTS.hostState,
    "instance/required-mechanisms.tsv": options.registry ?? DEFAULTS.registry,
    "gate/checkout-parity.sh": "# one verdict from every checkout kind\n",
    "hygiene/check-stranded-work.sh": "# nothing ACCEPTed lives only here\n",
  };
  for (const [path, content] of Object.entries(files)) if (!omit.has(path)) write(repo, path, content);
  for (const [path, content] of Object.entries(options.tracked ?? {})) write(repo, path, content);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  Bun.spawnSync(["git", "init", "--bare", "-q", originFor(repo)]);
  git(repo, "remote", "add", "origin", originFor(repo));
  if (options.artifact !== null) {
    writeArtifact(repo, options.artifact ?? {});
    if (options.anchor !== null) publishAnchor(repo, options.anchor ?? {});
  }
  for (const [path, content] of Object.entries(options.untracked ?? {})) write(repo, path, content);
  return repo;
}

// A tracked file added after the fixture's first commit moves HEAD, so the
// artifact and its anchor are both re-made: an artifact about the previous SHA
// would be stale, and an anchor for the previous bytes would not vouch for it.
function commitAndReanchor(repo: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "extra");
  writeArtifact(repo);
  publishAnchor(repo);
}

function discard(repo: string): void {
  rmSync(repo, { recursive: true, force: true });
  for (const suffix of ["-state", "-origin.git", "-forged.git", "-lane", "-ssh", "-gitconfig", "-tmproot"]) {
    rmSync(`${repo}${suffix}`, { recursive: true, force: true });
  }
}

// One measurement per call: the executed probes make a measurement cost real
// time, so tests read verdicts and evidence from a single run. The artifact's
// address is NOT handed over -- there is no way to hand it over any more. The
// fixture's XDG state root is set exactly as a host sets it, and the reader
// resolves the rest itself.
type Measured = {
  verdicts: Record<string, string>;
  evidence: (gate: string) => string;
  exitCode: number;
  lines: string[];
};

function withEnv<T>(values: Record<string, string | undefined>, body: () => T): T {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(values);
  try {
    return body();
  } finally {
    apply(previous);
  }
}

function measure(repo: string): Measured {
  return withEnv({ XDG_STATE_HOME: stateHomeFor(repo), METEORITE_ARTIFACT: undefined }, () => {
    const results = checkReadiness(repo);
    const { lines, exitCode } = report(results);
    return {
      verdicts: Object.fromEntries(results.map((entry) => [entry.id, entry.verdict])),
      evidence: (gate: string) => results.find((entry) => entry.id === gate)!.evidence,
      exitCode,
      lines,
    };
  });
}

function withFixture(options: Options, assertion: (repo: string) => void): void {
  const repo = fixture(options);
  try { assertion(repo); } finally { discard(repo); }
}

// --- the exit-code rule -----------------------------------------------------

test("exit 0 only when every gate is PASS", () => {
  withFixture({}, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts).toEqual({ A: "PASS", B: "PASS", C: "PASS", D: "PASS", E: "PASS", F: "PASS", G: "PASS" });
    expect(measured.exitCode).toBe(0);
    expect(measured.lines.at(-1)).toBe("CUTOVER-READINESS summary pass=7 fail=0 unknown=0 cutover-ready=yes");
  });
});

test("one FAIL is a non-zero exit", () => {
  withFixture({ omit: ["tools/whisper/install.sh"] }, (repo) => {
    const measured = measure(repo);
    expect(measured.exitCode).toBe(1);
    expect(measured.lines.at(-1)).toContain("fail=1");
    expect(measured.lines.at(-1)).toContain("cutover-ready=no");
  });
});

test("one UNKNOWN is a non-zero exit — an unmeasured gate is not a green one", () => {
  withFixture({ omit: ["meteorite/run.sh"] }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.exitCode).toBe(1);
  });
});

test("an empty gate list is not cutover-ready", () => {
  expect(report([]).exitCode).toBe(1);
});

test("the command itself carries the exit code, not just the library", () => {
  withFixture({}, (repo) => {
    const green = Bun.spawnSync([process.execPath, join(REAL_REPO, "tools/check-cutover-readiness.ts"), "--repo", repo], {
      env: { ...process.env, XDG_STATE_HOME: stateHomeFor(repo) },
    });
    expect(green.exitCode).toBe(0);
    expect(green.stdout.toString()).toContain("CUTOVER-READINESS A PASS");
  });
  withFixture({ omit: ["instance/host-state.tsv"] }, (repo) => {
    const red = Bun.spawnSync([process.execPath, join(REAL_REPO, "tools/check-cutover-readiness.ts"), "--repo", repo], {
      env: { ...process.env, XDG_STATE_HOME: stateHomeFor(repo) },
    });
    expect(red.exitCode).toBe(1);
    expect(red.stdout.toString()).toContain("CUTOVER-READINESS F FAIL");
  });
});

// --- green comes from a clean, tracked tree — and only from one -------------

test("cutover-ready=yes is reachable from a clean, fully committed tree", () => {
  withFixture({}, (repo) => {
    expect(porcelain(repo)).toBe("");
    expect(measure(repo).exitCode).toBe(0);
    // Measuring must also leave the tree clean: the probes run real commands,
    // and they may not deposit anything in the repository they judge.
    expect(porcelain(repo)).toBe("");
  });
});

test("no untracked file can move any gate toward PASS", () => {
  const inputs: Record<string, string> = {
    "meteorite/run.sh": DEFAULTS.meteorite,
    "instance/host-state.tsv": DEFAULTS.hostState,
    "tools/whisper/install.sh": "# whisper\n",
    "bootstrap/install.sh": DEFAULTS.bootstrap,
    "core/mission-cli.ts": "// mission cli\n",
    "gate/checkout-parity.sh": "# one verdict from every checkout kind\n",
    "instance/required-mechanisms.tsv": DEFAULTS.registry,
  };
  for (const [path, content] of Object.entries(inputs)) {
    // Committed without the file, then the identical content restored as an
    // untracked host-local file: every gate must read exactly as it did with
    // the file absent.
    const trackedAbsent = fixture({ omit: [path] });
    const hostLocal = fixture({ omit: [path], untracked: { [path]: content } });
    try {
      expect(porcelain(hostLocal)).not.toBe("");
      const measured = measure(hostLocal);
      expect({ path, verdicts: measured.verdicts }).toEqual({ path, verdicts: measure(trackedAbsent).verdicts });
      expect(measured.exitCode).toBe(1);
    } finally {
      discard(trackedAbsent);
      discard(hostLocal);
    }
  }
});

test("an untracked attestation-shaped file greens nothing", () => {
  withFixture({
    omit: ["instance/host-state.tsv", "gate/checkout-parity.sh", "hygiene/check-stranded-work.sh"],
    untracked: { "instance/cutover-attestations.tsv": "A\tproved\nE\tproved\nF\tproved\n" },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts).toMatchObject({ E: "UNKNOWN", F: "FAIL" });
    expect(measured.exitCode).toBe(1);
  });
});

test("outside a git repository nothing is judged", () => {
  const directory = mkdtempSync(join(tmpdir(), "cutover-readiness-nogit-"));
  try {
    const results = checkReadiness(directory);
    expect(results.every((entry) => entry.verdict === "UNKNOWN")).toBe(true);
    expect(results[0]!.evidence).toContain("not a git repository");
    expect(report(results).exitCode).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// --- UNKNOWN is never PASS --------------------------------------------------

test("halves with no tracked verifier are UNKNOWN, and name the mechanism that would settle them", () => {
  withFixture({ omit: ["gate/checkout-parity.sh", "hygiene/check-stranded-work.sh"] }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts).toMatchObject({ E: "UNKNOWN", F: "UNKNOWN" });
    expect(measured.evidence("E")).toContain("checker:checkout-parity");
    expect(measured.evidence("F")).toContain("checker:stranded-work");
  });
});

test("a registry row whose target was never landed does not certify anything", () => {
  const registry = DEFAULTS.registry.replace("gate/checkout-parity.sh", "gate/never-written.sh");
  withFixture({ registry }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("UNKNOWN");
    expect(measured.evidence("E")).toContain("gate/never-written.sh");
  });
});

// Round-4 finding 3: a registered, landed mechanism is not a performed act, and
// the evidence may not say "proven by" about a file nobody ran.
test("a registered mechanism claims that the mechanism exists, not that the act was proven", () => {
  withFixture({}, (repo) => {
    const measured = measure(repo);
    for (const gate of ["E", "F"]) {
      expect(measured.evidence(gate)).toContain("this command does not execute it");
      expect(measured.evidence(gate)).not.toContain("proven by");
    }
    expect(measured.evidence("E")).toContain("not that the three verdicts matched");
    expect(measured.evidence("F")).toContain("not that the scan came back empty");
  });
});

test("an unreadable definition source makes every gate UNKNOWN rather than judged", () => {
  withFixture({ omit: ["instance/consilium-cutover-2026-08-04-evening-synthesis.md"] }, (repo) => {
    const measured = measure(repo);
    expect(Object.values(measured.verdicts).every((verdict) => verdict === "UNKNOWN")).toBe(true);
    expect(measured.evidence("A")).toContain("gate definitions unreadable");
  });
});

test("a gate whose definition drifted is UNKNOWN; its siblings are still judged", () => {
  const watered = synthesisText().replace(GATES[3]!.definition, "The meteorite runs.");
  withFixture({ synthesis: watered }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("definition drifted");
    expect(measured.verdicts.B).toBe("PASS");
  });
});

test("quoting the original sentence elsewhere does not cover for a watered-down bullet", () => {
  const watered = [
    "## Definition of cutover-ready (the part nobody had written)",
    "",
    ...GATES.map((gate) => `- **${gate.id}.** ${gate.id === "D" ? "The meteorite runs." : gate.definition}`),
    "",
    "## What gate D used to say",
    "",
    `- **D.** ${GATES[3]!.definition}`,
    "",
  ].join("\n");
  withFixture({ synthesis: watered }, (repo) => {
    expect(measure(repo).verdicts.D).toBe("UNKNOWN");
  });
});

// --- gate A: a clean clone starts ------------------------------------------

test("A FAILs when the launcher requires a path the tree does not carry", () => {
  withFixture({ omit: ["orchestrator/preflight-cli-auth.sh"] }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("FAIL");
    expect(measured.evidence("A")).toContain("orchestrator/preflight-cli-auth.sh");
  });
});

test("A FAILs when tracked runtime source still reaches for the break-glass tree", () => {
  withFixture({ launcher: `${DEFAULTS.launcher}\nsource /root/oldorch-breakglass/env.sh\n` }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("FAIL");
    expect(measured.evidence("A")).toContain("break-glass");
  });
});

test("A is UNKNOWN, not FAIL, when the launcher itself cannot be read", () => {
  withFixture({ omit: ["orchestrator/launch.sh"] }, (repo) => {
    expect(measure(repo).verdicts.A).toBe("UNKNOWN");
  });
});

// Gate A's definition includes "with `orchestrator/runtime.env` renamed away".
// The clause is about what a clean clone carries, and the tracked set decides
// that: today the file is gitignored, and this is what ties the clause to that
// fact rather than leaving it resting on a line in another file.
test("A FAILs when runtime.env is tracked, because every clean clone would carry it", () => {
  const repo = fixture({});
  try {
    expect(measure(repo).verdicts.A).toBe("PASS");
    write(repo, "orchestrator/runtime.env", "ORCH_TOKEN_FILE=/root/.config/bpa/orchestrator.env\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "track runtime.env");
    writeArtifact(repo);
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("FAIL");
    expect(measured.evidence("A")).toContain("renamed away");
    expect(measured.exitCode).toBe(1);
  } finally {
    discard(repo);
  }
});

// --- gate B: launcher paths -------------------------------------------------

test("B extracts the launcher's executable paths and ignores runtime artifacts", () => {
  withFixture({}, (repo) => {
    const paths = requiredLauncherPaths(repo)!.map((entry) => entry.path);
    expect(paths).toEqual(["orchestrator/proc-identity.sh", "orchestrator/preflight-cli-auth.sh", "core/mission-cli.ts"]);
  });
});

test("B sees the braced form too, so a required path cannot hide behind ${...}", () => {
  withFixture({ launcher: `${DEFAULTS.launcher}\nsource "\${SCRIPT_DIR}/never-written.sh"\n` }, (repo) => {
    expect(requiredLauncherPaths(repo)!.map((entry) => entry.path)).toContain("orchestrator/never-written.sh");
    const measured = measure(repo);
    expect(measured.verdicts.B).toBe("FAIL");
    expect(measured.evidence("B")).toContain("orchestrator/never-written.sh");
  });
});

test("B FAILs on an absent required path and names the launcher line", () => {
  withFixture({ omit: ["core/mission-cli.ts"] }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.B).toBe("FAIL");
    expect(measured.evidence("B")).toMatch(/core\/mission-cli\.ts \(orchestrator\/launch\.sh:3\)/);
  });
});

test("B is UNKNOWN when the installed-path verifier it defers to is absent", () => {
  withFixture({ omit: ["bootstrap/check-unit-drift.sh"] }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.B).toBe("UNKNOWN");
    expect(measured.evidence("B")).toContain("bootstrap/check-unit-drift.sh");
  });
});

// --- gate C: caller/callee vocabulary --------------------------------------

test("C FAILs on a call outside the implemented vocabulary", () => {
  withFixture({ launcher: `${DEFAULTS.launcher}\nmission_cli invent something\n` }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.C).toBe("FAIL");
    expect(measured.evidence("C")).toContain("orchestrator/launch.sh");
    expect(measured.evidence("C")).toContain("invent");
  });
});

test("C reads calls, not the shell function that wraps them", () => {
  withFixture({}, (repo) => {
    expect(missionCliCalls(repo).map((call) => `${call.group} ${call.action ?? ""}`.trim())).toEqual(["lane claim", "status"]);
  });
});

// A block comment is prose, and prose about the mission CLI is not a call to
// it. core/mission-cli-actions.ts explains itself in one -- "it lives in this
// module and not in mission-cli.ts because mission-cli.ts runs its `main` at
// import time" -- and gate C read `because` as an action and FAILed the real
// repository on a sentence about itself.
test("C does not read a block comment about the mission CLI as a call", () => {
  const prose = [
    "/**",
    " * This module exists and not mission-cli.ts because mission-cli.ts runs",
    " * its main at import time. See mission_cli reap for the older spelling.",
    " */",
    "export const marker = 1;",
    "",
  ].join("\n");
  withFixture({}, (repo) => {
    write(repo, "core/notes.ts", prose);
    commitAndReanchor(repo);
    expect(missionCliCalls(repo).filter((call) => call.file === "core/notes.ts")).toEqual([]);
    expect(measure(repo).verdicts.C).toBe("PASS");
  });
});

// ...and the skip that does it is a LINE-PREFIX rule, not a `/*`...`*/` scan.
// Round 5 tracked block comments across lines, and because `/*` is an ordinary
// shell glob it skipped every line after one — 5,106 lines of tracked runtime
// source and 6 of this repository's 12 mission-cli calls, including the
// orchestrator's own `mission_cli status` and `reap`. Both idioms below are
// this repository's own shell, and both used to turn an observed violation into
// a green. The call after them must be SEEN.
for (const [name, glob] of [
  ["a for-loop glob", 'for f in "$dir"/*.in; do :; done'],
  ["a pattern match", '[[ "$p" == /* ]] || exit 1'],
] as const) {
  test(`C sees a mission-cli call that follows ${name} — a glob is not a block comment`, () => {
    withFixture({}, (repo) => {
      write(repo, "hygiene/probe.sh", `#!/usr/bin/env bash\n${glob}\nmission_cli bogusgroup bogusaction\n`);
      commitAndReanchor(repo);
      expect(missionCliCalls(repo).filter((call) => call.file === "hygiene/probe.sh")).toEqual([
        { file: "hygiene/probe.sh", line: 3, group: "bogusgroup", action: "bogusaction" },
      ]);
      const measured = measure(repo);
      expect(measured.verdicts.C).toBe("FAIL");
      expect(measured.evidence("C")).toContain("hygiene/probe.sh:3 bogusgroup bogusaction");
    });
  });
}

// The count is part of the claim: "N calls, all in core/mission-cli-actions.ts"
// is read as coverage, so a scan that silently stops reading files must not be
// able to say it. Every tracked runtime source file is scanned to its end.
test("C scans every line of every tracked runtime source file", () => {
  withFixture({}, (repo) => {
    const before = missionCliCalls(repo).length;
    write(repo, "hygiene/probe.sh", `#!/usr/bin/env bash\nfor f in "$dir"/*.in; do :; done\nmission_cli lane claim\nmission_cli status\n`);
    commitAndReanchor(repo);
    expect(missionCliCalls(repo).length).toBe(before + 2);
    expect(measure(repo).evidence("C")).toContain(`${before + 2} mission-cli call(s)`);
  });
});

// ...and a real call on the same line as the end of a block comment is still a
// call: skipping comments may not become a way to hide one.
test("C still reads a call that follows a closed block comment", () => {
  withFixture({ launcher: `${DEFAULTS.launcher}\n/* wrapper */ mission_cli invent something\n` }, (repo) => {
    expect(measure(repo).verdicts.C).toBe("FAIL");
  });
});

// This checker quotes gate A's definition (which names the break-glass tree)
// and prints evidence strings about mission-cli calls. Reading its own source
// as evidence made it report two calls that do not exist, and would let a
// reworded evidence string change a verdict.
test("C does not read this checker's own citations as callers", () => {
  expect(missionCliCalls(REAL_REPO).filter((call) => call.file.includes("check-cutover-readiness"))).toEqual([]);
});

test("C is UNKNOWN when nothing calls the mission CLI at all", () => {
  withFixture({ launcher: 'AUTH_PREFLIGHT="${ORCH_AUTH_PREFLIGHT:-$SCRIPT_DIR/preflight-cli-auth.sh}"\nMISSION_CLI="${ORCH_MISSION_CLI:-$REPO_DIR/core/mission-cli.ts}"\n' }, (repo) => {
    expect(measure(repo).verdicts.C).toBe("UNKNOWN");
  });
});

// --- gates D and A: the rebuild proof's own artifact -------------------------
//
// Four rounds of this gate were greened by something other than a rebuild: a
// comment naming the launcher, a stage command that mentioned it, a variable
// assignment that looked like an invocation, and finally a rehearsal of the
// runner in which "the proof's path executed at some point" was accepted as
// "the meteorite started the orchestrator". What a green consumes now is the
// artifact meteorite/run.sh writes about a run that actually happened: the tree
// SHA it proved, the stages it executed with their verdicts, whether it
// finished, and the liveness evidence of its orchestrator-live stage.

test("D and A's clean-clone half PASS on a finished rebuild proof at this SHA", () => {
  withFixture({}, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("PASS");
    expect(measured.verdicts.A).toBe("PASS");
    expect(measured.evidence("D")).toContain("ran orchestrator-live to PASS with liveness proven");
    expect(measured.evidence("A")).toContain("cloned the candidate (stage clone PASS)");
    // The declared boundaries a container structurally cannot cross travel with
    // the green, so a PASS never reads as more than it proved.
    expect(measured.evidence("D")).toContain("cgroup-isolation");
  });
});

test("with no artifact at all, D and A's clean-clone half are UNKNOWN — not FAIL, not PASS", () => {
  withFixture({ artifact: null }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("no rehearsal artifact at this SHA");
    expect(measured.evidence("D")).toContain("does not exist");
    expect(measured.evidence("A")).toContain("no rehearsal artifact at this SHA");
    expect(measured.exitCode).toBe(1);
  });
});

test("an artifact for another SHA proves nothing about this one", () => {
  withFixture({ artifact: { tree_sha: "b".repeat(40) } }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("no rehearsal artifact at this SHA");
    expect(measured.evidence("D")).toContain("vouches for the tree it measured and no other");
  });
});

test("an uncommitted change to a tracked file leaves D unmeasured, not certified", () => {
  withFixture({}, (repo) => {
    expect(measure(repo).verdicts.D).toBe("PASS");
    write(repo, "orchestrator/proc-identity.sh", "# identity, edited but not committed\n");
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("differ from HEAD");
  });
});

test("an artifact this reader cannot believe is UNKNOWN, never PASS", () => {
  const broken: Record<string, Record<string, unknown> | string> = {
    "wrong schema": { schema: "meteorite-result/v0" },
    "no finished flag": { finished: "yes" },
    "no stage list": { stages: "all of them" },
    "a stage without a verdict": { stages: [{ name: "orchestrator-live" }] },
  };
  for (const [label, overrides] of Object.entries(broken)) {
    withFixture({ artifact: overrides as Record<string, unknown> }, (repo) => {
      const measured = measure(repo);
      expect({ label, D: measured.verdicts.D, A: measured.verdicts.A }).toEqual({ label, D: "UNKNOWN", A: "UNKNOWN" });
      expect(measured.evidence("D")).toContain("no rehearsal artifact at this SHA");
    });
  }
});

test("an artifact that is not JSON at all is UNKNOWN, never PASS", () => {
  withFixture({}, (repo) => {
    writeFileSync(artifactPathFor(repo), "the meteorite ran and everything was fine\n");
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("is not readable JSON");
  });
});

// Round-4 finding 1, first construction: a run that never finished. The old
// wiring check consulted the journal before it consulted survival, so a
// meteorite that aborted after the proof ran was still PASS.
test("D FAILs an unfinished rebuild proof, in the artifact's own words", () => {
  withFixture({
    artifact: {
      finished: false,
      result: "NO-GO",
      blocker: "orchestrator-live command failed: launch-refused:error-unknown-action",
      stages: [{ name: "clone", verdict: "PASS" }, { name: "orchestrator-live", verdict: "NO-GO" }],
      liveness: { proven: false, reason: "launch-refused:error-unknown-action" },
    },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("did not finish its rebuild proof");
    expect(measured.evidence("D")).toContain("launch-refused:error-unknown-action");
    expect(measured.verdicts.A).toBe("FAIL");
    expect(measured.exitCode).toBe(1);
  });
});

// Round-4 finding 1, the construction that mattered: stages = clone plus the
// full test suite, no stage that starts anything. The suite runs the start
// proof's own regression lock, so the proof's path executed — and the old gate
// called that "the meteorite starts the orchestrator". The artifact records the
// stages that ran, so this is now exactly what it looks like.
test("D FAILs a finished proof whose stage list contains no orchestrator-live stage", () => {
  withFixture({
    artifact: {
      stages: [{ name: "clone", verdict: "PASS" }, { name: "full-test-suite", verdict: "PASS" }],
      liveness: { proven: false, reason: "stage-not-reached" },
    },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("finished without running a orchestrator-live stage at all");
    expect(measured.evidence("D")).toContain("asserts that files copied");
    expect(measured.verdicts.A).toBe("FAIL");
  });
});

test("D FAILs when the live stage ran and did not pass", () => {
  withFixture({
    artifact: {
      result: "NO-GO",
      blocker: "orchestrator did not reach a live state: singleton-owner-unverified",
      stages: [...GREEN_STAGES.slice(0, -1), { name: "orchestrator-live", verdict: "NO-GO" }],
      liveness: { proven: false, reason: "singleton-owner-unverified" },
    },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("ran orchestrator-live and it did not pass (NO-GO)");
    expect(measured.evidence("D")).toContain("singleton-owner-unverified");
  });
});

// A stage verdict and the liveness evidence beside it are two claims about the
// same act. When they disagree neither can be believed, and the gate says so
// rather than taking the greener one.
test("D FAILs a live stage marked PASS beside liveness proven:false", () => {
  withFixture({
    artifact: { liveness: { proven: false, reason: "provider-session-absent" } },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("the stage verdict and the liveness evidence disagree");
  });
});

test("A's clean-clone half is UNKNOWN when the executed run recorded no clone stage", () => {
  withFixture({
    artifact: { stages: GREEN_STAGES.filter((stage) => stage.name !== "clone") },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.evidence("A")).toContain("none of them is clone");
    // D is about the live stage and is unaffected: one artifact, two questions.
    expect(measured.verdicts.D).toBe("PASS");
  });
});

test("A FAILs when the clone stage itself did not pass", () => {
  withFixture({
    artifact: {
      result: "NO-GO",
      blocker: "clone: repository not found",
      stages: [{ name: "container-start", verdict: "PASS" }, { name: "clone", verdict: "NO-GO" }],
    },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("FAIL");
    expect(measured.evidence("A")).toContain("clone stage did not pass (NO-GO)");
  });
});

// Gate D's sentence is only about starting the orchestrator, and gate A judges
// the clone. But "executed against this SHA" reads as a claim about the whole
// run, so when the run's provenance stage is not a clean PASS, D says which part
// of the run it did not read rather than letting the reader assume it did.
test("D names the clone stage it did not read when that stage is not a clean PASS", () => {
  withFixture({
    artifact: {
      stages: [{ name: "clone", verdict: "NO-GO" }, { name: "orchestrator-live", verdict: "PASS" }],
    },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("PASS");
    expect(measured.verdicts.A).toBe("FAIL");
    expect(measured.evidence("D")).toContain("this gate reads only the orchestrator-live stage");
    expect(measured.evidence("D")).toContain("clone stage recorded NO-GO, which gate A judges");
  });
});

test("D says so when the run recorded no clone stage at all", () => {
  withFixture({
    artifact: { stages: GREEN_STAGES.filter((stage) => stage.name !== "clone") },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("PASS");
    expect(measured.evidence("D")).toContain("clone stage is absent, which gate A judges");
  });
});

// A clean run says nothing extra: the caveat is a caveat, not boilerplate.
test("D adds no clone caveat when the run's clone stage passed", () => {
  withFixture({}, (repo) => {
    expect(measure(repo).evidence("D")).not.toContain("this gate reads only");
  });
});

// `finished: true` with `result: NO-GO` is a complete run that refused. Gate A
// is about the whole rebuild, so a refusal anywhere in it is a FAIL even when
// the orchestrator did come up.
test("A FAILs a finished run whose own verdict is NO-GO, even with a live orchestrator", () => {
  withFixture({
    artifact: {
      result: "NO-GO",
      blocker: "unit-drift: rendered units differ from the tracked templates",
      stages: [...GREEN_STAGES, { name: "post-check", verdict: "NO-GO" }],
    },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("FAIL");
    expect(measured.evidence("A")).toContain("the rebuild proof's own verdict is NO-GO");
    expect(measured.evidence("A")).toContain("unit-drift");
    expect(measured.verdicts.D).toBe("PASS");
  });
});

test("A's clean-clone half is UNKNOWN when the tree registers no rebuild runner", () => {
  withFixture({ registry: DEFAULTS.registry.replace("runner:meteorite\trunner\tmeteorite/run.sh\n", "") }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.evidence("A")).toContain("no registered proof mechanism");
  });
});

test("D is UNKNOWN when the tracked tree carries no meteorite at all", () => {
  withFixture({ omit: ["meteorite/run.sh"] }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("absent from the tracked tree");
  });
});

// The artifact's address is the runner's own -- $XDG_STATE_HOME (or
// $HOME/.local/state) plus the tracked path constant -- and nothing else
// participates in resolving it. A reader that resolved it differently would be
// reading a file nothing writes.
test("the artifact is found at the address meteorite/run.sh writes it to", () => {
  withFixture({}, (repo) => {
    const results = withEnv({ XDG_STATE_HOME: stateHomeFor(repo) }, () => checkReadiness(repo));
    expect(results.find((entry) => entry.id === "D")!.verdict).toBe("PASS");
  });
});

// --- round 5's forgery, and the two rules that refuse it --------------------
//
// The fifth review greened gate D and gate A's clean-clone half on this
// repository with one `printf` of 300 bytes at an address it chose, and showed
// that the same file plus two stubs produced `cutover-ready=yes`, exit 0. Both
// halves of that are locked here: the caller no longer chooses the address, and
// a file at the right address is not evidence until origin vouches for it.

test("round 5's forgery, part 1: METEORITE_ARTIFACT no longer selects the proof", () => {
  withFixture({}, (repo) => {
    // The strongest form of the attack: the bytes are the fixture's own real,
    // anchored artifact. Everything about the file is right except that a
    // caller, not the runner's own address, chose it.
    const chosen = join(`${repo}-chosen`, "meteorite-latest.json");
    mkdirSync(join(chosen, ".."), { recursive: true });
    writeFileSync(chosen, readFileSync(artifactPathFor(repo)));
    const empty = `${repo}-empty-state`;
    mkdirSync(empty, { recursive: true });
    try {
      const results = withEnv({ XDG_STATE_HOME: empty, METEORITE_ARTIFACT: chosen }, () => checkReadiness(repo));
      const gateD = results.find((entry) => entry.id === "D")!;
      expect(gateD.verdict).toBe("UNKNOWN");
      expect(gateD.evidence).toContain("does not exist");
      expect(gateD.evidence).not.toContain(chosen);
    } finally {
      rmSync(`${repo}-chosen`, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

test("round 5's forgery, part 2: the reviewer's own printf at the resolved address is unanchored, not evidence", () => {
  withFixture({ anchor: null }, (repo) => {
    const sha = headSha(repo);
    // Verbatim from ag-v3-5.32-r5.review.md finding 1, with this fixture's SHA.
    writeFileSync(
      artifactPathFor(repo),
      `{"schema":"meteorite-result/v1","finished":true,"result":"clean","blocker":"none",`
      + `"requested_sha":"${sha}","tree_sha":"${sha}",`
      + `"stages":[{"name":"clone","verdict":"PASS"},{"name":"orchestrator-live","verdict":"PASS"}],`
      + `"liveness":{"proven":true,"pid":"1"},"finished_at":"2026-08-06T23:00:00Z"}`,
    );
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("present but unanchored, which is not evidence");
    expect(measured.evidence("A")).toContain("present but unanchored, which is not evidence");
    // The whole point of the finding: exit 0 was reachable. It is not.
    expect(measured.exitCode).toBe(1);
    expect(measured.lines.at(-1)).toContain("cutover-ready=no");
  });
});

// A ref name that is the digest of the bytes is what makes an anchor about ONE
// file. Semantically identical JSON with one byte added is a different artifact.
test("an anchor published for other bytes does not vouch for this artifact", () => {
  withFixture({}, (repo) => {
    writeFileSync(artifactPathFor(repo), `${readFileSync(artifactPathFor(repo), "utf8")}\n`);
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("0 of the 2 anchor refs");
  });
});

// The mirror namespace exists so a record forged or suppressed in only one
// namespace is detectable — gate/land.sh's rule, applied to this artifact.
test("an anchor present in only one namespace is not an anchor", () => {
  withFixture({ anchor: { mirror: false } }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("refs/bpa-meteorite-proof-mirrors/");
    expect(measured.evidence("D")).toContain("1 of the 2 anchor refs");
  });
});

test("an anchor pointing at a commit other than the proved one is refused", () => {
  withFixture({ anchor: null }, (repo) => {
    const decoy = git(repo, "commit-tree", `${headSha(repo)}^{tree}`, "-m", "decoy").stdout.toString().trim();
    publishAnchor(repo, { target: decoy });
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("not at the commit the artifact claims to have proved");
  });
});

// gate/land.sh's reason, verbatim in behaviour: local refs — refs/remotes/origin/*
// included — are writable by any lane sharing this Git directory, so only the
// answer ORIGIN gives at the one verified URL is evidence.
test("a locally written ref is not an anchor — only origin's answer is", () => {
  withFixture({ anchor: null }, (repo) => {
    const leaf = `${headSha(repo)}/${sha256Of(artifactPathFor(repo))}`;
    git(repo, "update-ref", `refs/bpa-meteorite-proofs/${leaf}`, headSha(repo));
    git(repo, "update-ref", `refs/bpa-meteorite-proof-mirrors/${leaf}`, headSha(repo));
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("0 of the 2 anchor refs");
  });
});

test("with no origin at all there is nothing to ask, so the artifact stays unanchored", () => {
  withFixture({}, (repo) => {
    git(repo, "remote", "remove", "origin");
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("no single origin");
  });
});

// The pin has one home (instance/params.yaml: repos.git_remote) and gate/land.sh
// reads it from the tracked tree. A checkout pointed somewhere else may not
// launder an anchor through a remote the repository does not vouch for.
test("an origin that contradicts the tracked pin anchors nothing", () => {
  withFixture({}, (repo) => {
    write(repo, "instance/params.yaml", "repos:\n  git_remote: git@example.invalid:pinned.git\n");
    commitAndReanchor(repo);
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("repos.git_remote");
  });
});

test("a pushurl splits publish from read, so it is refused", () => {
  withFixture({}, (repo) => {
    git(repo, "config", "remote.origin.pushurl", originFor(repo));
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("pushurl");
  });
});

// --- round 6's finding: the config underneath the read ----------------------
//
// The sixth review greened D and A on a correctly pinned checkout with ONE
// `git config` write and no credential. The URL string survived all four of
// this reader's checks; what the URL MEANT was rewritten in the shared
// common-dir config, which any lane worktree can write. Both of the reviewer's
// routes are locked here, in the reviewer's own shape, plus the environment
// half of the same surface.

// Route 1: `url.<local path>.insteadOf <origin>` rewrites every URL git
// contacts while `remote.origin.url` still answers the pinned string.
test("round 6's forgery, route 1: url.insteadOf redirects nothing, because the read leaves the repository", () => {
  withFixture({ anchor: null }, (repo) => {
    // The reviewer's exact configuration, not a weaker one: the tree tracks a
    // pin, the pin MATCHES the configured URL, there is one URL and no pushurl.
    // All four of this reader's URL checks pass; only the meaning of the URL is
    // rewritten, and only in the shared config.
    write(repo, "instance/params.yaml", `repos:\n  git_remote: ${originFor(repo)}\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "pin");
    writeArtifact(repo);
    publishAnchor(repo, { remote: bareRepo(forgedOriginFor(repo)) });
    git(repo, "config", `url.${forgedOriginFor(repo)}.insteadOf`, originFor(repo));
    // The rewrite is real, and invisible where this reader used to look: git
    // run INSIDE this repository is answered by the forged repository.
    expect(git(repo, "config", "--get", "remote.origin.url").stdout.toString().trim()).toBe(originFor(repo));
    expect(git(repo, "ls-remote", "--get-url", "origin").stdout.toString().trim()).toBe(forgedOriginFor(repo));
    expect(git(repo, "ls-remote", "--refs", originFor(repo)).stdout.toString()).toContain("refs/bpa-meteorite-proofs/");
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("0 of the 2 anchor refs");
    expect(measured.exitCode).toBe(1);
    expect(measured.lines.at(-1)).toContain("cutover-ready=no");
  });
});

// The reviewer's exact construction: the key is written by a LANE, from its own
// linked worktree, and lands in the common-dir config the canonical checkout
// reads. Nothing tracked changes and no commit is made.
test("round 6's forgery, route 1 as a lane performs it: written from a linked worktree into the shared config", () => {
  withFixture({ anchor: null }, (repo) => {
    publishAnchor(repo, { remote: bareRepo(forgedOriginFor(repo)) });
    const lane = `${repo}-lane`;
    expect(git(repo, "worktree", "add", "-q", "-b", "lane", lane).exitCode).toBe(0);
    expect(git(lane, "config", `url.${forgedOriginFor(repo)}.insteadOf`, originFor(repo)).exitCode).toBe(0);
    // It really is the shared config the canonical checkout reads.
    expect(readFileSync(join(repo, ".git/config"), "utf8")).toContain("insteadOf");
    expect(git(repo, "ls-remote", "--get-url", "origin").stdout.toString().trim()).toBe(forgedOriginFor(repo));
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("0 of the 2 anchor refs");
    expect(porcelain(repo)).toBe("");
  });
});

// Route 2: `core.sshCommand`, which `ls-remote --get-url` cannot see at all,
// and which this installation already sets. The origin URL here is one only
// ssh can reach, so with the config neutralized the read fails instead of being
// answered by the local forgery -- fail-closed, and hermetic: the hostname is
// in the .invalid TLD, so nothing is contacted.
test("round 6's forgery, route 2: core.sshCommand redirects nothing either", () => {
  withFixture({ anchor: null }, (repo) => {
    withEnv({ GIT_SSH_COMMAND: undefined, GIT_SSH: undefined }, () => {
      publishAnchor(repo, { remote: bareRepo(forgedOriginFor(repo)) });
      const fakeSsh = `${repo}-ssh`;
      writeFileSync(fakeSsh, `#!/usr/bin/env bash\nexec git upload-pack '${forgedOriginFor(repo)}'\n`);
      chmodSync(fakeSsh, 0o755);
      git(repo, "config", "remote.origin.url", "ssh://git@no-such-host.invalid/repo.git");
      git(repo, "config", "core.sshCommand", fakeSsh);
      // The redirect is invisible in the URL and real in the transport.
      expect(git(repo, "ls-remote", "--get-url", "origin").stdout.toString().trim()).toBe("ssh://git@no-such-host.invalid/repo.git");
      expect(git(repo, "ls-remote", "--refs", "origin").stdout.toString()).toContain("refs/bpa-meteorite-proofs/");
      const measured = measure(repo);
      expect(measured.verdicts.D).toBe("UNKNOWN");
      expect(measured.verdicts.A).toBe("UNKNOWN");
      expect(measured.evidence("D")).toContain("could not be asked");
      expect(measured.exitCode).toBe(1);
    });
  });
});

// The same rewrite, arriving from the environment instead of from a file. This
// one runs the COMMAND as a subprocess with the hostile environment, because an
// environment is inherited at process start: mutating process.env in this
// process does not reach a child that inherits the original environ, so an
// in-process construction would pass for the wrong reason. The artifact here is
// genuinely anchored at origin, so a rewrite that reached the read would move D
// off PASS -- staying PASS is the property.
test("a hostile inherited environment does not reach the anchor read", () => {
  withFixture({}, (repo) => {
    const hostile = `${repo}-gitconfig`;
    writeFileSync(hostile, `[url "${bareRepo(forgedOriginFor(repo))}"]\n\tinsteadOf = ${originFor(repo)}\n`);
    const run = Bun.spawnSync([process.execPath, join(REAL_REPO, "tools/check-cutover-readiness.ts"), "--repo", repo], {
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHomeFor(repo),
        GIT_CONFIG_GLOBAL: hostile,
        GIT_CONFIG_SYSTEM: hostile,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${forgedOriginFor(repo)}.insteadOf`,
        GIT_CONFIG_VALUE_0: originFor(repo),
      },
    });
    expect(run.stdout.toString()).toContain("CUTOVER-READINESS D PASS");
    expect(run.stdout.toString()).toContain("CUTOVER-READINESS A PASS");
    expect(run.exitCode).toBe(0);
  });
});

test("the anchor read's environment carries no repository or configuration override", () => {
  const env = withEnv(
    {
      GIT_DIR: "/tmp/elsewhere.git",
      GIT_WORK_TREE: "/tmp/elsewhere",
      GIT_CONFIG: "/tmp/rewrite",
      GIT_CONFIG_GLOBAL: "/tmp/rewrite",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "url./tmp/forged.git.insteadOf",
      GIT_CONFIG_VALUE_0: "git@github.com:vovaBPApro/bpa-dev-infrastructure.git",
      GIT_TEMPLATE_DIR: "/tmp/hostile-template",
    },
    () => anchorReadEnv(),
  );
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_TEMPLATE_DIR"]) {
    expect(env[name]).toBeUndefined();
  }
  expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
  expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
  expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  // PATH and the ssh transport are deliberately the caller's: whoever sets them
  // already chooses which `git` runs, and a working GIT_SSH_COMMAND is how a
  // suite proves this file touches no network.
  expect(env.PATH).toBe(process.env.PATH);
});

// --- round 7's finding: the context the read runs IN ------------------------
//
// The sixth recut moved the read out of the repository and ASSERTED its scratch
// cwd was inside no worktree, using `git rev-parse --show-toplevel`. The seventh
// review defeated the assertion with a BARE repository: it has no worktree, so
// the probe exits non-zero and the guard reads that as "outside", while
// `ls-remote` walking up from the same cwd still finds it as GIT_DIR and still
// honors its `insteadOf`. The read no longer asserts anything about its
// surroundings -- it names a repository this command created, through GIT_DIR --
// so these lock the property that ancestors are not consulted at all.

// Run a plain `git` in a chosen directory with the ambient config neutralized
// exactly as the anchor read neutralizes it, to establish what a read that
// DISCOVERED its context would have been answered.
function gitFrom(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_DIR: undefined, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as Record<string, string>,
  });
}

// The reviewer's construction, whole: a bare repository at the temp root the
// scratch directory is created under. Planting it is `git init --bare` plus one
// config line against a world-writable directory -- no credential, no push to
// origin, nothing tracked changed.
test("round 7's forgery: a bare repository at the scratch directory's temp root redirects nothing", () => {
  withFixture({ anchor: null }, (repo) => {
    publishAnchor(repo, { remote: bareRepo(forgedOriginFor(repo)) });
    const tmproot = bareRepo(`${repo}-tmproot.git`);
    Bun.spawnSync(["git", "--git-dir", tmproot, "config", `url.${forgedOriginFor(repo)}.insteadOf`, originFor(repo)]);
    const scratch = join(tmproot, "scratch");
    mkdirSync(scratch, { recursive: true });
    // The redirect is real: a read that DISCOVERS its context from this cwd is
    // answered by the forged repository while being asked for origin.
    expect(gitFrom(scratch, "ls-remote", "--refs", originFor(repo)).stdout.toString()).toContain("refs/bpa-meteorite-proofs/");
    // And it is invisible to the probe round 7 relied on: a bare repository has
    // no worktree, so `--show-toplevel` fails and "outside a repository" was
    // exactly the wrong conclusion to draw from that failure.
    expect(gitFrom(scratch, "rev-parse", "--show-toplevel").exitCode).not.toBe(0);
    expect(gitFrom(scratch, "rev-parse", "--absolute-git-dir").stdout.toString().trim()).toBe(tmproot);
    const measured = withEnv({ TMPDIR: scratch }, () => measure(repo));
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("0 of the 2 anchor refs");
    expect(measured.exitCode).toBe(1);
    expect(porcelain(repo)).toBe("");
  });
});

// The same shape one level less exotic: a non-bare enclosing worktree, which is
// what the sixth recut's probe DID catch. It is re-locked here against the owned
// context, and the property is stronger than "refused" -- the redirect fails
// because the enclosing repository is never consulted.
test("a hostile enclosing worktree at the temp root redirects nothing either", () => {
  withFixture({ anchor: null }, (repo) => {
    publishAnchor(repo, { remote: bareRepo(forgedOriginFor(repo)) });
    const enclosing = `${repo}-tmproot`;
    const scratch = join(enclosing, "tmp");
    mkdirSync(scratch, { recursive: true });
    git(enclosing, "init", "-q");
    git(enclosing, "config", `url.${forgedOriginFor(repo)}.insteadOf`, originFor(repo));
    expect(gitFrom(scratch, "ls-remote", "--refs", originFor(repo)).stdout.toString()).toContain("refs/bpa-meteorite-proofs/");
    const measured = withEnv({ TMPDIR: scratch }, () => measure(repo));
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("0 of the 2 anchor refs");
  });
});

// The other half of owning the context rather than asserting about it: an
// enclosing repository is not a reason to REFUSE either. A genuinely anchored
// artifact is still read, from a temp root inside a checkout, because what that
// checkout says was never consulted in the first place.
test("an enclosing repository does not stop the genuine anchor from being read", () => {
  withFixture({}, (repo) => {
    const enclosing = `${repo}-tmproot`;
    const scratch = join(enclosing, "tmp");
    mkdirSync(scratch, { recursive: true });
    git(enclosing, "init", "-q");
    const measured = withEnv({ TMPDIR: scratch }, () => measure(repo));
    expect(measured.verdicts.D).toBe("PASS");
    expect(measured.verdicts.A).toBe("PASS");
    expect(measured.exitCode).toBe(0);
  });
});

// `git init` copies a template directory into the new repository BEFORE writing
// core.*, and a template `config` file survives that copy -- so a template is a
// config injection route into the very context this command creates. TWO guards
// close it and EITHER ALONE SUFFICES, which this end-to-end case cannot tell
// apart: GIT_TEMPLATE_DIR is deleted from the child environment (locked
// separately by the environment case below) and `--template` names an empty
// owned directory, overriding it. The structural half of the second guard --
// that the owned context really is built from that empty template and not from
// this host's compiled-in default -- is locked in the context case below.
test("a hostile git template cannot plant configuration in the owned git context", () => {
  withFixture({ anchor: null }, (repo) => {
    publishAnchor(repo, { remote: bareRepo(forgedOriginFor(repo)) });
    const template = `${repo}-template`;
    mkdirSync(template, { recursive: true });
    writeFileSync(join(template, "config"), `[url "${forgedOriginFor(repo)}"]\n\tinsteadOf = ${originFor(repo)}\n`);
    // The template really does inject into a repository initialized with it.
    const planted = `${repo}-planted.git`;
    Bun.spawnSync(["git", "init", "--bare", "-q", `--template=${template}`, planted]);
    expect(readFileSync(join(planted, "config"), "utf8")).toContain("insteadOf");
    const measured = withEnv({ GIT_TEMPLATE_DIR: template }, () => measure(repo));
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("0 of the 2 anchor refs");
  });
});

// The context itself: built inside its own fresh directory, from an empty
// template, free of everything that could rewrite a URL, and named explicitly
// so no discovery runs.
//
// What this does NOT claim to lock, stated rather than implied: the exclusive
// `mkdirSync` (no `recursive`) in anchorReadContext. mkdtemp(2) already
// guarantees the parent directory is new, so no reachable input makes that path
// pre-exist and no test here can force it. It is defense in depth behind
// mkdtemp's own guarantee, not an independently verified property.
test("the anchor read's git context is created by this command, bare, template-free, and free of rewrites", () => {
  const built = anchorReadContext();
  expect("gitDir" in built).toBe(true);
  const context = built as { dir: string; gitDir: string };
  try {
    expect(context.gitDir.startsWith(context.dir)).toBe(true);
    // Built from the empty template this command created, not from whatever
    // template dir this host compiled in: git copies a template BEFORE writing
    // core.*, so a template `config` would be config in the owned context. The
    // tell is structural rather than a scan for known keys -- the default
    // template populates hooks/, and an empty one leaves no hooks/ at all.
    expect(existsSync(join(context.gitDir, "hooks"))).toBe(false);
    expect(new Set(readdirSync(context.gitDir))).toEqual(new Set(["config", "HEAD", "objects", "refs"]));
    const listed = Bun.spawnSync(["git", "--git-dir", context.gitDir, "config", "--local", "--list"]).stdout.toString();
    expect(listed).toContain("core.bare=true");
    expect(listed).not.toContain("insteadof");
    expect(listed).not.toContain("sshcommand");
    // Named explicitly, which is what makes discovery -- and therefore every
    // ancestor of the cwd, bare or not -- irrelevant.
    expect(anchorReadEnv(context.gitDir).GIT_DIR).toBe(context.gitDir);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

// A URL only the checkout could resolve names nothing where the question is
// asked, so it is refused in its own words rather than as an unreadable remote.
test("an origin relative to the checkout is refused, not asked from somewhere else", () => {
  withFixture({}, (repo) => {
    git(repo, "config", "remote.origin.url", "sibling-origin.git");
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("relative to the checkout");
  });
});

// An anchored PASS must be re-derivable by the next reader without trusting this
// host: one `git ls-remote origin <ref>`, and the ref is printed.
test("the evidence names the anchor ref a reviewer can re-derive the verdict from", () => {
  withFixture({}, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("PASS");
    expect(measured.evidence("D")).toContain(`anchored at refs/bpa-meteorite-proofs/${headSha(repo)}/`);
    expect(measured.evidence("D")).toContain(sha256Of(artifactPathFor(repo)));
  });
});

// --- no sentence in the meteorite moves D or A ------------------------------
//
// Every spelling that greened one of these gates in rounds 1-4 is here, and the
// property under test is stronger than "it no longer greens them": the text is
// not read at all. The same tree, with the same words, is PASS or UNKNOWN
// depending only on whether a run happened.

const FORGERIES: Record<string, string> = {
  "a comment naming the launcher": meteoriteWith(CLONE_STAGE, "# runs orchestrator/launch.sh and checks the lease"),
  "an echo about the launcher": meteoriteWith(CLONE_STAGE, `"advice|echo 'now run orchestrator/launch.sh by hand'"`),
  "a stage that deletes the liveness marker": meteoriteWith(CLONE_STAGE, `"teardown|rm -f /run/orchestrator.lease"`),
  "a bare assignment": meteoriteWith(CLONE_STAGE, `"start|PROOF=meteorite/assert-orchestrator-live.sh"`),
  "an env-prefix stage": meteoriteWith(CLONE_STAGE, `"start|PROOF=meteorite/assert-orchestrator-live.sh bash bootstrap/check-unit-drift.sh"`),
  "a stage that discards the proof's verdict": meteoriteWith(CLONE_STAGE, `"cleanup|bash meteorite/assert-orchestrator-live.sh >/dev/null 2>&1 || true; echo 'we do not care whether it started'"`),
  "a stage that runs the proof and then aborts": meteoriteWith(CLONE_STAGE, '"orchestrator-start|bash meteorite/assert-orchestrator-live.sh"', '"later|exit 3"'),
  "the suite stage that runs the proof's own regression lock": meteoriteWith(CLONE_STAGE, '"full-test-suite|bun test"'),
  "no stage list this parser could read at all": "#!/usr/bin/env bash\necho 'the meteorite starts the orchestrator and asserts a live state'\n",
  "no stages at all": meteoriteWith(),
};

test("no text in the meteorite can green D or A when no run happened", () => {
  for (const [label, meteorite] of Object.entries(FORGERIES)) {
    withFixture({ meteorite, artifact: null }, (repo) => {
      const measured = measure(repo);
      expect({ label, D: measured.verdicts.D, A: measured.verdicts.A }).toEqual({ label, D: "UNKNOWN", A: "UNKNOWN" });
      expect(measured.evidence("D")).toContain("no rehearsal artifact at this SHA");
      expect(measured.exitCode).toBe(1);
    });
  }
});

test("no text in the meteorite can redden D or A when the run says otherwise", () => {
  for (const [label, meteorite] of Object.entries(FORGERIES)) {
    withFixture({ meteorite }, (repo) => {
      const measured = measure(repo);
      expect({ label, D: measured.verdicts.D, A: measured.verdicts.A }).toEqual({ label, D: "PASS", A: "PASS" });
    });
  }
});

// The mirror image, and the reason the two tests above are one property: a
// meteorite whose text is impeccable is FAILed by its own recorded run.
test("an impeccably worded meteorite still FAILs on the run it actually had", () => {
  const worded = meteoriteWith(
    CLONE_STAGE,
    '"orchestrator-start|bash orchestrator/launch.sh start"',
    '"liveness|bash orchestrator/status.sh"',
  );
  withFixture({
    meteorite: worded,
    artifact: {
      stages: [{ name: "clone", verdict: "PASS" }, { name: "full-test-suite", verdict: "PASS" }],
      liveness: { proven: false, reason: "stage-not-reached" },
    },
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("finished without running a orchestrator-live stage at all");
  });
});

// --- gate E: absent inputs, judged in two worlds -----------------------------
//
// Round 2 greened this gate with the token UNKNOWN in output; round 3 greened
// it with one UNKNOWN finding printed beside PASS findings on the same
// inputless run; round 4 observed that a checker answering UNKNOWN to
// everything greened it while measuring nothing. The green now needs an
// inputless world with UNKNOWN and no PASS, an exit status that moves with
// --strict there, and a non-UNKNOWN outcome against the tracked tree.

test("E PASSes on behaviour: UNKNOWN where the inputs are absent, a measurement where they are not", () => {
  withFixture({}, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("PASS");
    expect(measured.evidence("E")).toContain("reports UNKNOWN and never PASS against a tree whose inputs are absent");
    expect(measured.evidence("E")).toContain("its exit status moves with --strict (1 strict, 0 lenient)");
    expect(measured.evidence("E")).toContain("discriminates rather than answering a constant");
  });
});

test("E FAILs when a check with absent inputs still passes", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconsole.log("PASS nothing to check");\n' }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("emits no UNKNOWN outcome");
  });
});

test("E is not satisfied by the word UNKNOWN in a comment", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\n// TODO: UNKNOWN not implemented yet\nconsole.log("PASS everything is fine");\n' }, (repo) => {
    expect(measure(repo).verdicts.E).toBe("FAIL");
  });
});

test("E is not satisfied by an UNKNOWN in a string the checker never prints", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconst unused = "UNKNOWN";\nconsole.log("PASS");\n' }, (repo) => {
    expect(measure(repo).verdicts.E).toBe("FAIL");
  });
});

test("E FAILs a checker whose only UNKNOWN is a legend line", () => {
  withFixture({
    ledgerChecker: '#!/usr/bin/env bun\nconsole.log("legend: PASS | FAIL | UNKNOWN");\nconsole.log("summary: 0 FAIL");\nprocess.exit(0);\n',
  }, (repo) => {
    expect(measure(repo).verdicts.E).toBe("FAIL");
  });
});

test("E FAILs a checker whose only UNKNOWN is a warning on stderr", () => {
  withFixture({
    ledgerChecker: '#!/usr/bin/env bun\nconsole.error("warn: UNKNOWN option ignored");\nprocess.exit(0);\n',
  }, (repo) => {
    expect(measure(repo).verdicts.E).toBe("FAIL");
  });
});

test("E FAILs when the findings and the summary disagree about UNKNOWN", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("UNKNOWN instructions/ [root] directory not found");',
      'console.log("summary: 0 FAIL, 0 WARN, 0 SKIP, 0 UNKNOWN, 0 PASS (0 docs)");',
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("its own summary counts as zero");
  });
});

// Round-3 finding 2, locked: one UNKNOWN finding beside PASS findings on the
// same inputless run is the violation, not a defence. All outcomes are read.
test("E FAILs a checker that prints PASS findings beside its one UNKNOWN", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("PASS instructions/ [root] all documents valid");',
      'console.log("PASS instance/decisions [ledger] all states known");',
      'console.log("UNKNOWN tools/x.ts [experimental] not implemented");',
      'console.log("summary: 0 FAIL, 0 WARN, 0 SKIP, 1 UNKNOWN, 2 PASS (0 docs)");',
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("reports PASS against a tree whose inputs are absent");
    expect(measured.exitCode).toBe(1);
  });
});

test("E FAILs when the structured channel itself carries a PASS beside its UNKNOWN", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      "const channel = process.env.CHECK_OUTCOMES_JSON;",
      "if (channel) await Bun.write(channel, JSON.stringify({ findings: [",
      '  { level: "UNKNOWN", file: "instructions/" },',
      '  { level: "PASS", file: "instance/decisions" },',
      '  { level: "PASS", file: "instance/params.yaml" },',
      "] }));",
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("reports PASS against a tree whose inputs are absent");
  });
});

// A channel that under-reports does not launder the printed PASS beside it:
// every channel the checker used is read, and a PASS anywhere is the violation.
test("E FAILs when the channel says UNKNOWN-only but the checker prints a PASS finding", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("PASS instructions/ [root] all documents valid");',
      "const channel = process.env.CHECK_OUTCOMES_JSON;",
      'if (channel) await Bun.write(channel, JSON.stringify({ findings: [{ level: "UNKNOWN", file: "instructions/" }] }));',
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("reports PASS against a tree whose inputs are absent");
  });
});

// Round-4 finding 2: one world cannot tell a checker from a constant. This is
// that finding's exact reproduction — a checker whose entire body reports
// UNKNOWN — and the second world is what kills it.
test("E FAILs a checker that answers UNKNOWN to everything, including where the inputs are there", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("UNKNOWN everything [always] this checker never measures anything");',
      'console.log("summary: 0 FAIL, 1 UNKNOWN, 0 WARN, 0 SKIP, 0 PASS (0 docs)");',
      "const channel = process.env.CHECK_OUTCOMES_JSON;",
      'if (channel) await Bun.write(channel, JSON.stringify({ findings: [{ level: "UNKNOWN", file: "everything" }] }));',
      'process.exit(process.argv.includes("--strict") ? 1 : 0);',
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("answers UNKNOWN for all");
    expect(measured.evidence("E")).toContain("a checker that never measures anything");
    expect(measured.exitCode).toBe(1);
  });
});

// The exit status is the part of the outcome no printed line can forge, so it
// has to move: a checker that reports UNKNOWN and calls the run a success has
// not made UNKNOWN an outcome.
test("E FAILs a checker that reports UNKNOWN and still exits 0 under --strict", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("UNKNOWN instructions/ [root] directory not found");',
      'console.log("summary: 0 FAIL, 1 UNKNOWN, 0 WARN, 0 SKIP, 0 PASS (0 docs)");',
      "process.exit(0);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("still exits 0 under --strict");
    expect(measured.evidence("E")).toContain("a word, not an outcome");
  });
});

test("E is UNKNOWN when the checker blocks with and without --strict, so nothing isolates the UNKNOWN", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("UNKNOWN instructions/ [root] directory not found");',
      'console.log("summary: 0 FAIL, 1 UNKNOWN, 0 WARN, 0 SKIP, 0 PASS (0 docs)");',
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("UNKNOWN");
    expect(measured.evidence("E")).toContain("blocks on the inputless tree with and without --strict");
  });
});

test("E is UNKNOWN when a FAIL outcome sits beside the UNKNOWN on the inputless tree", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("UNKNOWN instructions/ [root] directory not found");',
      'console.log("FAIL instructions/ [root] directory not found");',
      'console.log("summary: 1 FAIL, 1 UNKNOWN, 0 WARN, 0 SKIP, 0 PASS (0 docs)");',
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("UNKNOWN");
    expect(measured.evidence("E")).toContain("cannot show that the UNKNOWN is what blocks");
  });
});

// The structured channel is stronger evidence and is still read whole wherever
// it is offered — but a checker that reports honestly on stdout and blocks on
// its own UNKNOWN has produced an outcome. tools/instructions/check.ts, which
// landed that outcome under V3-5.44, publishes no channel.
test("a checker with no structured channel can green the gate on its outcomes and its exit status", () => {
  withFixture({ ledgerChecker: checkerScript({ channel: false }) }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("PASS");
    expect(measured.evidence("E")).toContain("no structured outcome channel");
    expect(measured.evidence("E")).toContain("its exit-code policy carries the claim instead");
  });
});

test("a structured channel this gate cannot read is UNKNOWN, never PASS", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      "const channel = process.env.CHECK_OUTCOMES_JSON;",
      'if (channel) await Bun.write(channel, "not json at all");',
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("UNKNOWN");
    expect(measured.evidence("E")).toContain("cannot read");
  });
});

test("a structured channel with no UNKNOWN outcome is FAIL", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      "const channel = process.env.CHECK_OUTCOMES_JSON;",
      'if (channel) await Bun.write(channel, JSON.stringify({ findings: [{ level: "SKIP", file: "instructions/" }] }));',
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("emits no UNKNOWN outcome");
  });
});

// The world the checker is probed in announces itself as an installation whose
// inputs are absent — an instructions/ layer and an instance/ layer, both
// empty. A bare empty directory would probe the one case the checker's own
// vocabulary is entitled to call SKIP (no instance/ layer means no
// installation), which is not the case gate E is about.
test("the inputless world is an installation, not a repository that declares nothing", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'import { existsSync } from "node:fs";',
      'import { join } from "node:path";',
      "const argv = process.argv.slice(2);",
      'const repo = argv[argv.indexOf("--repo") + 1] ?? ".";',
      'const installation = existsSync(join(repo, "instance"));',
      'const input = existsSync(join(repo, "instance/params.yaml"));',
      'const level = input ? "PASS" : installation ? "UNKNOWN" : "SKIP";',
      'console.log(`${level} instance/params.yaml [ledger] ${installation ? "installation" : "no instance layer"}`);',
      "console.log(`\\nsummary: 0 FAIL, ${level === \"UNKNOWN\" ? 1 : 0} UNKNOWN, 0 WARN, 0 SKIP, 0 PASS (0 docs)`);",
      'process.exit(level === "UNKNOWN" && argv.includes("--strict") ? 1 : 0);',
    ].join("\n"),
  }, (repo) => {
    expect(measure(repo).verdicts.E).toBe("PASS");
  });
});

test("the finding grammar reads the level column, not the line", () => {
  expect(probeOutcome("UNKNOWN instructions/ [root] directory not found").findings).toEqual([{ level: "UNKNOWN", file: "instructions/" }]);
  expect(probeOutcome("legend: PASS | FAIL | UNKNOWN").findings).toEqual([]);
  expect(probeOutcome("warn: UNKNOWN option ignored").findings).toEqual([]);
  expect(probeOutcome("  UNKNOWN indented [check] detail").findings).toEqual([]);
  expect(probeOutcome("summary: 0 FAIL, 3 UNKNOWN, 0 PASS").countedUnknown).toBe(3);
  expect(probeOutcome("summary: 0 FAIL, 0 PASS").countedUnknown).toBe(null);
});

test("a probe that has to be killed is UNKNOWN, never PASS — a kill is not a pass", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconsole.log("UNKNOWN");\nawait Bun.sleep(60_000);\n' }, (repo) => {
    const previous = process.env.CUTOVER_PROBE_TIMEOUT_MS;
    process.env.CUTOVER_PROBE_TIMEOUT_MS = "700";
    try {
      const measured = measure(repo);
      expect(measured.verdicts.E).toBe("UNKNOWN");
      expect(measured.evidence("E")).toContain("killed");
    } finally {
      if (previous === undefined) delete process.env.CUTOVER_PROBE_TIMEOUT_MS;
      else process.env.CUTOVER_PROBE_TIMEOUT_MS = previous;
    }
  });
});

test("E stays FAIL even when the checkout-parity mechanism is registered", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconsole.log("PASS nothing to check");\n' }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).not.toContain("checkout-parity");
  });
});

// --- gate F: host state enumerated ------------------------------------------

test("F FAILs without a tracked host-state inventory", () => {
  withFixture({ omit: ["instance/host-state.tsv"] }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.F).toBe("FAIL");
    expect(measured.evidence("F")).toContain("instance/host-state.tsv");
  });
});

test("F FAILs when an enumerated item carries no verifying command", () => {
  withFixture({ hostState: "bot-token\t/root/.config/bpa/orchestrator.env\n" }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.F).toBe("FAIL");
    expect(measured.evidence("F")).toContain("without a verifying command");
  });
});

// --- gate G: the runtime models come up, judged by execution -----------------

test("G FAILs when nothing on the clean-server path even names the Whisper installer", () => {
  withFixture({ bootstrap: "echo installing everything except whisper\n", meteorite: meteoriteWith(CLONE_STAGE) }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("FAIL");
    expect(measured.evidence("G")).toContain("comes up without Whisper");
  });
});

test("G is not satisfied by a TODO comment naming the installer", () => {
  withFixture({ bootstrap: "# TODO: run tools/whisper/install.sh someday\n" }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("FAIL");
    expect(measured.evidence("G")).toContain("comes up without Whisper");
  });
});

test("G is not satisfied by a usage banner that mentions the installer", () => {
  withFixture({
    bootstrap: ["usage() {", "  cat <<'EOF'", "Stage 2 does not run tools/whisper/install.sh yet.", "EOF", "}", "usage", ""].join("\n"),
  }, (repo) => {
    expect(measure(repo).verdicts.G).toBe("FAIL");
  });
});

test("G is not satisfied by a trailing comment on an executable line", () => {
  withFixture({ bootstrap: 'echo "stage 2" # later: bash tools/whisper/install.sh\n' }, (repo) => {
    expect(measure(repo).verdicts.G).toBe("FAIL");
  });
});

// An executable line that NAMES the installer licenses executing the script —
// and the execution, not the mention, decides. An echo runs and installs
// nothing.
test("G FAILs a bootstrap that mentions the installer but, executed, never runs it", () => {
  withFixture({ bootstrap: 'echo "see tools/whisper/install.sh for details"\n' }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("FAIL");
    expect(measured.evidence("G")).toContain("executed to completion in the rehearsal world, never ran it");
  });
});

// Round-3 finding 1's gate-G reproductions: assignments naming the installer.
// The lines execute — and run nothing, so the journal stays empty.
test("an assignment naming the installer does not green G", () => {
  const bootstraps = [
    "NOT_DONE_YET=tools/whisper/install.sh\n",
    '#!/usr/bin/env bash\nSOURCE_ROOT="$(dirname "$0")/.."\nWHISPER_INSTALLER=$SOURCE_ROOT/tools/whisper/install.sh\necho "stage 2 does not run it yet"\n',
  ];
  for (const bootstrap of bootstraps) {
    withFixture({ bootstrap }, (repo) => {
      const measured = measure(repo);
      expect(measured.verdicts.G).toBe("FAIL");
      expect(measured.evidence("G")).toContain("never ran it");
      expect(measured.exitCode).toBe(1);
    });
  }
});

test("G PASSes when the clean-server install path, executed, runs the installer", () => {
  withFixture({}, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("PASS");
    expect(measured.evidence("G")).toContain("executed in the rehearsal world, ran tools/whisper/install.sh");
  });
});

// The meteorite arm was a second rehearsal and is gone with the rest of that
// machinery. A Whisper stage in the rebuild proof is still real evidence — it
// is simply evidence this command cannot reach, because the rebuild artifact
// records stage verdicts and liveness, not which installer a stage invoked.
// UNKNOWN, never PASS, and it says which path it could have executed.
test("a Whisper mention only in the meteorite is UNKNOWN — real evidence this command cannot measure", () => {
  const withWhisper = meteoriteWith(CLONE_STAGE, '"whisper|bash tools/whisper/install.sh"');
  withFixture({ bootstrap: "echo nothing here\n", meteorite: withWhisper }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("UNKNOWN");
    expect(measured.evidence("G")).toContain("no longer executes meteorite/run.sh in any form");
    expect(measured.evidence("G")).toContain("bootstrap/install.sh");
    expect(measured.exitCode).toBe(1);
  });
});

// FAIL beats UNKNOWN, here as everywhere else in this file. The bootstrap arm
// names the installer and, executed to completion, never runs it — an observed
// violation. The meteorite arm can now never be anything but UNKNOWN, and it
// used to swallow that FAIL, so the gate reported "unmeasured" about a thing it
// had measured.
test("an observed bootstrap violation surfaces even beside an unmeasurable meteorite arm", () => {
  const withWhisper = meteoriteWith(CLONE_STAGE, '"whisper|bash tools/whisper/install.sh"');
  withFixture({ bootstrap: 'echo "see tools/whisper/install.sh for details"\n', meteorite: withWhisper }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("FAIL");
    expect(measured.evidence("G")).toContain("executed to completion in the rehearsal world, never ran it");
    // The unmeasurable sibling is still reported; it is simply not the verdict.
    expect(measured.evidence("G")).toContain("no longer executes meteorite/run.sh in any form");
    expect(measured.exitCode).toBe(1);
  });
});

test("an env-prefix stage naming the installer greens nothing either", () => {
  const meteorite = meteoriteWith(CLONE_STAGE, '"whisper|WHISPER_INSTALLER=tools/whisper/install.sh bash bootstrap/check-unit-drift.sh"');
  withFixture({ bootstrap: "echo nothing here\n", meteorite }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).not.toBe("PASS");
    expect(measured.exitCode).toBe(1);
  });
});

test("G is not satisfied by a comment inside the meteorite's stage list", () => {
  const commented = meteoriteWith(CLONE_STAGE, "# TODO: bash tools/whisper/install.sh");
  withFixture({ bootstrap: "echo nothing here\n", meteorite: commented }, (repo) => {
    expect(measure(repo).verdicts.G).toBe("FAIL");
  });
});

test("a bootstrap that aborts before any Whisper invocation is UNKNOWN, never PASS", () => {
  withFixture({
    bootstrap: '#!/usr/bin/env bash\nexit 3\nbash "$(dirname "$0")/../tools/whisper/install.sh"\n',
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("UNKNOWN");
    expect(measured.evidence("G")).toContain("aborted (exit 3");
    expect(measured.exitCode).toBe(1);
  });
});

test("G is UNKNOWN when the clean-server install path cannot be read", () => {
  withFixture({ omit: ["bootstrap/install.sh"] }, (repo) => {
    expect(measure(repo).verdicts.G).toBe("UNKNOWN");
  });
});

// --- the rehearsal world's bun is a shim, not an oracle ----------------------
//
// The world shims the boundary the rehearsed script talks THROUGH. That was the
// whole of bun's role until the shared dependency materializer landed
// (a3731a8); since then bootstrap also uses bun as the INTERPRETER whose exit
// code answers a question about the tracked tree -- `bun -e <program>
// <manifest>`: 0 declares dependencies, 1 declares none, 2 unreadable. The
// world's old blanket `exit 0` answered YES to every question asked, so it
// claimed the root package.json declares dependencies when it declares none,
// and the materializer correctly refused a declaring workspace with no tracked
// lockfile. Gate G then reported UNKNOWN about a repository that was fine.
//
// Each case below is UNKNOWN with the blanket shim and PASS without it, except
// the last two, which are the protections that must survive the repair.

// The narrowest statement of the property, with no materializer in the way: an
// exit code the world's bun reports is the program's own. A blanket `exit 0`
// collapses all three answers of the contract into "yes".
test("an exit code the world's bun reports is the program's own, not a blanket zero", () => {
  const bootstrap = [
    "#!/usr/bin/env bash",
    "for code in 0 1 2; do",
    '  bun -e "process.exit($code)"',
    '  [ "$?" = "$code" ] || exit 70',
    "done",
    'bash "$(dirname "$0")/../tools/whisper/install.sh"',
    "",
  ].join("\n");
  withFixture({ bootstrap }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("PASS");
    expect(measured.evidence("G")).toContain("ran tools/whisper/install.sh");
  });
});

// The real materializer, sourced from this repository rather than restated, so
// these cases measure the boundary bootstrap actually crosses instead of a
// retelling of it. It needs only $BUN_BIN, git and mktemp, and `command -v bun`
// inside the world resolves to the shim under test.
function materializingBootstrap(): string {
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    'source "$(dirname "$0")/../gate/land-lib.sh"',
    'BUN_BIN="$(command -v bun)"',
    'land_materialize_dependencies "${INSTALL_ROOT:-$(dirname "$0")/..}" BOOTSTRAP || exit 1',
    'bash "$(dirname "$0")/../tools/whisper/install.sh"',
    "",
  ].join("\n");
}

function withLandLib(tracked: Record<string, string>): Record<string, string> {
  return { "gate/land-lib.sh": readFileSync(join(REAL_REPO, "gate/land-lib.sh"), "utf8"), ...tracked };
}

// The reported failure, reproduced in miniature and then repaired. A root
// manifest that declares NO dependencies, and no root lockfile -- which is this
// repository's own shape, where the only tracked lockfile is daemon/bun.lock.
// With a blanket-oracle world this aborts `workspace=. detail=lockfile-not-tracked
// lockfile=bun.lock` and gate G is UNKNOWN; with a bun that answers the question
// it was asked, the root workspace is skipped and the rehearsal reaches the
// Whisper question gate G exists to ask.
test("a root manifest declaring no dependencies does not need a lockfile the tree never had", () => {
  withFixture({
    bootstrap: materializingBootstrap(),
    tracked: withLandLib({ "package.json": `${JSON.stringify({ name: "fixture" }, null, 2)}\n` }),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("PASS");
    expect(measured.evidence("G")).toContain("ran tools/whisper/install.sh");
    // The diagnosis in one assertion: with a truthful bun there is no
    // `workspace=.` line at all, because the root workspace is never a
    // candidate for installation.
    expect(measured.evidence("G")).not.toContain("lockfile-not-tracked");
    expect(measured.evidence("G")).not.toContain("workspace=.");
  });
});

// An empty dependency object is a declaration of nothing, and the contract says
// so by counting keys. Locked because "has the key" is the obvious wrong
// reading, and it would re-create the same false abort.
test("empty dependency objects still declare nothing", () => {
  const manifest = { name: "fixture", dependencies: {}, devDependencies: {}, optionalDependencies: {} };
  withFixture({
    bootstrap: materializingBootstrap(),
    tracked: withLandLib({ "package.json": `${JSON.stringify(manifest, null, 2)}\n` }),
  }, (repo) => {
    expect(measure(repo).verdicts.G).toBe("PASS");
  });
});

// --- what the repair must NOT weaken ----------------------------------------

// The materializer's actual protection, exercised through the repaired shim: a
// workspace that genuinely declares dependencies and has no tracked lockfile is
// still refused, and still named. If the shim ever answers this question
// dishonestly in the other direction, this is the test that goes red.
test("a workspace that really declares dependencies with no tracked lockfile still reds", () => {
  const manifest = { name: "fixture-ws", dependencies: { zod: "^3.0.0" } };
  withFixture({
    bootstrap: materializingBootstrap(),
    tracked: withLandLib({
      "package.json": `${JSON.stringify({ name: "fixture" }, null, 2)}\n`,
      "fixture-ws/package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    }),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("UNKNOWN");
    expect(measured.evidence("G")).toContain("workspace=fixture-ws");
    expect(measured.evidence("G")).toContain("detail=lockfile-not-tracked");
    expect(measured.evidence("G")).toContain("lockfile=fixture-ws/bun.lock");
    expect(measured.exitCode).toBe(1);
  });
});

// A malformed manifest must reach the materializer as 2 (unreadable), not as
// either of the two answers about dependencies. Under the blanket shim every
// malformed manifest read as "declares"; under a shim that swallowed the exit
// code the other way it would read as "declares none" and the workspace would
// be silently skipped, which is the fail-open version of the same bug.
test("an unreadable manifest is named as unreadable, not silently skipped", () => {
  withFixture({
    bootstrap: materializingBootstrap(),
    tracked: withLandLib({ "package.json": "{ this is not json\n" }),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("UNKNOWN");
    expect(measured.evidence("G")).toContain("detail=manifest-unreadable");
  });
});

// Hermeticity, which is the reason the world had a shim in the first place.
// Only evaluation delegates to the real binary; every side-effecting subcommand
// stays a no-op, so the rehearsal reaches no network and no install cache and
// installs nothing. A shim that delegated everything would green the tests
// above and quietly turn gate G into a package installer.
test("only evaluation reaches the real bun — install, run, test and scripts stay no-ops", () => {
  const bootstrap = [
    "#!/usr/bin/env bash",
    'cd "$(dirname "$0")/.." || exit 60',
    // A script whose only purpose is to prove it did not run.
    "printf 'require(\"node:fs\").writeFileSync(\"side-effect\", \"x\");\\n' > side-effect.js",
    "bun side-effect.js || exit 71",
    "bun run side-effect.js || exit 72",
    "bun test || exit 73",
    "bun install --frozen-lockfile || exit 74",
    "bun add zod || exit 75",
    "[ -e side-effect ] && exit 76",
    "[ -e node_modules ] && exit 77",
    // ...while `-e` in the same world does reach a real interpreter.
    "bun -e 'process.exit(3)'; [ \"$?\" = 3 ] || exit 78",
    'bash tools/whisper/install.sh',
    "",
  ].join("\n");
  withFixture({ bootstrap }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("PASS");
    expect(measured.evidence("G")).toContain("ran tools/whisper/install.sh");
  });
});

// --- the shell reader the mention scans are built on -------------------------

test("a # inside a parameter expansion or a quoted string is not a comment", () => {
  const lines = executableShellLines(['prefix="${VALUE#refs/}"', "echo 'issue #42'", "# gone", 'echo hi # gone'].join("\n"));
  expect(lines.map((entry) => entry.text.trim())).toEqual(['prefix="${VALUE#refs/}"', "echo 'issue #42'", "echo hi"]);
});

// --- against the real repository --------------------------------------------

test("every quoted gate definition is still the synthesis file's own text", () => {
  expect(definitionDrift(REAL_REPO)).toEqual([]);
});

test("the checker is registered in both mechanism inventories", () => {
  for (const manifest of ["instance/expected-mechanisms.tsv", "instance/required-mechanisms.tsv"]) {
    expect(Bun.file(join(REAL_REPO, manifest)).text()).resolves.toContain("tools/check-cutover-readiness.ts");
  }
});

// The honest baseline, and requirement 4 of the recut: the rebuild artifact
// does not exist on main, so gate D and gate A's clean-clone half are UNKNOWN.
// The state root is pointed at an empty directory, which makes this hermetic in
// both directions — it measures the repository and not whatever this host
// happens to have run, and with no artifact to anchor the reader asks origin
// nothing, so the suite reaches no network.
function emptyStateHome(): string {
  const root = mkdtempSync(join(tmpdir(), "cutover-readiness-no-artifact-"));
  return root;
}

test("with no rebuild artifact for this SHA, the real repository's gate D is UNKNOWN", () => {
  const state = emptyStateHome();
  try {
    const results = withEnv({ XDG_STATE_HOME: state, METEORITE_ARTIFACT: undefined }, () => checkReadiness(REAL_REPO));
    const gateD = results.find((entry) => entry.id === "D")!;
    expect(gateD.verdict).toBe("UNKNOWN");
    expect(gateD.evidence).toContain("no rehearsal artifact at this SHA");
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("the real repository is measured, and is not cutover-ready yet", () => {
  const state = emptyStateHome();
  try {
    const results = withEnv({ XDG_STATE_HOME: state, METEORITE_ARTIFACT: undefined }, () => checkReadiness(REAL_REPO));
    expect(results.map((entry) => entry.id)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(results.every((entry) => entry.evidence.trim().length > 0)).toBe(true);
    expect(results.some((entry) => entry.verdict !== "PASS")).toBe(true);
    expect(report(results).exitCode).toBe(1);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
