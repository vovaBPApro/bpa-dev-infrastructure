#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type Options = {
  report?: string;
  repo?: string;
  branch?: string;
  runVerify: boolean;
};

type Report = {
  commit: string;
  verify: string;
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

function usage(): never {
  console.error("usage: bun gate/completion-guard.ts --report <file> --repo <path> [--branch <name>] [--run-verify]");
  process.exit(2);
}

function parseArgs(args: string[]): Options {
  const options: Options = { runVerify: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run-verify") {
      options.runVerify = true;
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

function lineValue(contents: string, label: string): string | undefined {
  const matches = contents.match(new RegExp(`^${label}:\\s*(.*)$`, "gm"));
  if (matches?.length !== 1) return undefined;
  return matches[0].slice(label.length + 1).trim();
}

function git(repo: string, args: string[]) {
  return spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function outputTail(output: string): string {
  const lines = output.trim().split("\n").filter(Boolean);
  return lines.slice(-10).join(" | ").slice(-200) || "(no output)";
}

const options = parseArgs(process.argv.slice(2));
const reportPath = resolve(options.report!);
const repoPath = resolve(options.repo!);
let report: Report | undefined;

if (!existsSync(reportPath)) {
  fail("report-file", "missing");
} else {
  const contents = readFileSync(reportPath, "utf8");
  if (!contents.trim()) {
    fail("report-file", "empty");
  } else {
    const commit = lineValue(contents, "commit");
    const verify = lineValue(contents, "verify");
    const result = lineValue(contents, "result");
    const secretScan = lineValue(contents, "secret-scan");
    const remaining = lineValue(contents, "remaining");
    if ([commit, verify, result, secretScan, remaining].some((value) => value === undefined)) {
      fail("report-shape", "required final-report lines missing or duplicated");
    } else {
      report = { commit: commit!, verify: verify!, result: result!, secretScan: secretScan!, remaining: remaining! };
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
      } else if (git(repoPath, ["merge-base", "--is-ancestor", sha, options.branch]).status !== 0) {
        fail("branch-reachability", `${sha} not-reachable-from ${options.branch}`);
      } else {
        pass("branch-reachability", options.branch);
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
    if (options.runVerify && repoCheck.status === 0) {
      const verification = spawnSync(report.verify, { cwd: repoPath, shell: true, encoding: "utf8" });
      const evidence = outputTail(`${verification.stdout ?? ""}${verification.stderr ?? ""}`);
      if (verification.status !== 0) fail("verify-run", `exit=${verification.status ?? "signal"} tail=${evidence}`);
      else pass("verify-run", `tail=${evidence}`);
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
