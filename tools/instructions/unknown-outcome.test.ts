// Regression lock for V3-5.44 (cutover-ready gate E): "any check whose inputs
// are absent reports UNKNOWN, never PASS."
//
// Before this row the checker's vocabulary was PASS/WARN/FAIL/SKIP, so a check
// that could not read its inputs had two ways to look fine:
//
//   - it SKIPped — index-freshness with no index, hard-floor with no CLAUDE.md,
//     pack-coverage with no pack config, the ledger checks with no ledger, the
//     path check with no params.yaml, the inbox check on a capture mode that was
//     DEFAULTED to `manual` rather than declared;
//   - or it PASSed on a measurement of nothing — [session-load] happily reported
//     a comfortable line count for a load that had read no params, no ledger and
//     no corpus, so deleting standing context bought head-room under the cap.
//
// Every assertion below that says `not.toContain("SKIP ...")` or
// `.not.toBe("PASS")` is the red-before half of this lock: that is precisely
// what the pre-V3-5.44 checker printed for the same fixture.
//
// Hermeticity: every fixture is built by this file under its own temp dir and
// removed afterwards; the checker is spawned with the host's tuning and clock
// seams stripped, so no ambient env can move a verdict; and the determinism test
// asserts that a repeated run is byte-identical.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collectDocs } from "./docs.ts";
import { renderFloor, CLAUDE_FILENAME } from "./floor.ts";
import { checkHrStates, checkTriageClosures } from "./ledger.ts";
import { collectSessionLoad, runSessionLoadCheck } from "./session-load.ts";
import { blocks, instanceInputVerdict } from "./outcome.ts";

const checker = join(import.meta.dir, "check.ts");
const generator = join(import.meta.dir, "index.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// Every input the checker reads. `omit` names the ones this fixture is missing.
type Input = "claude" | "index" | "packConfig" | "params" | "decisions" | "triage";

const DOC = [
  "---",
  "id: valid-doc",
  "layer: L1",
  "status: binding",
  "audience: all",
  "tags: [hygiene]",
  "summary: A valid instruction doc.",
  "---",
  "",
  "Body.",
  "",
].join("\n");

// A complete installation: instructions corpus, both generated artifacts, and
// the instance/ layer with its config and ledgers. Named inputs are left out.
function installation(omit: Input[] = []): string {
  const repo = mkdtempSync(join(tmpdir(), "unknown-outcome-"));
  temporaryDirectories.push(repo);
  const missing = new Set(omit);

  const instructions = join(repo, "instructions");
  mkdirSync(instructions, { recursive: true });
  writeFileSync(join(instructions, "valid-doc.md"), DOC);

  mkdirSync(join(repo, "gate"), { recursive: true });
  writeFileSync(
    join(repo, "gate", "land-lib.sh"),
    readFileSync(join(import.meta.dir, "../../gate/land-lib.sh")),
  );

  // The instance/ layer. It always exists here: this is an INSTALLATION, and
  // absence of one input inside it is the case under test. (A repo with no
  // instance/ layer at all is the licensed-SKIP case, tested separately.)
  const instance = join(repo, "instance");
  mkdirSync(instance, { recursive: true });
  if (!missing.has("params")) writeFileSync(join(instance, "params.yaml"), "capture:\n  mode: manual\n");
  if (!missing.has("packConfig")) {
    writeFileSync(join(instance, "tags.conf"), "hygiene\n");
    writeFileSync(join(instance, "packs.conf"), "[coder]\nvalid-doc\n");
  }
  if (!missing.has("decisions")) {
    mkdirSync(join(instance, "decisions"), { recursive: true });
    if (!missing.has("triage")) writeFileSync(join(instance, "decisions", "triage.jsonl"), "");
  }

  if (!missing.has("index")) runIndex(repo);
  if (!missing.has("claude")) {
    writeFileSync(join(repo, CLAUDE_FILENAME), `# Fixture repo\n\n${renderFloor(collectDocs(instructions))}\n`);
  }
  return repo;
}

// Gate-like environment: the tuning and clock seams this tooling honours are
// stripped, so a verdict here is a property of the fixture and never of the
// host or of the operator's running orchestrator.
function gateEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "SESSION_LOAD_FAIL_LINES",
    "SESSION_LOAD_WARN_LINES",
    "LEDGER_NOW_MS",
    "INFRA_STATE_DB",
    "ORCH_STATE_DB",
  ]) {
    delete env[key];
  }
  return env;
}

