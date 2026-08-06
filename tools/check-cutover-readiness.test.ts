import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GATES,
  checkReadiness,
  definitionDrift,
  executableShellLines,
  invocationsOf,
  missionCliCalls,
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
type Options = {
  synthesis?: string;
  launcher?: string;
  meteorite?: string;
  ledgerChecker?: string;
  hostState?: string;
  bootstrap?: string;
  registry?: string;
  omit?: string[];
  untracked?: Record<string, string>;
};

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
  meteorite: [
    "commands=(",
    '  "prerequisites|apt-get update && apt-get install -y git"',
    "  # a comment inside the array is not a stage",
    `  "clone|git clone --no-checkout 'https://example.invalid/repo.git' /work/source"`,
    '  "orchestrator-start|cd /work/install && bash orchestrator/launch.sh --detach"',
    '  "orchestrator-liveness|test -s /work/runtime/orchestrator.lease"',
    ")",
  ].join("\n"),
  // Gate E executes this, so what it PRINTS is what is measured.
  ledgerChecker: [
    "#!/usr/bin/env bun",
    'console.log("UNKNOWN instructions/ [root] inputs absent");',
    "process.exit(1);",
    "",
  ].join("\n"),
  hostState: "# id\tlocation\tverify\nbot-token\t/root/.config/bpa/orchestrator.env\ttest -s /root/.config/bpa/orchestrator.env\n",
  bootstrap: 'bash "$REPO/tools/whisper/install.sh"\n',
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

function verdicts(repo: string): Record<string, string> {
  return Object.fromEntries(checkReadiness(repo).map((entry) => [entry.id, entry.verdict]));
}

function evidence(repo: string, gate: string): string {
  return checkReadiness(repo).find((entry) => entry.id === gate)!.evidence;
}

function withFixture(options: Options, assertion: (repo: string) => void): void {
  const repo = fixture(options);
  try { assertion(repo); } finally { rmSync(repo, { recursive: true, force: true }); }
}

// --- the exit-code rule -----------------------------------------------------

test("exit 0 only when every gate is PASS", () => {
  withFixture({}, (repo) => {
    const results = checkReadiness(repo);
    expect(results.map((entry) => entry.verdict)).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    const { lines, exitCode } = report(results);
    expect(exitCode).toBe(0);
    expect(lines.at(-1)).toBe("CUTOVER-READINESS summary pass=7 fail=0 unknown=0 cutover-ready=yes");
  });
});

test("one FAIL is a non-zero exit", () => {
  withFixture({ omit: ["tools/whisper/install.sh"] }, (repo) => {
    const { lines, exitCode } = report(checkReadiness(repo));
    expect(exitCode).toBe(1);
    expect(lines.at(-1)).toContain("fail=1");
    expect(lines.at(-1)).toContain("cutover-ready=no");
  });
});

