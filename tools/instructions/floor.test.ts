import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collectDocs } from "./docs.ts";
import {
  renderFloor,
  replaceFloorSection,
  extractFloorSection,
  collectFloorLines,
  FloorError,
  FLOOR_BEGIN,
  FLOOR_END,
} from "./floor.ts";

const floorCli = join(import.meta.dir, "floor.ts");
const checker = join(import.meta.dir, "check.ts");
const generator = join(import.meta.dir, "index.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function doc(front: Record<string, string>, body = "Body.\n"): string {
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

const VALID = {
  id: "valid-doc",
  layer: "L1",
  status: "binding",
  audience: "all",
  tags: "[hygiene]",
  summary: "A valid instruction doc.",
};

// Builds a repo with instructions/ from a file map and (optionally) a CLAUDE.md
// carrying empty hard-floor markers. Returns the repo root.
function repoWith(files: Record<string, string>, claude?: string): string {
  const repo = mkdtempSync(join(tmpdir(), "instr-floor-"));
  temporaryDirectories.push(repo);
  const root = join(repo, "instructions");
  mkdirSync(root, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  if (claude !== undefined) writeFileSync(join(repo, "CLAUDE.md"), claude);
  return repo;
}

const CLAUDE_WITH_MARKERS = `# Title\n\nIntro.\n\n${FLOOR_BEGIN}\n${FLOOR_END}\n\n## More\n\nTail.\n`;

function runFloor(repo: string, extra: string[] = []) {
  return spawnSync("bun", [floorCli, "--repo", repo, ...extra], { encoding: "utf8" });
}
function runCheck(repo: string, extra: string[] = []) {
  return spawnSync("bun", [checker, "--repo", repo, ...extra], { encoding: "utf8" });
}
function runIndex(repo: string, extra: string[] = []) {
  return spawnSync("bun", [generator, "--repo", repo, ...extra], { encoding: "utf8" });
}

describe("renderFloor (unit)", () => {
  test("orders lines by source id, deterministically and idempotently", () => {
    const repo = repoWith({
      "zeta.md": doc({ ...VALID, id: "zeta-rule", floor: "true", "floor-line": "Zeta imperative." }),
      "alpha.md": doc({ ...VALID, id: "alpha-rule", floor: "true", "floor-line": "Alpha imperative." }),
    });
    const docs = collectDocs(join(repo, "instructions"));
    const first = renderFloor(docs);
    // Sorted by id: alpha before zeta.
    expect(first.indexOf("Alpha imperative")).toBeLessThan(first.indexOf("Zeta imperative"));
    expect(first).toContain("1. Alpha imperative. (`alpha-rule`)");
    expect(first).toContain("2. Zeta imperative. (`zeta-rule`)");
    expect(first.startsWith(FLOOR_BEGIN)).toBe(true);
    expect(first.endsWith(FLOOR_END)).toBe(true);
    // Idempotent.
    expect(renderFloor(collectDocs(join(repo, "instructions")))).toBe(first);
  });

  test("ignores docs without floor: true", () => {
    const repo = repoWith({
      "on.md": doc({ ...VALID, id: "on-rule", floor: "true", "floor-line": "Included." }),
      "off.md": doc({ ...VALID, id: "off-rule" }),
      "false.md": doc({ ...VALID, id: "false-rule", floor: "false", "floor-line": "Excluded." }),
    });
    const rendered = renderFloor(collectDocs(join(repo, "instructions")));
    expect(rendered).toContain("Included.");
    expect(rendered).not.toContain("Excluded.");
    expect(collectFloorLines(collectDocs(join(repo, "instructions")))).toHaveLength(1);
  });

  test("floor: true without floor-line throws FloorError", () => {
    const repo = repoWith({ "bad.md": doc({ ...VALID, id: "bad-rule", floor: "true" }) });
    const docs = collectDocs(join(repo, "instructions"));
    expect(() => renderFloor(docs)).toThrow(FloorError);
  });

  test("more than 10 floor lines throws (ceiling)", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 11; i += 1) {
      files[`f${i}.md`] = doc({ ...VALID, id: `rule-${i}`, floor: "true", "floor-line": `Line ${i}.` });
    }
    const docs = collectDocs(join(repoWith(files), "instructions"));
    expect(() => renderFloor(docs)).toThrow(/exceeds the ceiling/);
  });
});

describe("replaceFloorSection / extractFloorSection (unit)", () => {
  test("replaces marker-to-marker content, preserving surrounding text", () => {
    const rendered = `${FLOOR_BEGIN}\nNEW\n${FLOOR_END}`;
    const out = replaceFloorSection(CLAUDE_WITH_MARKERS, rendered);
    expect(out).toContain("Intro.");
    expect(out).toContain("Tail.");
    expect(out).toContain("NEW");
    expect(extractFloorSection(out)).toBe(rendered);
  });

  test("missing marker throws FloorError", () => {
    expect(() => replaceFloorSection("# no markers here\n", "x")).toThrow(FloorError);
    expect(extractFloorSection("# no markers here\n")).toBeUndefined();
  });

  test("duplicated markers throw FloorError", () => {
    const dup = `${FLOOR_BEGIN}\n${FLOOR_END}\n${FLOOR_BEGIN}\n${FLOOR_END}\n`;
    expect(() => replaceFloorSection(dup, "x")).toThrow(/duplicated/);
  });

  test("out-of-order markers throw FloorError", () => {
    const bad = `${FLOOR_END}\ntext\n${FLOOR_BEGIN}\n`;
    expect(() => replaceFloorSection(bad, "x")).toThrow(/out of order/);
  });
});