function runCheck(repo: string, extra: string[] = []) {
  return spawnSync("bun", [checker, "--repo", repo, ...extra], { encoding: "utf8", env: gateEnv() });
}

function runIndex(repo: string) {
  return spawnSync("bun", [generator, "--repo", repo], { encoding: "utf8", env: gateEnv() });
}

describe("complete inputs keep their existing verdicts", () => {
  test("a complete installation is strict-clean with nothing unknown", () => {
    const result = runCheck(installation(), ["--strict"]);
    expect(result.stdout).toContain("0 FAIL, 0 UNKNOWN");
    expect(result.stdout).not.toContain("UNKNOWN ");
    expect(result.status).toBe(0);
  });

  test("the same fixture is byte-identical on a repeated run", () => {
    const repo = installation();
    expect(runCheck(repo, ["--strict"]).stdout).toBe(runCheck(repo, ["--strict"]).stdout);
  });
});

// The table. Each row: one absent input, and the check that can no longer form
// a verdict because of it. `previously` records what the pre-V3-5.44 checker
// printed for that same fixture — the behavior this lock exists to prevent.
const ABSENT_INPUT_CASES: Array<{
  input: Input;
  unknownLines: string[];
  previously: string;
}> = [
  {
    input: "claude",
    unknownLines: ["UNKNOWN CLAUDE.md [hard-floor]", "UNKNOWN CLAUDE.md [path-exists]"],
    previously: "SKIP CLAUDE.md",
  },
  {
    input: "index",
    unknownLines: ["UNKNOWN README.md [index-freshness]"],
    previously: "SKIP README.md",
  },
  {
    input: "packConfig",
    unknownLines: ["UNKNOWN instance/ [pack-coverage]"],
    previously: "SKIP instance/ [pack-coverage]",
  },
  {
    input: "decisions",
    unknownLines: ["UNKNOWN instance/decisions/ [ledger]"],
    previously: "SKIP instance/decisions/ [ledger]",
  },
  {
    input: "triage",
    unknownLines: ["UNKNOWN instance/decisions/triage.jsonl [ledger]"],
    previously: "SKIP instance/decisions/triage.jsonl",
  },
  {
    input: "params",
    // params.yaml is read by two different checks, and one of them — the
    // SessionStart budget — used to report a measured PASS over a load that had
    // never read it. That is the silent pass, not merely a quiet skip.
    unknownLines: ["UNKNOWN instance/params.yaml [path-exists]", "UNKNOWN session-load [session-load]"],
    previously: "PASS session-load [session-load]",
  },
];

describe("an absent input is UNKNOWN, never PASS and never a licensed SKIP", () => {
  for (const testCase of ABSENT_INPUT_CASES) {
    test(`missing ${testCase.input} → UNKNOWN`, () => {
      const result = runCheck(installation([testCase.input]));
      for (const line of testCase.unknownLines) expect(result.stdout).toContain(line);
      // Red-before: this is what the same fixture used to print.
      expect(result.stdout).not.toContain(testCase.previously);
    });
  }
});

describe("strict exit-code rule, locked in both directions", () => {
  // One representative absence per direction is not enough: the rule is about
  // the OUTCOME, so every case in the table is held to it.
  for (const testCase of ABSENT_INPUT_CASES) {
    test(`missing ${testCase.input}: visible and non-blocking lenient, blocking under --strict`, () => {
      const repo = installation([testCase.input]);

      const lenient = runCheck(repo);
      expect(lenient.status).toBe(0);
      expect(lenient.stdout).toContain("UNKNOWN ");
      expect(lenient.stdout).toContain("could not read their inputs and did not run");
      expect(lenient.stdout).not.toContain("0 UNKNOWN");

      const strict = runCheck(repo, ["--strict"]);
      expect(strict.status).toBe(1);
      // Blocking, and blocking on its own account: no FAIL is needed for it.
      expect(strict.stdout).toContain("0 FAIL,");
      expect(strict.stdout).not.toContain("could not read their inputs and did not run");
    });
  }

  test("blocks() is the single rule both modes are decided by", () => {
    expect(blocks("FAIL", false)).toBe(true);
    expect(blocks("FAIL", true)).toBe(true);
    expect(blocks("UNKNOWN", false)).toBe(false);
    expect(blocks("UNKNOWN", true)).toBe(true);
    for (const level of ["PASS", "WARN", "SKIP"] as const) {
      expect(blocks(level, true)).toBe(false);
      expect(blocks(level, false)).toBe(false);
    }
  });
});

