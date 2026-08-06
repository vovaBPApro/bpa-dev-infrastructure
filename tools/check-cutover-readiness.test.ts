import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATES,
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
// Everything the fixture writes is COMMITTED: the checker measures git's
// tracked set, and a fixture that reached PASS from a dirty tree would be
// testing a state the definition ("from a clean clone, with no file from this
// host") does not allow. `untracked` writes files after the commit precisely so
// the tests below can prove such a file moves nothing.
//
// The fixture scripts are RUNNABLE, because the gates execute them: the
// meteorite is a real runner that loops its `commands=(...)` array through
// `docker exec` (the rehearsal supplies the docker), the bootstrap really runs,
// and the ledger checker really reports. A fixture that only LOOKED like a
// script would be re-importing the defect this revision removes.
type Options = {
  synthesis?: string;
  launcher?: string;
  meteorite?: string;
  startProof?: string;
  ledgerChecker?: string;
  hostState?: string;
  bootstrap?: string;
  registry?: string;
  omit?: string[];
  untracked?: Record<string, string>;
};

// A runnable meteorite with the given stage lines. The stage list is the same
// literal `commands=(...)` array the real meteorite carries (so the checker's
// parse reads it), and the loop hands every stage to `docker exec bash -lc`
// exactly as meteorite/run.sh does.
function meteoriteWith(...stages: string[]): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    // The real meteorite defines these before its array; stage spellings that
    // interpolate them must not kill the fixture at array-definition time.
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
const START_STAGE = '"orchestrator-start|bash meteorite/assert-orchestrator-live.sh"';

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
    START_STAGE,
  ),
  // Gates D and A rehearse this, so what it DOES is what is measured. It is
  // run against an orchestrator analog in three worlds -- live, launcher-
  // success-without-liveness, dead -- and only a script that launches the
  // analog and asserts the liveness evidence itself answers all three.
  startProof: [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    '"$REPO_DIR/orchestrator/launch.sh" --detach',
    '"$REPO_DIR/orchestrator/status.sh"',
    "",
  ].join("\n"),
  // Gate E executes this, so what it REPORTS is what is measured -- and the
  // green path is the structured outcome channel, not the printed lines.
  ledgerChecker: [
    "#!/usr/bin/env bun",
    'console.log("UNKNOWN instructions/ [root] directory not found");',
    'console.log("\\nsummary: 0 FAIL, 0 WARN, 0 SKIP, 1 UNKNOWN, 0 PASS (0 docs)");',
    "const channel = process.env.CHECK_OUTCOMES_JSON;",
    'if (channel) await Bun.write(channel, JSON.stringify({ findings: [{ level: "UNKNOWN", file: "instructions/", check: "root" }] }));',
    "process.exit(1);",
    "",
  ].join("\n"),
  hostState: "# id\tlocation\tverify\nbot-token\t/root/.config/bpa/orchestrator.env\ttest -s /root/.config/bpa/orchestrator.env\n",
  // Runnable: really invokes the installer beside it, whatever directory the
  // rehearsal world put the tree in.
  bootstrap: '#!/usr/bin/env bash\nbash "$(dirname "$0")/../tools/whisper/install.sh"\n',
  registry: [
    "# id\tkind\ttracked target",
    "runner:meteorite\trunner\tmeteorite/run.sh",
    "runner:orchestrator-start-proof\trunner\tmeteorite/assert-orchestrator-live.sh",
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
    "meteorite/assert-orchestrator-live.sh": options.startProof ?? DEFAULTS.startProof,
    "tools/instructions/check.ts": options.ledgerChecker ?? DEFAULTS.ledgerChecker,
    "instance/host-state.tsv": options.hostState ?? DEFAULTS.hostState,
    "instance/required-mechanisms.tsv": options.registry ?? DEFAULTS.registry,
    "gate/checkout-parity.sh": "# one verdict from every checkout kind\n",
    "hygiene/check-stranded-work.sh": "# nothing ACCEPTed lives only here\n",
  };
  for (const [path, content] of Object.entries(files)) if (!omit.has(path)) write(repo, path, content);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  for (const [path, content] of Object.entries(options.untracked ?? {})) write(repo, path, content);
  return repo;
}

// One measurement per call: the executed rehearsals make a measurement cost
// real time, so tests read verdicts and evidence from a single run.
type Measured = {
  verdicts: Record<string, string>;
  evidence: (gate: string) => string;
  exitCode: number;
  lines: string[];
};

