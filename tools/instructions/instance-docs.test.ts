import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { collectRepoDocs } from "./docs.ts";

const composer = join(import.meta.dir, "compose.ts");
const checker = join(import.meta.dir, "check.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function doc(id: string, body = "Distinct instance body.\n"): string {
  return [
    "---",
    `id: ${id}`,
    "layer: L1",
    "status: binding",
    "audience: all",
    "tags: [instance]",
    "summary: Fixture document.",
    "---",
    "",
    body,
  ].join("\n");
}

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "instance-docs-"));
  temporaryDirectories.push(repo);
  mkdirSync(join(repo, "instructions"), { recursive: true });
  mkdirSync(join(repo, "instance", "operator"), { recursive: true });
  writeFileSync(join(repo, "instructions", "base.md"), doc("base-doc", "Base body.\n"));
  writeFileSync(join(repo, "instance", "tags.conf"), "instance\n");
  writeFileSync(join(repo, "instance", "packs.conf"), "[coder]\nbase-doc\n");
  writeFileSync(
    join(repo, "instance", "params.yaml"),
    "operator:\n  language: en\nphase:\n  current: sole-mission\n  active_scope: test\ncapture:\n  mode: manual\n",
  );
  return repo;
}

function run(script: string, repo: string, args: string[] = []) {
  return spawnSync("bun", [script, "--repo", repo, ...args], { encoding: "utf8" });
}

describe("explicitly packable instance documents", () => {
  test("an unlisted instance doc is not collected and cannot satisfy a baseline", () => {
    const repo = fixture();
    writeFileSync(join(repo, "instance", "operator", "core.md"), doc("operator-core"));
    writeFileSync(join(repo, "instance", "packs.conf"), "[coder]\noperator-core\n");

    expect(collectRepoDocs(repo).map((entry) => entry.valid?.id)).not.toContain("operator-core");
    const result = run(composer, repo, ["--role", "coder"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolves to no doc");
  });

  test("duplicate ids across instructions and configured instance docs fail check.ts", () => {
    const repo = fixture();
    writeFileSync(join(repo, "instance", "operator", "core.md"), doc("base-doc"));
    writeFileSync(join(repo, "instance", "packable-docs.conf"), "instance/operator/core.md\n");

    const result = run(checker, repo, ["--strict"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("FAIL ../instance/operator/core.md, base.md [id-uniqueness]");
    expect(result.stdout).toContain("id 'base-doc' declared in 2 files");
  });

  test("a configured path escaping instance is refused", () => {
    const repo = fixture();
    writeFileSync(join(repo, "instance", "packable-docs.conf"), "instance/../instructions/base.md\n");

    const result = run(composer, repo, ["--role", "coder"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("'..' segments are refused");
  });

  test("a configured symlink to a regular file is refused", () => {
    const repo = fixture();
    writeFileSync(join(repo, "instance", "operator", "target.md"), doc("operator-core"));
    symlinkSync("target.md", join(repo, "instance", "operator", "core.md"));
    writeFileSync(join(repo, "instance", "packable-docs.conf"), "instance/operator/core.md\n");

    const result = run(composer, repo, ["--role", "coder"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("regular file (symlinks are refused)");
  });

  test("a configured missing file is refused", () => {
    const repo = fixture();
    writeFileSync(join(repo, "instance", "packable-docs.conf"), "instance/operator/missing.md\n");

    const result = run(checker, repo, ["--strict"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("file does not exist");
  });
});