test("one UNKNOWN is a non-zero exit — an unmeasured gate is not a green one", () => {
  withFixture({ omit: ["meteorite/run.sh"] }, (repo) => {
    const results = checkReadiness(repo);
    expect(results.find((entry) => entry.id === "D")!.verdict).toBe("UNKNOWN");
    expect(report(results).exitCode).toBe(1);
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
//
// The mechanism this replaces (a SHA-pinned attestation row) could reach PASS
// only while an untracked host-local file existed: green meant dirty, and
// committing the evidence made it UNKNOWN forever. These are the locks on the
// property that replaced it.

test("cutover-ready=yes is reachable from a clean, fully committed tree", () => {
  withFixture({}, (repo) => {
    expect(porcelain(repo)).toBe("");
    expect(report(checkReadiness(repo)).exitCode).toBe(0);
    // Measuring must also leave the tree clean: the gate-E probe runs a real
    // command, and it may not deposit anything in the repository it judges.
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
      expect(verdicts(hostLocal)).toEqual(verdicts(trackedAbsent));
      expect(report(checkReadiness(hostLocal)).exitCode).toBe(1);
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
    expect(verdicts(repo)).toMatchObject({ E: "UNKNOWN", F: "FAIL" });
    expect(report(checkReadiness(repo)).exitCode).toBe(1);
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
    expect(verdicts(repo)).toMatchObject({ E: "UNKNOWN", F: "UNKNOWN" });
    expect(evidence(repo, "E")).toContain("checker:checkout-parity");
    expect(evidence(repo, "F")).toContain("checker:stranded-work");
  });
});

test("a registry row whose target was never landed does not certify anything", () => {
  const registry = DEFAULTS.registry.replace("gate/checkout-parity.sh", "gate/never-written.sh");
  withFixture({ registry }, (repo) => {
    expect(verdicts(repo).E).toBe("UNKNOWN");
    expect(evidence(repo, "E")).toContain("gate/never-written.sh");
  });
});

test("an unreadable definition source makes every gate UNKNOWN rather than judged", () => {
  withFixture({ omit: ["instance/consilium-cutover-2026-08-04-evening-synthesis.md"] }, (repo) => {
    const results = checkReadiness(repo);
    expect(results.every((entry) => entry.verdict === "UNKNOWN")).toBe(true);
    expect(report(results).exitCode).toBe(1);
  });
});

test("a gate whose definition drifted is UNKNOWN; its siblings are still judged", () => {
  const watered = synthesisText().replace("Every path the launcher requires exists in the tree", "Most paths the launcher requires exist in the tree");
  withFixture({ synthesis: watered }, (repo) => {
    expect(definitionDrift(repo)).toEqual(["B"]);
    expect(verdicts(repo)).toMatchObject({ A: "PASS", B: "UNKNOWN", C: "PASS" });
    expect(evidence(repo, "B")).toContain("definition drifted");
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
    expect(verdicts(repo).B).toBe("UNKNOWN");
  });
});

// --- gate A: a clean clone starts ------------------------------------------

test("A FAILs when the launcher requires a path the tree does not carry", () => {
  withFixture({ omit: ["orchestrator/preflight-cli-auth.sh"] }, (repo) => {
    expect(verdicts(repo).A).toBe("FAIL");
    expect(evidence(repo, "A")).toContain("orchestrator/preflight-cli-auth.sh");
  });
});

test("A FAILs when tracked runtime source still reaches for the break-glass tree", () => {
  withFixture({ launcher: `${DEFAULTS.launcher}\nsource /root/oldorch-breakglass/env.sh\n` }, (repo) => {
    expect(verdicts(repo).A).toBe("FAIL");
    expect(evidence(repo, "A")).toContain("break-glass");
  });
});

test("A is UNKNOWN, not FAIL, when the launcher itself cannot be read", () => {
  withFixture({ omit: ["orchestrator/launch.sh"] }, (repo) => {
    expect(verdicts(repo).A).toBe("UNKNOWN");
  });
});

test("A's clean-clone half is UNKNOWN when no stage clones from a remote", () => {
  const local = DEFAULTS.meteorite.replace(/"clone\|[^"]*"/, '"clone|cp -a /root/bpa-dev-infrastructure /work/source"');
  withFixture({ meteorite: local }, (repo) => {
    expect(verdicts(repo).A).toBe("UNKNOWN");
    expect(evidence(repo, "A")).toContain("clones the candidate from a remote");
  });
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
    expect(verdicts(repo).B).toBe("FAIL");
    expect(evidence(repo, "B")).toContain("orchestrator/never-written.sh");
  });
});

test("B FAILs on an absent required path and names the launcher line", () => {
  withFixture({ omit: ["core/mission-cli.ts"] }, (repo) => {
    expect(verdicts(repo).B).toBe("FAIL");
    expect(evidence(repo, "B")).toMatch(/core\/mission-cli\.ts \(orchestrator\/launch\.sh:3\)/);
  });
});

test("B is UNKNOWN when the installed-path verifier it defers to is absent", () => {
  withFixture({ omit: ["bootstrap/check-unit-drift.sh"] }, (repo) => {
    expect(verdicts(repo).B).toBe("UNKNOWN");
    expect(evidence(repo, "B")).toContain("bootstrap/check-unit-drift.sh");
  });
});

// --- gate C: caller/callee vocabulary --------------------------------------

test("C FAILs on a call outside the implemented vocabulary", () => {
  withFixture({ launcher: `${DEFAULTS.launcher}\nmission_cli reap\nmission_cli lease acquire "$owner"\n` }, (repo) => {
    expect(verdicts(repo).C).toBe("FAIL");
    expect(evidence(repo, "C")).toContain("orchestrator/launch.sh");
    expect(evidence(repo, "C")).toContain("reap");
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
    expect(verdicts(repo).C).toBe("UNKNOWN");
  });
});

// --- gate D: the meteorite asserts liveness ---------------------------------

test("D FAILs when the meteorite only proves that files copied", () => {
  withFixture({ meteorite: 'commands=(\n  "full-test-suite|cd /work/install && bun test"\n)\n' }, (repo) => {
    expect(verdicts(repo).D).toBe("FAIL");
    expect(evidence(repo, "D")).toContain("none starts the orchestrator and none asserts liveness");
  });
});

test("D FAILs when the orchestrator is started but no live state is asserted", () => {
  withFixture({ meteorite: 'commands=(\n  "start|bash orchestrator/launch.sh"\n)\n' }, (repo) => {
    expect(verdicts(repo).D).toBe("FAIL");
    expect(evidence(repo, "D")).toContain("no stage asserts a live state");
  });
});

// The reviewer's repro, verbatim in shape: a meteorite that is two TODO lines
// mentioning the launcher and the lease. It reported PASS.
test("D is not satisfied by a file comment naming the launcher and the lease", () => {
  withFixture({ meteorite: "# TODO: bash orchestrator/launch.sh\n# TODO: check orchestrator.lease\n" }, (repo) => {
    expect(verdicts(repo).D).toBe("UNKNOWN");
    expect(evidence(repo, "D")).toContain("no readable commands=(...) stage list");
    expect(verdicts(repo).A).toBe("UNKNOWN");
  });
});

test("D is not satisfied by a comment INSIDE the stage list", () => {
  withFixture({
    meteorite: [
      "commands=(",
      '  "full-test-suite|cd /work/install && bun test"',
      "  # TODO: bash orchestrator/launch.sh and then check orchestrator.lease",
      ")",
    ].join("\n"),
  }, (repo) => {
    expect(verdicts(repo).D).toBe("FAIL");
    expect(evidence(repo, "D")).toContain("1 stages (full-test-suite)");
  });
});

test("D refuses to judge a stage list it cannot parse, rather than reading raw text", () => {
  withFixture({
    meteorite: ["commands=(", '  "orchestrator-start|bash orchestrator/launch.sh"', "  $EXTRA_STAGES", '  "liveness|test -s orchestrator.lease"', ")"].join("\n"),
  }, (repo) => {
    expect(verdicts(repo).D).toBe("UNKNOWN");
  });
});

// --- gate E: one verdict, and absent inputs are UNKNOWN ---------------------

test("E FAILs when a check with absent inputs still passes", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconsole.log("PASS nothing to check");\n' }, (repo) => {
    expect(verdicts(repo).E).toBe("FAIL");
    expect(evidence(repo, "E")).toContain("emits no UNKNOWN outcome");
  });
});