function measure(repo: string): Measured {
  const results = checkReadiness(repo);
  const { lines, exitCode } = report(results);
  return {
    verdicts: Object.fromEntries(results.map((entry) => [entry.id, entry.verdict])),
    evidence: (gate) => results.find((entry) => entry.id === gate)!.evidence,
    exitCode,
    lines,
  };
}

function withFixture(options: Options, assertion: (repo: string) => void): void {
  const repo = fixture(options);
  try { assertion(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
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
    const green = Bun.spawnSync([process.execPath, join(REAL_REPO, "tools/check-cutover-readiness.ts"), "--repo", repo]);
    expect(green.exitCode).toBe(0);
    expect(green.stdout.toString()).toContain("CUTOVER-READINESS A PASS");
  });
  withFixture({ omit: ["instance/host-state.tsv"] }, (repo) => {
    const red = Bun.spawnSync([process.execPath, join(REAL_REPO, "tools/check-cutover-readiness.ts"), "--repo", repo]);
    expect(red.exitCode).toBe(1);
    expect(red.stdout.toString()).toContain("CUTOVER-READINESS F FAIL");
  });
});

// --- green comes from a clean, tracked tree — and only from one -------------

test("cutover-ready=yes is reachable from a clean, fully committed tree", () => {
  withFixture({}, (repo) => {
    expect(porcelain(repo)).toBe("");
    expect(measure(repo).exitCode).toBe(0);
    // Measuring must also leave the tree clean: the rehearsals run real
    // commands, and they may not deposit anything in the repository they judge.
    expect(porcelain(repo)).toBe("");
  });
});