describe("floor.ts CLI", () => {
  test("--check prints the section without writing CLAUDE.md", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true", "floor-line": "Do the thing." }) },
      CLAUDE_WITH_MARKERS,
    );
    const before = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    const result = runFloor(repo, ["--check"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Do the thing.");
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(before);
  });

  test("writes the section into CLAUDE.md, idempotently", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true", "floor-line": "Do the thing." }) },
      CLAUDE_WITH_MARKERS,
    );
    expect(runFloor(repo).status).toBe(0);
    const first = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    expect(first).toContain("Do the thing.");
    expect(first).toContain("Intro.");
    expect(first).toContain("Tail.");
    // Second run is a no-op (byte-identical).
    expect(runFloor(repo).status).toBe(0);
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toBe(first);
  });

  test("missing marker exits non-zero", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true", "floor-line": "X." }) },
      "# CLAUDE with no markers\n",
    );
    const result = runFloor(repo);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("missing a hard-floor marker");
  });

  test("floor: true without floor-line exits non-zero", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true" }) },
      CLAUDE_WITH_MARKERS,
    );
    const result = runFloor(repo);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("no floor-line");
  });
});

describe("index.ts also refreshes the floor", () => {
  test("index write regenerates the CLAUDE.md hard floor", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true", "floor-line": "Floor via index." }) },
      CLAUDE_WITH_MARKERS,
    );
    const result = runIndex(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("updated Hard Floor");
    expect(readFileSync(join(repo, "CLAUDE.md"), "utf8")).toContain("Floor via index.");
  });

  test("index without CLAUDE.md still succeeds", () => {
    const repo = repoWith({ "r.md": doc({ ...VALID, id: "r-rule" }) });
    expect(runIndex(repo).status).toBe(0);
  });
});

describe("check.ts [hard-floor]", () => {
  test("PASS when the section is up to date", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true", "floor-line": "Aligned." }) },
      CLAUDE_WITH_MARKERS,
    );
    expect(runFloor(repo).status).toBe(0); // materialize the section
    expect(runIndex(repo).status).toBe(0); // keep the generated index fresh too
    const result = runCheck(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS CLAUDE.md [hard-floor]");
  });

  test("FAIL on drift (hand-edited section)", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true", "floor-line": "Canonical." }) },
      CLAUDE_WITH_MARKERS,
    );
    runFloor(repo);
    runIndex(repo);
    // Hand-edit inside the markers.
    const path = join(repo, "CLAUDE.md");
    const drifted = readFileSync(path, "utf8").replace("Canonical.", "Tampered.");
    writeFileSync(path, drifted);
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL CLAUDE.md [hard-floor]");
    expect(result.stdout).toContain("drifted");
  });

  test("FAIL when markers are missing", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true", "floor-line": "X." }) },
      "# CLAUDE no markers\n",
    );
    runIndex(repo);
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL CLAUDE.md [hard-floor]");
    expect(result.stdout).toContain("markers missing");
  });

  test("FAIL when a floor doc lacks its floor-line", () => {
    const repo = repoWith(
      { "r.md": doc({ ...VALID, id: "r-rule", floor: "true" }) },
      CLAUDE_WITH_MARKERS,
    );
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL CLAUDE.md [hard-floor]");
    expect(result.stdout).toContain("no floor-line");
  });

  // Was "SKIP when the repo has no CLAUDE.md" until V3-5.44. A SKIP reads as
  // "not applicable here", and nothing declares that a repo has no root agent
  // contract — the floor simply went uncompared. The outcome is UNKNOWN, and
  // under --strict it blocks.
  test("UNKNOWN when the repo has no CLAUDE.md, and --strict blocks on it", () => {
    const repo = repoWith({ "r.md": doc({ ...VALID, id: "r-rule" }) });
    runIndex(repo);
    const lenient = runCheck(repo);
    expect(lenient.stdout).toContain("UNKNOWN CLAUDE.md [hard-floor]");
    expect(lenient.stdout).toContain("the Hard Floor cannot be compared");
    expect(lenient.stdout).not.toContain("SKIP CLAUDE.md [hard-floor]");
    // Visible without --strict, and non-blocking there.
    expect(lenient.status).toBe(0);

    const strict = runCheck(repo, ["--strict"]);
    expect(strict.stdout).toContain("UNKNOWN CLAUDE.md [hard-floor]");
    expect(strict.status).toBe(1);
  });
});
