import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function reviewArtifact(directory: string, branch: string, sha: string): string {
  const path = join(directory, `${branch}.review.md`);
  writeFileSync(path, `verdict: ACCEPT\nreviewed-sha: ${sha}\n`);
  return path;
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

  test("rejects today's invented completed-review claim when its artifact is absent", () => {
    const item = fixture();
    const body = valid(item.sha).replace(
      "remaining: none",
      "review: independent Tier-A ACCEPT at 651355b03ff2e211df877697377dbe0aa33e2433;\n27 focused tests pass, 0 fail; no false-green or regression findings.\nremaining: none",
    );
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`FAIL review-artifact missing file=${join(item.directory, "master.review.md")}`);
  });

  test.each([
    "Review: ACCEPT",
    " review: ACCEPT",
    "review : ACCEPT",
    " Review : ACCEPT ",
  ])("rejects a visually equivalent review field without an artifact: %s", (claim) => {
    const item = fixture();
    const body = valid(item.sha).replace("remaining: none", `${claim}\nremaining: none`);
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`FAIL review-artifact missing file=${join(item.directory, "master.review.md")}`);
  });

  test.each([
    "```\nreview: example only\n```",
    "```text\nReview : example only\n```",
    "~~~~ markdown\n review: example only\n~~~~",
  ])("ignores review-looking lines inside a fenced block", (example) => {
    const item = fixture();
    const body = valid(item.sha).replace("remaining: none", `${example}\nremaining: none`);
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GUARD verdict=pass");
  });

  test.each([
    ["backtick", "```text\nreview: ACCEPT"],
    ["tilde", "~~~\nreview: ACCEPT"],
    ["info string", "~~~markdown\nreview: ACCEPT"],
    ["shorter closing run", "````\nexample\n```\nreview: ACCEPT"],
    ["two opens and one close", "```\nexample\n```\n~~~\nreview: ACCEPT"],
  ])("rejects an unterminated %s fence that would hide a review claim", (_case, fencedClaim) => {
    const item = fixture();
    const body = `${valid(item.sha)}${fencedClaim}`;
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL review-field unterminated-fenced-block");
  });

  test("ignores a quoted review-looking line", () => {
    const item = fixture();
    const body = valid(item.sha).replace("remaining: none", "> review: example only\nremaining: none");
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GUARD verdict=pass");
  });

  test("accepts a review claim backed by an ACCEPT artifact for the branch tip", () => {
    const item = fixture();
    reviewArtifact(item.directory, "master", item.sha);
    const body = valid(item.sha).replace("remaining: none", "review: independent Tier-A ACCEPT\nremaining: none");
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS review-artifact");
  });

  test("accepts a CRLF review field backed by an ACCEPT artifact", () => {
    const item = fixture();
    reviewArtifact(item.directory, "master", item.sha);
    const body = valid(item.sha).replace("remaining: none", "Review : independent ACCEPT\nremaining: none").replaceAll("\n", "\r\n");
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS review-artifact");
  });

  test.each([
    ["empty", "review: \n"],
    ["duplicate", "review: ACCEPT\nReview : ACCEPT\n"],
  ])("rejects a %s review field", (_case, fields) => {
    const item = fixture();
    const body = valid(item.sha).replace("remaining: none", `${fields}remaining: none`);
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL review-field must-occur-once-and-be-nonempty");
  });

  test.each(["directory", "symlink"])("rejects a %s review artifact", (kind) => {
    const item = fixture();
    const artifact = join(item.directory, "master.review.md");
    if (kind === "directory") mkdirSync(artifact);
    else {
      const target = join(item.directory, "review-target.md");
      writeFileSync(target, `verdict: ACCEPT\nreviewed-sha: ${item.sha}\n`);
      symlinkSync(target, artifact);
    }
    const body = valid(item.sha).replace("remaining: none", "review: ACCEPT\nremaining: none");
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL review-artifact unreadable-or-non-regular");
  });

  test("rejects a REJECT review artifact", () => {
    const item = fixture();
    const artifact = reviewArtifact(item.directory, "master", item.sha);
    writeFileSync(artifact, `verdict: REJECT\nreviewed-sha: ${item.sha}\n`);
    const body = valid(item.sha).replace("remaining: none", "review: rejected\nremaining: none");
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL review-artifact verdict-must-be-ACCEPT");
  });

  test("allows unrelated structured evidence fields without a review field", () => {
    const item = fixture();
    const fields = "manifest: consumed\nregression-evidence: retained\nconsumption-check: clean\n";
    const body = valid(item.sha).replace("remaining: none", `${fields}remaining: none`);
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GUARD verdict=pass");
  });

  test("rejects a review artifact naming a different SHA", () => {
    const item = fixture();
    reviewArtifact(item.directory, "master", "a".repeat(40));
    const body = valid(item.sha).replace("remaining: none", "review: independent Tier-A ACCEPT\nremaining: none");
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`FAIL review-artifact reviewed-sha-mismatch expected=${item.sha} actual=${"a".repeat(40)}`);
  });

  test("allows an honest pending review in remaining without a review field", () => {
    const item = fixture();
    const body = valid(item.sha).replace("remaining: none", "remaining: Tier-A review pending");
    const result = run(report(item.directory, body), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GUARD verdict=pass");
  });

  test("rejects a lane with no report file at all", () => {
    const item = fixture();
    const result = run(join(item.directory, "does-not-exist.md"), item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL report-file missing");
  });

  test("rejects a report committed into its own branch (impossible-to-satisfy convention)", () => {
    const item = fixture();
    const inTreeReport = join(item.repo, "report.md");
    writeFileSync(inTreeReport, valid(item.sha));
    command("git add report.md && git commit -m report", item.repo);
    const result = run(inTreeReport, item.repo, ["--branch", "master"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL branch-tip");
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

  // Bun indents its summary by one space. Measured on this host with `cat -A`:
  // " 2 pass$" / " 0 fail$" (on stderr). Fixtures here must reproduce those bytes
  // exactly, because the previous fixtures used an unindented shape bun never
  // emits -- so the suite stayed green while the parser could not read a single
  // real bun run. Copy THIS shape, not a friendlier one.
  test("accepts a claimed count only when it matches the verify command output", () => {
    const item = fixture();
    const body = valid(item.sha, "clean", "printf ' 2 pass\\n 0 fail\\n'")
      .replace("result:", "verify-count: 2/0\nresult:");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS verify-count 2/0");
  });

  // The regression lock proper: this fails against the pre-fix anchors
  // (/^([0-9]+) pass$/), which admitted no leading whitespace.
  test("reads a count from bun's own indented summary", () => {
    const item = fixture();
    const body = valid(item.sha, "clean", "printf ' 162 pass\\n 6 fail\\n' >&2")
      .replace("result:", "verify-count: 162/6\nresult:");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS verify-count 162/6");
  });

  // The fixture above is a transcription of bun's output; this one is bun's
  // output. If bun ever changes its indentation, this test is what notices --
  // a printf fixture would keep agreeing with a shape nothing produces.
  test("reads a count from a real bun test run", () => {
    const item = fixture();
    writeFileSync(
      join(item.directory, "sample.test.ts"),
      'import { expect, test } from "bun:test";\n' +
        'test("a", () => { expect(1).toBe(1); });\n' +
        'test("b", () => { expect(2).toBe(2); });\n',
    );
    const body = valid(item.sha, "clean", `cd ${item.directory} && bun test`)
      .replace("result:", "verify-count: 2/0\nresult:");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS verify-count 2/0");
  });

  // Widening whitespace must not weaken the anchor: a count in prose is not a
  // count, whatever whitespace surrounds the real one.
  test("does not harvest a count from mid-line prose", () => {
    const item = fixture();
    const body = valid(item.sha, "clean", "printf 'logged 999 pass earlier\\n 2 pass\\n 0 fail\\n'")
      .replace("result:", "verify-count: 2/0\nresult:");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS verify-count 2/0");
  });

  // Ambiguity protection is unchanged by the widening: two indented pass lines
  // are still two matches, and two matches are still unreadable.
  test("rejects a claimed count when the output has two indented pass lines", () => {
    const item = fixture();
    const body = valid(item.sha, "clean", "printf ' 2 pass\\n 0 fail\\n 3 pass\\n'")
      .replace("result:", "verify-count: 2/0\nresult:");
    const result = run(report(item.directory, body), item.repo);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("FAIL verify-count command-output-missing-unambiguous-pass/fail-count");
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