test("no untracked file can move any gate toward PASS", () => {
  const inputs: Record<string, string> = {
    "meteorite/run.sh": DEFAULTS.meteorite,
    "meteorite/assert-orchestrator-live.sh": DEFAULTS.startProof,
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
      expect(measured.verdicts).toEqual(measure(trackedAbsent).verdicts);
      expect(measured.exitCode).toBe(1);
    } finally {
      rmSync(trackedAbsent, { recursive: true, force: true });
      rmSync(hostLocal, { recursive: true, force: true });
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

test("an unreadable definition source makes every gate UNKNOWN rather than judged", () => {
  withFixture({ omit: ["instance/consilium-cutover-2026-08-04-evening-synthesis.md"] }, (repo) => {
    const measured = measure(repo);
    expect(Object.values(measured.verdicts).every((verdict) => verdict === "UNKNOWN")).toBe(true);
    expect(measured.exitCode).toBe(1);
  });
});

test("a gate whose definition drifted is UNKNOWN; its siblings are still judged", () => {
  const watered = synthesisText().replace("Every path the launcher requires exists in the tree", "Most paths the launcher requires exist in the tree");
  withFixture({ synthesis: watered }, (repo) => {
    expect(definitionDrift(repo)).toEqual(["B"]);
    const measured = measure(repo);
    expect(measured.verdicts).toMatchObject({ A: "PASS", B: "UNKNOWN", C: "PASS" });
    expect(measured.evidence("B")).toContain("definition drifted");
  });
});

test("quoting the original sentence elsewhere does not cover for a watered-down bullet", () => {
  const watered = `${synthesisText().replace("Every path the launcher requires exists in the tree", "Most paths the launcher requires exist in the tree")}
## Appendix — what B used to say

- **B.** Every path the launcher requires exists in the tree; a test fails if any required path is absent.
`;
  withFixture({ synthesis: watered }, (repo) => {
    // The appendix carries the original text verbatim, but not as gate B's own
    // bullet in the definition section it was quoted from.
    expect(measure(repo).verdicts.B).toBe("UNKNOWN");
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

test("A's clean-clone half is UNKNOWN when no stage clones from a remote", () => {
  const local = meteoriteWith(PREREQ_STAGE, '"clone|cp -a /root/bpa-dev-infrastructure /work/source"', START_STAGE);
  withFixture({ meteorite: local }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.evidence("A")).toContain("clones the candidate from a remote");
  });
});

// An honest rewrite of the clone stage must not pin gate A at UNKNOWN forever:
// `--depth 1`, `-b main` and `-q` are ordinary spellings of a remote clone.
test("A recognises the ordinary spellings of a clone from a remote", () => {
  const spellings = [
    "git clone --depth 1 https://example.invalid/repo.git /work/source",
    "git clone -b main https://example.invalid/repo.git /work/source",
    "git clone -q --no-checkout '$repo_url' /work/source",
    "git clone --depth 1 git@github.invalid:owner/repo.git /work/source",
    'git clone -b "$ref" ssh://git@example.invalid/repo /work/source',
  ];
  for (const spelling of spellings) {
    const meteorite = meteoriteWith(`"clone|${spelling}"`, START_STAGE);
    withFixture({ meteorite }, (repo) => {
      expect({ spelling, A: measure(repo).verdicts.A }).toEqual({ spelling, A: "PASS" });
    });
  }
});

// ...and a local source still must not: a copy from this host is the opposite
// of the clean clone gate A is about.
test("A does not read a local-path clone as a clone from a remote", () => {
  const meteorite = meteoriteWith('"clone|git clone --depth 1 /root/bpa-dev-infrastructure /work/source"', START_STAGE);
  withFixture({ meteorite }, (repo) => {
    expect(measure(repo).verdicts.A).toBe("UNKNOWN");
  });
});

test("A does not let a later command's URL certify an earlier local clone", () => {
  const meteorite = meteoriteWith('"clone|git clone /work/donor /work/source && curl -sS https://example.invalid/manifest"', START_STAGE);
  withFixture({ meteorite }, (repo) => {
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
    const measured = measure(repo);
    expect(measured.verdicts.A).toBe("FAIL");
    expect(measured.evidence("A")).toContain("renamed away");
    expect(measured.exitCode).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
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
  withFixture({ launcher: `${DEFAULTS.launcher}\nmission_cli reap\nmission_cli lease acquire "$owner"\n` }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.C).toBe("FAIL");
    expect(measured.evidence("C")).toContain("orchestrator/launch.sh");
    expect(measured.evidence("C")).toContain("reap");
  });
});

test("C reads calls, not the shell function that wraps them", () => {
  withFixture({}, (repo) => {
    expect(missionCliCalls(repo).map((call) => `${call.group} ${call.action ?? ""}`.trim())).toEqual(["lane claim", "status"]);
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

// --- the start proof, rehearsed in three worlds -----------------------------
//
// Three revisions of this gate were greened by text. The evidence a green
// consumes here is therefore not text at all: the registered proof is RUN
// against an orchestrator analog that records being invoked, in a world where
// the analog comes up live, a world where its launcher succeeds but nothing
// becomes live, and a world where the launch fails.

test("D PASSes only on a rehearsal in which the proof really starts the analog", () => {
  withFixture({}, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts).toMatchObject({ A: "PASS", D: "PASS" });
    expect(measured.evidence("D")).toContain("executed with its container replaced by a rehearsal world, invoked meteorite/assert-orchestrator-live.sh");
    expect(measured.evidence("D")).toContain("rehearsed against an orchestrator analog in three worlds");
    expect(measured.evidence("D")).toContain("live exit 0");
  });
});

// The round-2 reviewer's sharpest reproduction, in its own shape: a proof whose
// text names the launcher and the lease, and whose behaviour is an echo.
test("D FAILs a proof that only TALKS about launching — the analog records no launch", () => {
  withFixture({
    startProof: '#!/usr/bin/env bash\necho "NOT DONE: nothing here runs $REPO_DIR/orchestrator/launch.sh or checks orchestrator.lease yet"\n',
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts).toMatchObject({ A: "FAIL", D: "FAIL" });
    expect(measured.evidence("D")).toContain("without ever invoking $REPO_DIR/orchestrator/launch.sh");
    expect(measured.evidence("D")).toContain("describes a start rather than performing one");
    expect(measured.exitCode).toBe(1);
  });
});

test("D FAILs when the proof runs but the start it proves does not work", () => {
  withFixture({
    startProof: [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      '"$REPO_DIR/orchestrator/launch.sh" --detach',
      '# the orchestrator is up, but this proof requires a pid file nothing writes',
      'test -s "$RUNTIME_DIR/orchestrator.pid"',
      "",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts).toMatchObject({ A: "FAIL", D: "FAIL" });
    expect(measured.evidence("D")).toContain("rehearsed against an orchestrator analog that came up");
  });
});

test("D FAILs a proof that launches but asserts no live state — it exits 0 without liveness", () => {
  withFixture({
    startProof: '#!/usr/bin/env bash\n"$REPO_DIR/orchestrator/launch.sh" --detach || true\nexit 0\n',
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts).toMatchObject({ A: "FAIL", D: "FAIL" });
    expect(measured.evidence("D")).toContain("asserts no live state");
  });
});

// The same trap one level up: a proof that deletes the thing it is supposed to
// check still exits 0 whether or not anything is alive.
test("D FAILs a proof that removes the liveness marker instead of asserting it", () => {
  withFixture({
    startProof: '#!/usr/bin/env bash\n"$REPO_DIR/orchestrator/launch.sh" --detach || true\nrm -f "$RUNTIME_DIR/orchestrator.lease"\n',
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("asserts no live state");
  });
});

// Round-3 finding 3: a proof that merely propagates the launcher's exit status
// passed a two-world rehearsal, because the dead launcher already exits 1. The
// zombie world — launcher exits 0, nothing becomes live — is the world that
// tells "asserts a live state" from "trusts the launcher".
test("D FAILs a proof that only propagates the launcher's exit status", () => {
  withFixture({
    startProof: '#!/usr/bin/env bash\nset -euo pipefail\nexec "$REPO_DIR/orchestrator/launch.sh"\n',
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts).toMatchObject({ A: "FAIL", D: "FAIL" });
    expect(measured.evidence("D")).toContain("accepts the launcher's exit status instead of asserting the liveness evidence");
  });
});

test("a rehearsal that has to be killed is UNKNOWN, never PASS", () => {
  withFixture({
    startProof: '#!/usr/bin/env bash\n"$REPO_DIR/orchestrator/launch.sh"\nsleep 60\n',
  }, (repo) => {
    const previous = process.env.CUTOVER_PROBE_TIMEOUT_MS;
    process.env.CUTOVER_PROBE_TIMEOUT_MS = "700";
    try {
      const measured = measure(repo);
      expect(measured.verdicts).toMatchObject({ A: "UNKNOWN", D: "UNKNOWN" });
      expect(measured.evidence("D")).toContain("was killed");
      expect(measured.exitCode).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CUTOVER_PROBE_TIMEOUT_MS;
      else process.env.CUTOVER_PROBE_TIMEOUT_MS = previous;
    }
  });
});

// --- the wiring: the meteorite, executed, must invoke the proof --------------
//
// Round 3's surviving disease was a text predicate deciding "the meteorite runs
// it". There is no such predicate left: the meteorite is executed with its
// container replaced by a rehearsal world, and only its own execution reaching
// the proof's journaling sentinel counts as running it.

test("D FAILs when a working proof exists but the meteorite, executed, never invokes it", () => {
  const idle = meteoriteWith(PREREQ_STAGE, CLONE_STAGE, '"full-test-suite|true"');
  withFixture({ meteorite: idle }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("executed to completion in the rehearsal world, never invoked meteorite/assert-orchestrator-live.sh");
    expect(measured.verdicts.A).toBe("UNKNOWN");
  });
});

test("D FAILs when a stage only mentions the proof instead of running it", () => {
  const mentioned = meteoriteWith(CLONE_STAGE, `"advice|echo 'operator: next run meteorite/assert-orchestrator-live.sh by hand'"`);
  withFixture({ meteorite: mentioned }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("never invoked meteorite/assert-orchestrator-live.sh");
  });
});

// Round-3 finding 1, locked in the form the real meteorite writes its stages:
// an env-var assignment in front of a command is not an invocation, and no
// pattern decides that any more — the stage executes, and the journal stays
// empty because nothing ran the proof.
test("an assignment naming the proof does not green D or A — the stage runs, the journal stays empty", () => {
  const assignments = [
    '"orchestrator-start|ORCH_START_PROOF=meteorite/assert-orchestrator-live.sh bash bootstrap/check-unit-drift.sh"',
    '"orchestrator-start|PROOF=meteorite/assert-orchestrator-live.sh"',
  ];
  for (const stage of assignments) {
    const meteorite = meteoriteWith(CLONE_STAGE, stage);
    withFixture({ meteorite }, (repo) => {
      const measured = measure(repo);
      expect(measured.verdicts.D).toBe("FAIL");
      expect(measured.evidence("D")).toContain("never invoked meteorite/assert-orchestrator-live.sh");
      expect(measured.verdicts.A).toBe("UNKNOWN");
      expect(measured.exitCode).toBe(1);
    });
  }
});

// The same stage written against container state the rehearsal world does not
// provide: the meteorite aborts, and that is UNKNOWN with the aborting line
// quoted — never PASS, and never a verdict parsed from the text.
test("a stage needing container state the world lacks is UNKNOWN, never PASS", () => {
  const meteorite = meteoriteWith(CLONE_STAGE, '"orchestrator-start|cd /work/install && ORCH_START_PROOF=meteorite/assert-orchestrator-live.sh bash bootstrap/check-unit-drift.sh"');
  withFixture({ meteorite }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("aborted");
    expect(measured.verdicts.A).toBe("UNKNOWN");
    expect(measured.exitCode).toBe(1);
  });
});

// The round-2 review's three PASSing reproductions, run against this revision.
// Each is the whole stage list, so nothing else can be carrying the verdict.
test("the round-2 reproductions no longer green D, and no longer green A", () => {
  const reproductions = [
    `"advice|echo 'operator: next run orchestrator/launch.sh by hand'"`,
    '"teardown|rm -f /work/runtime/orchestrator.lease"',
    `"notice|echo 'NOT DONE: nothing here runs orchestrator/launch.sh or checks orchestrator.lease yet'"`,
  ];
  for (const stage of reproductions) {
    const meteorite = meteoriteWith(CLONE_STAGE, stage);
    withFixture({ meteorite }, (repo) => {
      const measured = measure(repo);
      expect(measured.verdicts.D).toBe("FAIL");
      expect(measured.verdicts.A).toBe("UNKNOWN");
      expect(measured.exitCode).toBe(1);
    });
  }
});

// The journal is the only thing a wiring green consumes, and printed output
// cannot reach it: a sentinel line carries a nonce generated for this run.
test("a stage that prints a journal-shaped line does not green the wiring", () => {
  const meteorite = meteoriteWith(CLONE_STAGE, `"orchestrator-start|echo 'deadbeef start-proof invoked meteorite/assert-orchestrator-live.sh'"`);
  withFixture({ meteorite }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("never invoked");
  });
});

