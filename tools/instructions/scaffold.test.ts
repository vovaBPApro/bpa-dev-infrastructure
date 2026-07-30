import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readlinkSync, writeFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const scaffolder = join(import.meta.dir, "scaffold.ts");
// The L1 repo root is two levels up from tools/instructions/ — the tree that
// holds templates/agent-repo/ and instance/parked.md.
const L1 = join(import.meta.dir, "..", "..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// Returns a path to an empty temp dir that does NOT yet exist (scaffold creates
// it). We register the parent for cleanup.
function freshOut(): string {
  const parent = mkdtempSync(join(tmpdir(), "scaffold-"));
  temporaryDirectories.push(parent);
  return join(parent, "new-repo");
}

function runScaffold(args: string[]) {
  return spawnSync("bun", [scaffolder, "--l1", L1, ...args], { encoding: "utf8" });
}

function runCheck(repo: string, extra: string[] = []) {
  const checker = join(import.meta.dir, "check.ts");
  return spawnSync("bun", [checker, "--repo", repo, ...extra], { encoding: "utf8" });
}

type L1Pin = {
  schema: string;
  source: { repository: string; revision: string; path: string; sha256: string };
};

// Models a fresh session: start only at the generated repo, discover the
// conventional manifest, then resolve and authenticate its Git object reference
// against an available L1 checkout. No scaffold internals or network are used.
function discoverAndValidateL1Pin(repo: string, l1: string): L1Pin {
  const manifestPath = join(repo, "instructions", "L1_PIN.json");
  let pin: L1Pin;
  try {
    pin = JSON.parse(readFileSync(manifestPath, "utf8")) as L1Pin;
  } catch {
    throw new Error("L1 pin is missing or invalid JSON");
  }
  if (pin.schema !== "bpa.l1-bootstrap/v1") throw new Error(`unsupported L1 pin schema '${pin.schema}'`);
  if (pin.source.repository !== "bpa-dev-infrastructure") throw new Error("unexpected L1 repository");
  if (!/^[0-9a-f]{40}$/.test(pin.source.revision)) throw new Error("L1 revision is not a full commit SHA");
  if (pin.source.path !== "instructions/instruction-layers.md") throw new Error("unexpected L1 bootstrap path");
  if (!/^[0-9a-f]{64}$/.test(pin.source.sha256)) throw new Error("L1 bootstrap digest is invalid");

  const resolved = spawnSync("git", ["-C", l1, "show", `${pin.source.revision}:${pin.source.path}`]);
  if (resolved.status !== 0) throw new Error("pinned L1 reference does not resolve");
  const digest = createHash("sha256").update(resolved.stdout).digest("hex");
  if (digest !== pin.source.sha256) throw new Error("pinned L1 bootstrap digest does not match");
  return pin;
}

describe("scaffold.ts", () => {
  test("fresh session discovers and validates the pinned L1 bootstrap fail-closed", () => {
    const out = freshOut();
    const result = runScaffold(["--name", "discoverable", "--layer", "L3", "--mission", "m", "--out", out]);
    expect(result.status).toBe(0);

    const pin = discoverAndValidateL1Pin(out, L1);
    expect(pin.schema).toBe("bpa.l1-bootstrap/v1");

    const manifestPath = join(out, "instructions", "L1_PIN.json");
    const original = readFileSync(manifestPath, "utf8");
    const tampered = JSON.parse(original) as L1Pin;
    tampered.source.sha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => discoverAndValidateL1Pin(out, L1)).toThrow("digest does not match");

    rmSync(manifestPath);
    expect(() => discoverAndValidateL1Pin(out, L1)).toThrow("missing or invalid JSON");
  });

  test("L3 repo is born checker-clean (check.ts --strict, 0 FAIL)", () => {
    const out = freshOut();
    const result = runScaffold(["--name", "born-agent", "--layer", "L3", "--mission", "A born agent.", "--out", out]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("born-repo check");
    expect(result.stdout).toContain("0 FAIL");

    // Independent re-run of the checker confirms it, not just scaffold's echo.
    const check = runCheck(out, ["--strict"]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("0 FAIL");
  });

  test("L2 repo is born checker-clean and prints the parked-promotion TODO", () => {
    const out = freshOut();
    const result = runScaffold(["--name", "born-framework", "--layer", "L2", "--mission", "A born framework.", "--out", out]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 FAIL");
    // Promotion TODO with the real L1 parked rows.
    expect(result.stdout).toContain("Promotion TODO");
    expect(result.stdout).toContain("STACK_DECISION.md");
    expect(result.stdout).toContain("L2 (framework)");

    // The L2-only promotion note is written; the template-only files are not.
    expect(lstatSync(join(out, "L2_PARKED_PROMOTION.md")).isFile()).toBe(true);
    expect(() => lstatSync(join(out, "TEMPLATE.md"))).toThrow();

    const check = runCheck(out, ["--strict"]);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("0 FAIL");
  });

  test("placeholder substitution is complete (no {{ remains)", () => {
    const out = freshOut();
    runScaffold(["--name", "sub-check", "--layer", "L3", "--mission", "Mission text here.", "--out", out]);
    const claude = readFileSync(join(out, "CLAUDE.md"), "utf8");
    expect(claude).not.toContain("{{");
    expect(claude).not.toContain("}}");
    // The three placeholders resolved to their values.
    expect(claude).toContain("sub-check");
    expect(claude).toContain("Mission text here.");
    expect(claude).toContain("L3 repository");
  });

  test("multi-line mission substitutes into the Mission block", () => {
    const out = freshOut();
    const mission = "Line one.\nLine two.";
    runScaffold(["--name", "multiline", "--layer", "L3", "--mission", mission, "--out", out]);
    const claude = readFileSync(join(out, "CLAUDE.md"), "utf8");
    expect(claude).toContain("Line one.\nLine two.");
    expect(claude).not.toContain("{{MISSION}}");
  });

  test("AGENTS.md is a symlink pointing at CLAUDE.md", () => {
    const out = freshOut();
    runScaffold(["--name", "symlinked", "--layer", "L3", "--mission", "m", "--out", out]);
    const agents = join(out, "AGENTS.md");
    expect(lstatSync(agents).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agents)).toBe("CLAUDE.md");
    // Following the symlink yields the same bytes as CLAUDE.md.
    expect(readFileSync(agents, "utf8")).toBe(readFileSync(join(out, "CLAUDE.md"), "utf8"));
  });

  test("the generated index carries the generator marker", () => {
    const out = freshOut();
    runScaffold(["--name", "indexed", "--layer", "L3", "--mission", "m", "--out", out]);
    const index = readFileSync(join(out, "instructions", "README.md"), "utf8");
    expect(index).toContain("<!-- generated by tools/instructions/index.ts -->");
  });

  test("the CLAUDE.md Hard Floor is a single generated section (no drift)", () => {
    const out = freshOut();
    runScaffold(["--name", "floored", "--layer", "L3", "--mission", "m", "--out", out]);
    const claude = readFileSync(join(out, "CLAUDE.md"), "utf8");
    // Exactly one begin marker and one end marker.
    expect((claude.match(/<!-- hard-floor:begin -->/g) ?? []).length).toBe(1);
    expect((claude.match(/<!-- hard-floor:end -->/g) ?? []).length).toBe(1);
    // No duplicated "## Hard Floor" heading (the section heading lives once,
    // inside the generated block — matching the L1 exemplar).
    expect((claude.match(/^## Hard Floor$/gm) ?? []).length).toBe(1);
  });

  test("refuses to scaffold into a non-empty directory", () => {
    const out = freshOut();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "existing.txt"), "do not clobber me");
    const result = runScaffold(["--name", "x", "--layer", "L3", "--mission", "m", "--out", out]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not empty");
    // The pre-existing file is untouched.
    expect(readFileSync(join(out, "existing.txt"), "utf8")).toBe("do not clobber me");
  });

  test("scaffolds into an existing empty directory", () => {
    const out = freshOut();
    mkdirSync(out, { recursive: true });
    const result = runScaffold(["--name", "into-empty", "--layer", "L3", "--mission", "m", "--out", out]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 FAIL");
  });

  test("refuses a target that exists as a file", () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-file-"));
    temporaryDirectories.push(parent);
    const out = join(parent, "afile");
    writeFileSync(out, "i am a file");
    const result = runScaffold(["--name", "x", "--layer", "L3", "--mission", "m", "--out", out]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a directory");
  });

  test("L3 scaffold does not write the L2-only promotion note or print the TODO", () => {
    const out = freshOut();
    const result = runScaffold(["--name", "l3-clean", "--layer", "L3", "--mission", "m", "--out", out]);
    expect(result.stdout).not.toContain("Promotion TODO");
    expect(() => lstatSync(join(out, "L2_PARKED_PROMOTION.md"))).toThrow();
  });

  describe("argument validation", () => {
    test("missing --name fails usage", () => {
      const result = runScaffold(["--layer", "L3", "--mission", "m", "--out", freshOut()]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--name is required");
    });

    test("missing --mission fails usage", () => {
      const result = runScaffold(["--name", "x", "--layer", "L3", "--out", freshOut()]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--mission is required");
    });

    test("empty --mission is refused", () => {
      const result = runScaffold(["--name", "x", "--layer", "L3", "--mission", "   ", "--out", freshOut()]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--mission is required");
    });

    test("bad --layer fails usage", () => {
      const result = runScaffold(["--name", "x", "--layer", "L9", "--mission", "m", "--out", freshOut()]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--layer must be one of");
    });

    test("--help exits zero with usage", () => {
      const result = runScaffold(["--help"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage:");
    });

    test("missing template (wrong --l1) fails cleanly", () => {
      const bogus = mkdtempSync(join(tmpdir(), "scaffold-nol1-"));
      temporaryDirectories.push(bogus);
      const result = spawnSync(
        "bun",
        [scaffolder, "--l1", bogus, "--name", "x", "--layer", "L3", "--mission", "m", "--out", freshOut()],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("template not found");
    });
  });
});