// The reviewer's repro: the word UNKNOWN present in the checker's source and
// absent from its behaviour. It reported PASS.
test("E is not satisfied by the word UNKNOWN in a comment", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\n// TODO: UNKNOWN not implemented yet\nconsole.log("PASS everything is fine");\n' }, (repo) => {
    expect(verdicts(repo).E).toBe("FAIL");
    expect(evidence(repo, "E")).toContain("emits no UNKNOWN outcome");
  });
});

test("E is not satisfied by an UNKNOWN in a string the checker never prints", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconst unused = "UNKNOWN";\nconsole.log("PASS");\n' }, (repo) => {
    expect(verdicts(repo).E).toBe("FAIL");
  });
});

test("E PASSes on behaviour: the checker reports UNKNOWN when its inputs are absent", () => {
  withFixture({}, (repo) => {
    expect(verdicts(repo).E).toBe("PASS");
    expect(evidence(repo, "E")).toContain("reports UNKNOWN when run against a tree whose inputs are absent");
  });
});

test("a probe that has to be killed is UNKNOWN, never PASS — a kill is not a pass", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconsole.log("UNKNOWN");\nawait Bun.sleep(60_000);\n' }, (repo) => {
    const previous = process.env.CUTOVER_PROBE_TIMEOUT_MS;
    process.env.CUTOVER_PROBE_TIMEOUT_MS = "700";
    try {
      expect(verdicts(repo).E).toBe("UNKNOWN");
      expect(evidence(repo, "E")).toContain("killed");
    } finally {
      if (previous === undefined) delete process.env.CUTOVER_PROBE_TIMEOUT_MS;
      else process.env.CUTOVER_PROBE_TIMEOUT_MS = previous;
    }
  });
});