// --- gate D: what the stage list says, on the FAIL path only ----------------

test("D FAILs when the meteorite only proves that files copied", () => {
  withFixture({ meteorite: meteoriteWith('"full-test-suite|true"') }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("none starts the orchestrator and none asserts liveness");
  });
});

test("D FAILs when a stage talks about the launcher but nothing asserts a live state", () => {
  withFixture({ meteorite: meteoriteWith(`"start|echo 'pretending to run orchestrator/launch.sh'"`) }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("no stage asserts a live state");
  });
});

// The round-1 reviewer's repro, verbatim in shape: a meteorite that is two TODO
// lines mentioning the launcher and the lease. It reported PASS.
test("D is not satisfied by a file comment naming the launcher and the lease", () => {
  withFixture({ meteorite: "# TODO: bash orchestrator/launch.sh\n# TODO: check orchestrator.lease\n" }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("UNKNOWN");
    expect(measured.evidence("D")).toContain("no readable commands=(...) stage list");
    expect(measured.verdicts.A).toBe("UNKNOWN");
  });
});

test("D is not satisfied by a comment INSIDE the stage list", () => {
  withFixture({
    meteorite: meteoriteWith('"full-test-suite|true"', "# TODO: bash orchestrator/launch.sh and then check orchestrator.lease"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.D).toBe("FAIL");
    expect(measured.evidence("D")).toContain("1 stages (full-test-suite)");
  });
});