describe("a declared non-applicability is still a SKIP", () => {
  test("capture.mode=manual keeps a missing inbox a SKIP, and it does not block", () => {
    const result = runCheck(installation(), ["--strict"]);
    expect(result.stdout).toContain("SKIP instance/decisions/inbox.jsonl [ledger]");
    expect(result.stdout).toContain("capture.mode=manual");
    expect(result.status).toBe(0);
  });

  test("a hand-written index declares itself unmanaged and stays a SKIP", () => {
    const repo = installation(["index"]);
    writeFileSync(join(repo, "instructions", "README.md"), "# Instructions\n\n- hand written\n");
    const result = runCheck(repo, ["--strict"]);
    expect(result.stdout).toContain("SKIP README.md [index-freshness]");
    expect(result.stdout).not.toContain("UNKNOWN README.md [index-freshness]");
  });

  test("a repo with no instance/ layer at all SKIPs the installation checks", () => {
    const repo = installation();
    rmSync(join(repo, "instance"), { recursive: true, force: true });
    const result = runCheck(repo, ["--strict"]);
    // The whole layer being absent IS the declaration (L2/L3 repos are born
    // without it), so these are not-applicable rather than unmeasured.
    expect(result.stdout).toContain("SKIP instance/ [pack-coverage]");
    expect(result.stdout).toContain("SKIP instance/decisions/ [ledger]");
    expect(result.stdout).toContain("SKIP instance/params.yaml [path-exists]");
    expect(result.status).toBe(0);
  });

  test("the same absent input is SKIP without instance/ and UNKNOWN with it", () => {
    const withLayer = installation(["params"]);
    const withoutLayer = installation(["params"]);
    rmSync(join(withoutLayer, "instance"), { recursive: true, force: true });
    expect(instanceInputVerdict(withLayer, "instance/params.yaml", "x").level).toBe("UNKNOWN");
    expect(instanceInputVerdict(withoutLayer, "instance/params.yaml", "x").level).toBe("SKIP");
  });
});

describe("session-load treats absent standing context as NO-GO", () => {
  test("absent params: UNKNOWN budget finding and a NO-GO startup verdict", () => {
    const repo = installation(["params"]);
    const finding = runSessionLoadCheck(repo);
    expect(finding.level).toBe("UNKNOWN");
    // Red-before: this measured a load with no params and returned PASS.
    expect(finding.level).not.toBe("PASS");
    expect(finding.detail).toContain("instance/params.yaml absent");

    const load = collectSessionLoad(repo);
    expect(load.unknown).toContain("instance/params.yaml absent");
    expect(load.text).toContain("startup: NO-GO");
    expect(load.text).not.toContain("startup: ready");
  });

  test("absent ledger: the load says so instead of reporting no open directives", () => {
    const load = collectSessionLoad(installation(["decisions"]));
    expect(load.unknown).toContain("instance/decisions/ absent");
    expect(load.text).not.toContain("(no open HR rows)");
    expect(load.text).toContain("startup: NO-GO");
  });

  test("complete standing context still measures and still PASSes", () => {
    const repo = installation();
    const finding = runSessionLoadCheck(repo);
    expect(finding.level).toBe("PASS");
    expect(finding.detail).toContain("lines");
    expect(collectSessionLoad(repo).unknown).toEqual([]);
  });
});

describe("the ledger checkers agree with the checker that reports them", () => {
  const NOW = Date.parse("2026-07-29T12:00:00.000Z");

  test("an absent decisions ledger is UNKNOWN in an installation", () => {
    const repo = installation(["decisions"]);
    for (const findings of [checkHrStates(repo, NOW), checkTriageClosures(repo, NOW)]) {
      expect(findings).toHaveLength(1);
      expect(findings[0].level).toBe("UNKNOWN");
      expect(findings[0].level).not.toBe("SKIP");
    }
  });

  test("an absent triage ledger alone is UNKNOWN, with the HR states still measured", () => {
    const repo = installation(["triage"]);
    expect(checkTriageClosures(repo, NOW)[0].level).toBe("UNKNOWN");
    expect(checkHrStates(repo, NOW).every((finding) => finding.level !== "UNKNOWN")).toBe(true);
  });
});
