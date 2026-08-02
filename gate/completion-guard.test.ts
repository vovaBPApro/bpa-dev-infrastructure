import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const temporaryDirectories: string[] = [];
const guard = join(import.meta.dir, "completion-guard.ts");

function command(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr}`);
}

function fixture(): { directory: string; repo: string; sha: string } {
  const directory = mkdtempSync(join(tmpdir(), "completion-guard-"));
  temporaryDirectories.push(directory);
  const repo = join(directory, "repo");
  command(`git init ${repo}`, directory);
  command("git config user.email guard@example.test", repo);
  command("git config user.name Guard", repo);
  writeFileSync(join(repo, "evidence.txt"), "evidence\n");
  command("git add evidence.txt && git commit -m fixture", repo);
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  return { directory, repo, sha };
}

function report(directory: string, body: string): string {
  const path = join(directory, "report.md");
  writeFileSync(path, body);
  return path;
}

function run(reportPath: string, repo: string, extra: string[] = []) {
  return spawnSync("bun", [guard, "--report", reportPath, "--repo", repo, ...extra], { encoding: "utf8" });
}

function runHelp() {
  return spawnSync("bun", [guard, "--help"], { encoding: "utf8" });
}

function valid(sha: string, result = "clean", verify = "true"): string {
  return `commit: ${sha} fixture\nverify: ${verify}\nresult: ${result}\nsecret-scan: clean\nremaining: none\n`;
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("completion guard", () => {
  test("prints usage with --help", () => {
    const result = runHelp();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain("0 pass");
  });

  test("passes a valid report", () => {
    const item = fixture();
    const result = run(report(item.directory, valid(item.sha)), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GUARD verdict=pass");
  });

  test("rejects a missing SHA line", () => {
    const item = fixture();
    const result = run(report(item.directory, "verify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n"), item.repo);
    expect(result.status).toBe(2);
  });

  test("rejects a nonexistent SHA", () => {
    const item = fixture();
    const result = run(report(item.directory, valid("a".repeat(40))), item.repo);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL commit-exists");
  });

  test("rejects an ancestor SHA when branch tip is newer", () => {
    const item = fixture();
    const staleSha = item.sha;
    writeFileSync(join(item.repo, "later.txt"), "later\n");
    command("git add later.txt && git commit -m later", item.repo);
    const result = run(report(item.directory, valid(staleSha)), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL branch-tip");
  });

  test("rejects result=done", () => {
    const item = fixture();
    const result = run(report(item.directory, valid(item.sha, "done")), item.repo);
    expect(result.status).toBe(2);
  });

  test("rejects a missing secret-scan line", () => {
    const item = fixture();
    const result = run(report(item.directory, `commit: ${item.sha} fixture\nverify: true\nresult: clean\nremaining: none\n`), item.repo);
    expect(result.status).toBe(2);
  });

  test("returns 3 for an honest NO-GO", () => {
    const item = fixture();
    const result = run(report(item.directory, valid(item.sha, "NO-GO")), item.repo);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("GUARD verdict=no-go");
  });

  test("rejects a failing verification command", () => {
    const item = fixture();
    const result = run(report(item.directory, valid(item.sha, "clean", "false")), item.repo, ["--run-verify"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL verify-run");
  });

  test("rejects a claimed count that disagrees with the verify command output", () => {
    const item = fixture();
    const body = valid(item.sha, "clean", "printf '162 pass\\n6 fail\\n'")
      .replace("result:", "verify-count: 168/168\nresult:");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL verify-count mismatch report=168/168 actual=162/6");
    expect(result.stdout).toContain("GUARD verdict=violation");
  });

  test("accepts a claimed count only when it matches the verify command output", () => {
    const item = fixture();
    const body = valid(item.sha, "clean", "printf '179 pass\\n0 fail\\n'")
      .replace("result:", "verify-count: 179/0\nresult:");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS verify-count 179/0");
  });

  test("rejects a typed count outside the provenance-checked field", () => {
    const item = fixture();
    const body = valid(item.sha).replace("remaining: none", "remaining: genuine 179/0");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL verify-count test-count-claim-must-use-verify-count-field");
  });

  test("rejects a prose count outside the provenance-checked field", () => {
    const item = fixture();
    const body = valid(item.sha, "clean", "printf '2 pass\\n0 fail\\n'")
      .replace("remaining: none", "remaining: claimed 999 tests passed, 0 failed");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL verify-count test-count-claim-must-use-verify-count-field");
    expect(result.stdout).toContain("GUARD verdict=violation");
  });

  test("rejects a claimed count when verify output has no parseable count", () => {
    const item = fixture();
    const body = valid(item.sha)
      .replace("verify: true", "verify: printf 'tests succeeded\\n'")
      .replace("result:", "verify-count: 1/0\nresult:");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL verify-count command-output-missing-unambiguous-pass/fail-count");
  });
});