test("D refuses to judge a stage list it cannot parse, rather than reading raw text", () => {
  withFixture({
    meteorite: meteoriteWith('"orchestrator-start|bash orchestrator/launch.sh"', "$EXTRA_STAGES", '"liveness|test -s orchestrator.lease"'),
  }, (repo) => {
    expect(measure(repo).verdicts.D).toBe("UNKNOWN");
  });
});

// --- gate E: absent inputs, judged on the structured outcome set -------------
//
// Round 2 greened this gate with the token UNKNOWN in output; round 3 greened
// it with one UNKNOWN finding printed beside PASS findings on the same
// inputless run. The green path is now the structured outcome channel
// (CHECK_OUTCOMES_JSON), read whole: at least one UNKNOWN, zero PASS. Printed
// lines are read in the FAIL direction only.

test("E FAILs when a check with absent inputs still passes", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconsole.log("PASS nothing to check");\n' }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("reported success (exit 0)");
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

test("E PASSes on behaviour: the structured outcome set is UNKNOWN and nothing passed", () => {
  withFixture({}, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("PASS");
    expect(measured.evidence("E")).toContain("reports UNKNOWN and never PASS against a tree whose inputs are absent");
    expect(measured.evidence("E")).toContain("1 UNKNOWN, 0 PASS");
  });
});

