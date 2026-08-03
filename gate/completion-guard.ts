#!/usr/bin/env bun

import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lineValue } from "./report-contract";

type Options = {
  report?: string;
  repo?: string;
  branch?: string;
  runVerify: boolean;
  deferVerify: boolean;
};

type Report = {
  commit: string;
  verify: string;
  verifyCount?: string;
  result: string;
  secretScan: string;
  remaining: string;
};

const failures: string[] = [];

function pass(check: string, detail = ""): void {
  console.log(`PASS ${check}${detail ? ` ${detail}` : ""}`);
}

function fail(check: string, detail: string): void {
  console.log(`FAIL ${check} ${detail}`);
  failures.push(`${check}: ${detail}`);
}

function usage({ stdout = false, exitCode = 2 } = {}): never {
  const message = [
    "Usage: bun gate/completion-guard.ts --report <file> --repo <path> [--branch <name>] [--run-verify]",
    "",
    "Options:",
    "  --report <file>    Path to completion report (required)",
    "  --repo <path>      Path to repository (required)",
    "  --branch <name>    Verify commit is reachable from this branch",
    "  --run-verify       Run the report's verify command",
    "  -h, --help         Show this usage",
    "",
    "Exit codes:",
    "  0 pass",
    "  2 contract violation",
    "  3 valid report declaring NO-GO",
  ].join("\n");
  const output = stdout ? process.stdout : process.stderr;
  output.write(message + "\n");
  process.exit(exitCode);
}

function parseArgs(args: string[]): Options {
  const options: Options = { runVerify: false, deferVerify: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      usage({ stdout: true, exitCode: 0 });
    }
    if (arg === "--run-verify") {
      options.runVerify = true;
      continue;
    }
    if (arg === "--defer-verify") {
      options.deferVerify = true;
      continue;
    }
    if (arg === "--report" || arg === "--repo" || arg === "--branch") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) usage();
      if (arg === "--report") options.report = value;
      if (arg === "--repo") options.repo = value;
      if (arg === "--branch") options.branch = value;
      index += 1;
      continue;
    }
    usage();
  }
  if (!options.report || !options.repo) usage();
  return options;
}

function hasUnstructuredCountClaim(contents: string): boolean {
  const countClaimPatterns = [
    /\b[0-9]+\s*(?:pass(?:ed)?)?\s*\/\s*[0-9]+\s*(?:fail(?:ed)?)?\b/i,
    /\b[0-9]+\s+(?:tests?\s+)?pass(?:ed)?\b[^\r\n]{0,40}\b[0-9]+\s+(?:tests?\s+)?fail(?:ed)?\b/i,
    /\b[0-9]+\s+(?:tests?\s+)?fail(?:ed)?\b[^\r\n]{0,40}\b[0-9]+\s+(?:tests?\s+)?pass(?:ed)?\b/i,
  ];
  return contents
    .split(/\r?\n/)
    .filter((line) => !/^verify(?:-count)?:/.test(line))
    .some((line) => countClaimPatterns.some((pattern) => pattern.test(line)));
}

function git(repo: string, args: string[]) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function outputTail(output: string): string {
  const lines = output.trim().split("\n").filter(Boolean);
  return lines.slice(-10).join(" | ").slice(-200) || "(no output)";
}

function parseReportedCount(value: string): { passed: number; failed: number } | undefined {
  const match = value.match(/^([0-9]+)\/([0-9]+)$/);
  if (!match) return undefined;
  return { passed: Number(match[1]), failed: Number(match[2]) };
}

function parseVerificationCount(output: string): { passed: number; failed: number } | undefined {
  const passed = [...output.matchAll(/^([0-9]+) pass(?:ed)?$/gim)];
  const failed = [...output.matchAll(/^([0-9]+) fail(?:ed)?$/gim)];
  if (passed.length !== 1 || failed.length !== 1) return undefined;
  return { passed: Number(passed[0][1]), failed: Number(failed[0][1]) };
}

function runVerification(repo: string, sha: string, command: string) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "completion-verify-"));
  const checkout = join(temporaryRoot, "checkout");
  const added = git(repo, ["worktree", "add", "--detach", checkout, sha]);
  if (added.status !== 0) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    return { status: added.status, stdout: added.stdout, stderr: added.stderr };
  }
  try {
    return spawnSync(command, { cwd: checkout, shell: true, encoding: "utf8" });
  } finally {
    git(repo, ["worktree", "remove", "--force", checkout]);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
const reportPath = resolve(options.report!);
const repoPath = resolve(options.repo!);
let report: Report | undefined;

function reviewFieldValues(contents: string): string[] {
  const values: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of contents.split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^\s{0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
      continue;
    }

    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})(?:[^\r\n]*)$/);
    if (opening) {
      fence = { marker: opening[1][0] as "`" | "~", length: opening[1].length };
      continue;
    }

    const field = line.match(/^\s*review\s*:\s*(.*)$/i);
    if (field) values.push(field[1].trim());
  }

  return values;
}

