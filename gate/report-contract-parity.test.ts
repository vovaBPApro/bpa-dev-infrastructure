import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dispatcherReportVerdict } from "../orchestrator/dispatcher";

const roots: string[] = [];
const guard = join(import.meta.dir, "completion-guard.ts");

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "report-parity-")); roots.push(root);
  const repo = join(root, "repo");
  spawnSync("git", ["init", "--initial-branch=main", repo]);
  git(repo, "config", "user.email", "parity@example.test"); git(repo, "config", "user.name", "Parity");
  writeFileSync(join(repo, "tracked"), "one\n"); git(repo, "add", "tracked"); git(repo, "commit", "-m", "fixture");
  return { root, repo, sha: git(repo, "rev-parse", "HEAD"), report: join(root, "report.md") };
}

function body(sha: string, extra = "", result = "clean") {
  return `commit: ${sha} fixture\nverify: true\nresult: ${result}\nsecret-scan: clean\n${extra}remaining: none\n`;
}

function guardVerdict(report: string, repo: string) {
  const run = spawnSync(process.execPath, [guard, "--report", report, "--repo", repo, "--branch", "main"]);
  return run.status === 0 ? "clean" : run.status === 3 ? "NO-GO" : "invalid";
}

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

// "real" cases are shapes observed in lane-exit history (V3-0.5/V3-0.13).
// "constructed" cases exercise absence and future drift boundaries.
const cases = [
  { name: "real valid report", kind: "real", expected: "clean", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, body(f.sha)) },
  { name: "real honest NO-GO", kind: "real", expected: "NO-GO", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, body(f.sha, "", "NO-GO")) },
  { name: "constructed missing report", kind: "constructed", expected: "invalid", make: (_f: ReturnType<typeof fixture>) => {} },
  { name: "constructed empty report", kind: "constructed", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, "") },
  { name: "real missing required fields", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, `commit: ${f.sha}\nresult: clean\n`) },
  { name: "real forged commit substring", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, body("0".repeat(40), `note: commit: ${f.sha}\n`)) },
  { name: "real Review case evasion", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, body(f.sha, "Review: ACCEPT\n")) },
  { name: "real leading-space review evasion", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, body(f.sha, " review: ACCEPT\n")) },
  { name: "real pre-colon-space review evasion", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, body(f.sha, "review : ACCEPT\n")) },
  { name: "real unterminated backtick fence", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, `${body(f.sha)}\`\`\`text\nreview: ACCEPT`) },
  { name: "real shorter closing fence", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, `${body(f.sha)}\`\`\`\`\nexample\n\`\`\`\nreview: ACCEPT`) },
  { name: "real unterminated tilde fence", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => writeFileSync(f.report, `${body(f.sha)}~~~markdown\nreview: ACCEPT`) },
  { name: "constructed intermediate SHA", kind: "constructed", expected: "invalid", make: (f: ReturnType<typeof fixture>) => { const old=f.sha; writeFileSync(join(f.repo,"later"),"two\n"); git(f.repo,"add","later"); git(f.repo,"commit","-m","later"); writeFileSync(f.report,body(old)); } },
  { name: "real report committed into branch", kind: "real", expected: "invalid", make: (f: ReturnType<typeof fixture>) => {
    f.report = join(f.repo, "report.md");
    writeFileSync(f.report, body(f.sha)); git(f.repo, "add", "report.md"); git(f.repo, "commit", "-m", "report");
    // A report cannot carry the commit that contains it. Rewriting it to name
    // the new tip only makes the tracked worktree dirty, which is also invalid.
    writeFileSync(f.report, body(git(f.repo, "rev-parse", "HEAD")));
  } },
] as const;

describe("one terminal report contract", () => {
  test.each(cases)("$kind: $name", ({ expected, make }) => {
    const f = fixture(); make(f);
    expect(guardVerdict(f.report, f.repo)).toBe(expected);
    expect(dispatcherReportVerdict(f.report, f.repo, "main")).toBe(expected);
  });

  test("constructed unreadable report rejects on both paths", () => {
    const f = fixture(); mkdirSync(f.report);
    expect(guardVerdict(f.report, f.repo)).toBe("invalid");
    expect(dispatcherReportVerdict(f.report, f.repo, "main")).toBe("invalid");
  });
});
