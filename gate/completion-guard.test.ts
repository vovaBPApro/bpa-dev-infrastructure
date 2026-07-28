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

function valid(sha: string, result = "clean", verify = "true"): string {
  return `commit: ${sha} fixture\nverify: ${verify}\nresult: ${result}\nsecret-scan: clean\nremaining: none\n`;
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("completion guard", () => {
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
});