test("E FAILs a checker that passes an inputless tree while its summary tallies UNKNOWN", () => {
  withFixture({
    ledgerChecker: '#!/usr/bin/env bun\nconsole.log("summary: 0 FAIL, 0 WARN, 0 SKIP, 0 UNKNOWN, 0 PASS (0 docs)");\nprocess.exit(0);\n',
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("reported success (exit 0)");
    expect(measured.exitCode).toBe(1);
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
      "process.exit(0);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("FAIL");
    expect(measured.evidence("E")).toContain("its own summary counts as zero");
  });
});

// Round-3 finding 2, locked: one UNKNOWN finding beside PASS findings on the
// same inputless run is the violation, not a defence. All findings are read.
test("E FAILs a checker that prints PASS findings beside its one UNKNOWN", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("PASS instructions/ [root] all documents valid");',
      'console.log("PASS instance/decisions [ledger] all states known");',
      'console.log("UNKNOWN tools/x.ts [experimental] not implemented");',
      'console.log("summary: 0 FAIL, 0 WARN, 0 SKIP, 1 UNKNOWN, 2 PASS (0 docs)");',
      "process.exit(0);",
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
// printed findings are still read in the FAIL direction.
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

// Round-3 finding 5, elevated by the recut brief: a printed line in the finding
// grammar is forgeable by a printed line, so it can hold the gate at UNKNOWN or
// push it to FAIL — never green it.
test("printed UNKNOWN findings without a structured channel are UNKNOWN, never PASS", () => {
  withFixture({
    ledgerChecker: [
      "#!/usr/bin/env bun",
      'console.log("UNKNOWN instructions/ [root] directory not found");',
      'console.log("summary: 0 FAIL, 0 WARN, 0 SKIP, 1 UNKNOWN, 0 PASS (0 docs)");',
      "process.exit(1);",
    ].join("\n"),
  }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.E).toBe("UNKNOWN");
    expect(measured.evidence("E")).toContain("no structured outcome channel");
    expect(measured.exitCode).toBe(1);
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
    expect(measured.evidence("E")).toContain("carries no UNKNOWN outcome");
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
  withFixture({ bootstrap: "echo installing everything except whisper\n" }, (repo) => {
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

test("an env-prefix stage naming the installer does not green G's meteorite arm", () => {
  const meteorite = meteoriteWith(CLONE_STAGE, START_STAGE, '"whisper|WHISPER_INSTALLER=tools/whisper/install.sh bash bootstrap/check-unit-drift.sh"');
  withFixture({ bootstrap: "echo nothing here\n", meteorite }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("FAIL");
    expect(measured.evidence("G")).toContain("never ran it");
    expect(measured.exitCode).toBe(1);
  });
});

test("G PASSes when the meteorite, executed, runs the installer on the clean machine", () => {
  const withWhisper = meteoriteWith(CLONE_STAGE, START_STAGE, '"whisper|bash tools/whisper/install.sh"');
  withFixture({ bootstrap: "echo nothing here\n", meteorite: withWhisper }, (repo) => {
    const measured = measure(repo);
    expect(measured.verdicts.G).toBe("PASS");
    expect(measured.evidence("G")).toContain("executed in the rehearsal world, ran tools/whisper/install.sh");
  });
});

test("G is not satisfied by a comment inside the meteorite's stage list", () => {
  const commented = meteoriteWith(CLONE_STAGE, START_STAGE, "# TODO: bash tools/whisper/install.sh");
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

test("the real repository is measured, and is not cutover-ready yet", () => {
  const results = checkReadiness(REAL_REPO);
  expect(results.map((entry) => entry.id)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  expect(results.every((entry) => entry.evidence.trim().length > 0)).toBe(true);
  expect(results.map((entry) => entry.verdict)).not.toContain("PASS");
  expect(report(results).exitCode).toBe(1);
});