test("E stays FAIL even when the checkout-parity mechanism is registered", () => {
  withFixture({ ledgerChecker: '#!/usr/bin/env bun\nconsole.log("PASS nothing to check");\n' }, (repo) => {
    expect(verdicts(repo).E).toBe("FAIL");
    expect(evidence(repo, "E")).not.toContain("checkout-parity");
  });
});

// --- gate F: host state enumerated ------------------------------------------

test("F FAILs without a tracked host-state inventory", () => {
  withFixture({ omit: ["instance/host-state.tsv"] }, (repo) => {
    expect(verdicts(repo).F).toBe("FAIL");
    expect(evidence(repo, "F")).toContain("instance/host-state.tsv");
  });
});

test("F FAILs when an enumerated item carries no verifying command", () => {
  withFixture({ hostState: "bot-token\t/root/.config/bpa/orchestrator.env\n" }, (repo) => {
    expect(verdicts(repo).F).toBe("FAIL");
    expect(evidence(repo, "F")).toContain("without a verifying command");
  });
});

// --- gate G: the runtime models come up -------------------------------------

test("G FAILs when nothing on the clean-server path runs the Whisper installer", () => {
  withFixture({ bootstrap: "echo installing everything except whisper\n" }, (repo) => {
    expect(verdicts(repo).G).toBe("FAIL");
    expect(evidence(repo, "G")).toContain("comes up without Whisper");
  });
});

// The reviewer's repro: one comment, three words short of green.
test("G is not satisfied by a TODO comment naming the installer", () => {
  withFixture({ bootstrap: "# TODO: run tools/whisper/install.sh someday\n" }, (repo) => {
    expect(verdicts(repo).G).toBe("FAIL");
    expect(evidence(repo, "G")).toContain("comes up without Whisper");
  });
});

test("G is not satisfied by a usage banner that mentions the installer", () => {
  withFixture({
    bootstrap: ["usage() {", "  cat <<'EOF'", "Stage 2 does not run tools/whisper/install.sh yet.", "EOF", "}", "usage", ""].join("\n"),
  }, (repo) => {
    expect(verdicts(repo).G).toBe("FAIL");
  });
});

test("G is not satisfied by a trailing comment on an executable line", () => {
  withFixture({ bootstrap: 'echo "stage 2" # later: bash tools/whisper/install.sh\n' }, (repo) => {
    expect(verdicts(repo).G).toBe("FAIL");
  });
});

test("G PASSes when the meteorite runs the installer on the clean machine", () => {
  const withWhisper = DEFAULTS.meteorite.replace(")", '  "whisper|cd /work/install && bash tools/whisper/install.sh"\n)');
  withFixture({ bootstrap: "echo nothing here\n", meteorite: withWhisper }, (repo) => {
    expect(verdicts(repo).G).toBe("PASS");
    expect(evidence(repo, "G")).toContain("stage whisper");
  });
});

test("G is not satisfied by a comment inside the meteorite's stage list", () => {
  const commented = DEFAULTS.meteorite.replace(")", "  # TODO: bash tools/whisper/install.sh\n)");
  withFixture({ bootstrap: "echo nothing here\n", meteorite: commented }, (repo) => {
    expect(verdicts(repo).G).toBe("FAIL");
  });
});

test("G is UNKNOWN when the clean-server install path cannot be read", () => {
  withFixture({ omit: ["bootstrap/install.sh"] }, (repo) => {
    expect(verdicts(repo).G).toBe("UNKNOWN");
  });
});

// --- the shell readers the gates are built on -------------------------------

test("a # inside a parameter expansion or a quoted string is not a comment", () => {
  const lines = executableShellLines(['prefix="${VALUE#refs/}"', "echo 'issue #42'", "# gone", 'echo hi # gone'].join("\n"));
  expect(lines.map((entry) => entry.text.trim())).toEqual(['prefix="${VALUE#refs/}"', "echo 'issue #42'", "echo hi"]);
});

test("an invocation is a command position, not a mention", () => {
  const runs = (text: string) => invocationsOf(executableShellLines(text), "tools/whisper/install.sh").length;
  expect(runs("bash tools/whisper/install.sh")).toBe(1);
  expect(runs('  bash "$REPO/tools/whisper/install.sh" --quiet')).toBe(1);
  expect(runs("prepare && ./tools/whisper/install.sh")).toBe(1);
  expect(runs('echo "see tools/whisper/install.sh for details"')).toBe(0);
  expect(runs("# bash tools/whisper/install.sh")).toBe(0);
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
