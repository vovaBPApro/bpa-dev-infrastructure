import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const checker = join(import.meta.dir, "check.ts");
const generator = join(import.meta.dir, "index.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// Builds a throwaway repo with an instructions/ dir populated from a map of
// relative filename -> file contents. Returns the repo root.
function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "instr-check-"));
  temporaryDirectories.push(repo);
  const root = join(repo, "instructions");
  mkdirSync(root, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return repo;
}

function doc(front: Record<string, string>, body = "Body.\n"): string {
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

function runCheck(repo: string, extra: string[] = []) {
  return spawnSync("bun", [checker, "--repo", repo, ...extra], { encoding: "utf8" });
}

function runIndex(repo: string, extra: string[] = []) {
  return spawnSync("bun", [generator, "--repo", repo, ...extra], { encoding: "utf8" });
}

const VALID = {
  id: "valid-doc",
  layer: "L1",
  status: "binding",
  audience: "all",
  tags: "[hygiene]",
  summary: "A valid instruction doc.",
};

describe("check.ts", () => {
  test("a valid doc passes and exits zero", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    const result = runCheck(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS valid-doc.md [schema]");
    expect(result.stdout).toContain("0 FAIL");
  });

  test("missing frontmatter is WARN by default, FAIL under --strict", () => {
    const repo = repoWith({ "bare.md": "# No frontmatter\n\nJust prose.\n" });

    const lenient = runCheck(repo);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("WARN bare.md [frontmatter]");

    const strict = runCheck(repo, ["--strict"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("FAIL bare.md [frontmatter]");
  });

  test("duplicate id fails", () => {
    const repo = repoWith({
      "a.md": doc({ ...VALID, id: "same-id" }),
      "b.md": doc({ ...VALID, id: "same-id" }),
    });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("id-uniqueness");
    expect(result.stdout).toContain("'same-id'");
  });

  test("bad enum value fails schema", () => {
    const repo = repoWith({ "x.md": doc({ ...VALID, layer: "L9" }) });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL x.md [schema]");
    expect(result.stdout).toContain("layer must be one of");
  });

  test("bad id (not kebab-case) fails schema", () => {
    const repo = repoWith({ "x.md": doc({ ...VALID, id: "Not_Kebab" }) });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("kebab-case");
  });

  test("dangling decision reference is reported as FAIL", () => {
    const repo = repoWith({
      "x.md": doc({ ...VALID, id: "referrer", decision: "[hr-does-not-exist]" }),
    });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("decision-reference");
    expect(result.stdout).toContain("hr-does-not-exist");
  });

  test("resolvable decision reference passes; cross-tree id is only a WARN", () => {
    const repo = repoWith({
      "target.md": doc({ ...VALID, id: "target-doc" }),
      "referrer.md": doc({ ...VALID, id: "referrer-doc", decision: "[target-doc, l2:framework-rule]" }),
    });
    const result = runCheck(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WARN referrer.md [decision-reference]");
    expect(result.stdout).toContain("l2:framework-rule");
    // No FAIL findings (the summary line's "0 FAIL" count is not a finding line).
    expect(result.stdout).not.toContain("FAIL referrer.md");
    expect(result.stdout).toContain("0 FAIL");
  });

  test("hand-written index (no marker) is SKIP, not FAIL", () => {
    const repo = repoWith({
      "valid-doc.md": doc(VALID),
      "README.md": "# Instructions\n\n- hand written\n",
    });
    const result = runCheck(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP README.md [index-freshness]");
  });

  test("index-freshness: PASS after generation, FAIL when a doc is added", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });

    // Generate the marked index, then the checker should see it fresh.
    expect(runIndex(repo).status).toBe(0);
    const fresh = runCheck(repo);
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain("PASS README.md [index-freshness]");

    // Add a doc without regenerating -> stale index is a FAIL.
    writeFileSync(join(repo, "instructions", "second.md"), doc({ ...VALID, id: "second-doc" }));
    const stale = runCheck(repo);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("FAIL README.md [index-freshness]");
  });

  test("missing instructions/ directory fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "instr-empty-"));
    temporaryDirectories.push(repo);
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("root");
  });
});

describe("index.ts", () => {
  test("generates a marked index sorted by id, idempotently", () => {
    const repo = repoWith({
      "zeta.md": doc({ ...VALID, id: "zeta-doc", summary: "Zeta summary." }),
      "alpha.md": doc({ ...VALID, id: "alpha-doc", summary: "Alpha summary." }),
    });
    expect(runIndex(repo).status).toBe(0);
    const first = readFileSync(join(repo, "instructions", "README.md"), "utf8");
    expect(first).toContain("<!-- generated by tools/instructions/index.ts -->");
    // alpha-doc sorts before zeta-doc.
    expect(first.indexOf("alpha.md")).toBeLessThan(first.indexOf("zeta.md"));
    expect(first).toContain("Alpha summary.");

    // Idempotent: a second run yields byte-identical output.
    expect(runIndex(repo).status).toBe(0);
    const second = readFileSync(join(repo, "instructions", "README.md"), "utf8");
    expect(second).toBe(first);
  });

  test("--check prints without writing", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    const result = runIndex(repo, ["--check"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("<!-- generated by tools/instructions/index.ts -->");
    // No README written.
    expect(() => readFileSync(join(repo, "instructions", "README.md"), "utf8")).toThrow();
  });
});