function checkClaimedReview(contents: string, commit: string | undefined): void {
  const reviewFields = reviewFieldValues(contents);
  if (reviewFields.length === 0) return;
  if (reviewFields.length !== 1 || !reviewFields[0]) {
    fail("review-field", "must-occur-once-and-be-nonempty");
    return;
  }
  if (!options.branch) {
    fail("review-artifact", "branch-required-to-resolve-artifact");
    return;
  }
  const artifactPath = join(dirname(reportPath), `${options.branch}.review.md`);
  if (!existsSync(artifactPath)) {
    fail("review-artifact", `missing file=${artifactPath}`);
    return;
  }
  try {
    if (!lstatSync(artifactPath).isFile()) {
      fail("review-artifact", `unreadable-or-non-regular file=${artifactPath}`);
      return;
    }
    const artifact = readFileSync(artifactPath, "utf8");
    const verdict = lineValue(artifact, "verdict");
    const reviewedSha = lineValue(artifact, "reviewed-sha");
    const expectedSha = commit?.split(/\s+/, 1)[0];
    if (verdict !== "ACCEPT") {
      fail("review-artifact", `verdict-must-be-ACCEPT file=${artifactPath}`);
    } else if (!reviewedSha || !/^[0-9a-f]{40}$/i.test(reviewedSha)) {
      fail("review-artifact", `malformed-reviewed-sha file=${artifactPath}`);
    } else if (!expectedSha || reviewedSha.toLowerCase() !== expectedSha.toLowerCase()) {
      fail("review-artifact", `reviewed-sha-mismatch expected=${expectedSha ?? "missing"} actual=${reviewedSha} file=${artifactPath}`);
    } else {
      pass("review-artifact", artifactPath);
    }
  } catch {
    fail("review-artifact", `unreadable-or-non-regular file=${artifactPath}`);
  }
}

if (!existsSync(reportPath)) {
  fail("report-file", "missing");
} else {
  const contents = readFileSync(reportPath, "utf8");
  if (!contents.trim()) {
    fail("report-file", "empty");
  } else {
    const commit = lineValue(contents, "commit");
    const verify = lineValue(contents, "verify");
    const verifyCount = lineValue(contents, "verify-count");
    const result = lineValue(contents, "result");
    const secretScan = lineValue(contents, "secret-scan");
    const remaining = lineValue(contents, "remaining");
    checkClaimedReview(contents, commit);
    if ([commit, verify, result, secretScan, remaining].some((value) => value === undefined)) {
      fail("report-shape", "required final-report lines missing or duplicated");
    } else if (hasUnstructuredCountClaim(contents)) {
      fail("verify-count", "test-count-claim-must-use-verify-count-field");
    } else {
      report = { commit: commit!, verify: verify!, verifyCount, result: result!, secretScan: secretScan!, remaining: remaining! };
      pass("report-shape");
    }
  }
}

const repoCheck = git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
  fail("repo", "not-a-git-worktree");
}

if (report) {
  const sha = report.commit.split(/\s+/, 1)[0];
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    fail("commit-sha", "must-be-an-exact-40-character-sha");
  } else if (repoCheck.status === 0 && git(repoPath, ["cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
    fail("commit-exists", sha);
  } else {
    pass("commit-exists", sha);
    if (options.branch) {
      const branchCommit = git(repoPath, ["rev-parse", "--verify", `${options.branch}^{commit}`]);
      if (branchCommit.status !== 0) {
        fail("branch", "not-found");
      } else if (branchCommit.stdout.trim().toLowerCase() !== sha.toLowerCase()) {
        const reachable = git(repoPath, ["merge-base", "--is-ancestor", sha, options.branch]).status === 0;
        fail("branch-tip", `report=${sha} branch=${branchCommit.stdout.trim()}${reachable ? " report-is-ancestor" : ""}`);
      } else {
        pass("branch-tip", options.branch);
      }
    }
  }

  if (report.result !== "clean" && report.result !== "NO-GO") {
    fail("result", "must-be-clean-or-NO-GO");
  } else if (report.result === "NO-GO") {
    pass("result", "NO-GO (no-go-declared)");
  } else {
    pass("result", "clean");
  }

  if (report.secretScan !== "clean") fail("secret-scan", "must-be-clean");
  else pass("secret-scan", "clean");

  if (!report.verify) {
    fail("verify", "empty");
  } else {
    pass("verify", "present");
    const claimedCount = report.verifyCount === undefined ? undefined : parseReportedCount(report.verifyCount);
    if (report.verifyCount !== undefined && !claimedCount) {
      fail("verify-count", "must-use-<pass>/<fail>");
    }
    if (!options.deferVerify && report.result === "clean" && repoCheck.status === 0 && /^[0-9a-f]{40}$/i.test(sha)) {
      const verification = runVerification(repoPath, sha, report.verify);
      const verificationOutput = `${verification.stdout ?? ""}${verification.stderr ?? ""}`;
      const evidence = outputTail(verificationOutput);
      if (verification.status !== 0) fail("verify-run", `exit=${verification.status ?? "signal"} tail=${evidence}`);
      else {
        pass("verify-run", `tail=${evidence}`);
        if (claimedCount) {
          const actualCount = parseVerificationCount(verificationOutput);
          if (!actualCount) {
            fail("verify-count", "command-output-missing-unambiguous-pass/fail-count");
          } else if (actualCount.passed !== claimedCount.passed || actualCount.failed !== claimedCount.failed) {
            fail(
              "verify-count",
              `mismatch report=${claimedCount.passed}/${claimedCount.failed} actual=${actualCount.passed}/${actualCount.failed}`,
            );
          } else {
            pass("verify-count", `${actualCount.passed}/${actualCount.failed}`);
          }
        }
      }
    }
  }
}

if (options.branch && repoCheck.status === 0) {
  const checkedOut = git(repoPath, ["branch", "--show-current"]).stdout.trim();
  if (checkedOut === options.branch) {
    const status = git(repoPath, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.status !== 0) fail("working-tree", "status-failed");
    else if (status.stdout.trim()) fail("working-tree", "tracked-uncommitted-changes");
    else pass("working-tree", "clean");
  } else {
    pass("working-tree", `not-checked-out (${checkedOut || "detached"})`);
  }
}

if (failures.length > 0) {
  console.log("GUARD verdict=violation");
  process.exit(2);
}
if (report?.result === "NO-GO") {
  console.log("GUARD verdict=no-go");
  process.exit(3);
}
console.log("GUARD verdict=pass");
