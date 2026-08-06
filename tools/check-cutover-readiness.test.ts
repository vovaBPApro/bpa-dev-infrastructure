import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATES, checkReadiness, definitionDrift, missionCliCalls, report, requiredLauncherPaths } from "./check-cutover-readiness";

const REAL_REPO = join(import.meta.dir, "..");

// A repository in which every gate holds, so each case below changes exactly
// one input and the verdict it moves is attributable to that one change.
// Attestations are written after the first commit because a row counts only
// when its SHA is HEAD.
type Options = {
  synthesis?: string;
  launcher?: string;
  meteorite?: string;
  ledgerChecker?: string;
  hostState?: string;
  bootstrap?: string;
  attestations?: string | null;
  omit?: string[];
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
    '  "orchestrator-start|cd /work/install && bash orchestrator/launch.sh --detach"',
    '  "orchestrator-liveness|test -s /work/runtime/orchestrator.lease"',
    ")",
  ].join("\n"),
  ledgerChecker: 'const status = "UNKNOWN"; // absent inputs are not a pass\n',
  hostState: "# id\tlocation\tverify\nbot-token\t/root/.config/bpa/orchestrator.env\ttest -s /root/.config/bpa/orchestrator.env\n",
  bootstrap: 'bash "$REPO/tools/whisper/install.sh"\n',
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
  };
  for (const [path, content] of Object.entries(files)) if (!omit.has(path)) write(repo, path, content);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  if (options.attestations !== null) {
    const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
    write(repo, "instance/cutover-attestations.tsv", options.attestations ?? ["A", "E", "F"].map((gate) => `${gate}\t${head}\tproved`).join("\n") + "\n");
  }
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
  withFixture({ attestations: null }, (repo) => {
    const red = Bun.spawnSync([process.execPath, join(REAL_REPO, "tools/check-cutover-readiness.ts"), "--repo", repo]);
    expect(red.exitCode).toBe(1);
    expect(red.stdout.toString()).toContain("CUTOVER-READINESS A UNKNOWN");
  });
});

// --- UNKNOWN is never PASS --------------------------------------------------

test("gates proven outside the repository are UNKNOWN without an attestation, never PASS", () => {
  withFixture({ attestations: null }, (repo) => {
    expect(verdicts(repo)).toMatchObject({ A: "UNKNOWN", E: "UNKNOWN", F: "UNKNOWN" });
    expect(evidence(repo, "A")).toContain("no attestation file");
  });
});

test("a stale attestation does not certify the tree it no longer names", () => {
  withFixture({ attestations: `A\t${"0".repeat(40)}\tproved yesterday\n` }, (repo) => {
    expect(verdicts(repo).A).toBe("UNKNOWN");
    expect(evidence(repo, "A")).toContain("stale");
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

// --- gate B: launcher paths -------------------------------------------------

test("B extracts the launcher's executable paths and ignores runtime artifacts", () => {
  withFixture({}, (repo) => {
    const paths = requiredLauncherPaths(repo)!.map((entry) => entry.path);
    expect(paths).toEqual(["orchestrator/proc-identity.sh", "orchestrator/preflight-cli-auth.sh", "core/mission-cli.ts"]);
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
    expect(evidence(repo, "D")).toContain("neither starts the orchestrator nor asserts liveness");
  });
});

test("D FAILs when the orchestrator is started but no live state is asserted", () => {
  withFixture({ meteorite: 'commands=(\n  "start|bash orchestrator/launch.sh"\n)\n' }, (repo) => {
    expect(verdicts(repo).D).toBe("FAIL");
    expect(evidence(repo, "D")).toContain("asserts no live state");
  });
});

// --- gate E: one verdict, and absent inputs are UNKNOWN ---------------------

test("E FAILs when a check with absent inputs still passes", () => {
  withFixture({ ledgerChecker: 'const status = "SKIP"; // missing inbox is fine\n' }, (repo) => {
    expect(verdicts(repo).E).toBe("FAIL");
    expect(evidence(repo, "E")).toContain("no UNKNOWN outcome");
  });
});

test("E stays FAIL even with an attestation for the checkout-comparison half", () => {
  withFixture({ ledgerChecker: 'const status = "SKIP";\n' }, (repo) => {
    expect(verdicts(repo).E).toBe("FAIL");
    expect(evidence(repo, "E")).not.toContain("proved");
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
  withFixture({ bootstrap: "# installs everything except whisper\n" }, (repo) => {
    expect(verdicts(repo).G).toBe("FAIL");
    expect(evidence(repo, "G")).toContain("comes up without Whisper");
  });
});

test("G PASSes when the meteorite runs the installer on the clean machine", () => {
  withFixture({
    bootstrap: "# nothing here\n",
    meteorite: `${DEFAULTS.meteorite}\n"whisper|bash tools/whisper/install.sh"\n`,
  }, (repo) => {
    expect(verdicts(repo).G).toBe("PASS");
  });
});

test("G is UNKNOWN when the clean-server install path cannot be read", () => {
  withFixture({ omit: ["bootstrap/install.sh"] }, (repo) => {
    expect(verdicts(repo).G).toBe("UNKNOWN");
  });
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
  expect(report(results).exitCode).toBe(1);
});
