// The review-artifact contract has exactly ONE definition:
// land_review_artifact_contract() in gate/land-lib.sh. Two readers consume it --
// the landing gate (gate/land.sh -> land_review_check) and the lane-exit guard
// (gate/completion-guard.ts --role reviewer -> gate/review-artifact-check.sh).
//
// V3-0.39 and V3-0.50 record what goes wrong when one contract grows two
// implementations that are never executed against each other. This file is the
// lock against that: it runs the SAME artifacts through both readers and asserts
// they agree on every shape rule, and it asserts the only points where they
// deliberately diverge are the three policy differences named below.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const checker = join(import.meta.dir, "review-artifact-check.sh");

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "review-parity-"));
  roots.push(root);
  const repo = join(root, "repo");
  spawnSync("git", ["init", "--initial-branch=main", repo]);
  git(repo, "config", "user.email", "author@example.test");
  git(repo, "config", "user.name", "Author");
  writeFileSync(join(repo, "tracked"), "one\n");
  git(repo, "add", "tracked");
  git(repo, "commit", "-m", "fixture");
  git(repo, "checkout", "-b", "ag-subject");
  return { root, repo, sha: git(repo, "rev-parse", "HEAD"), artifact: join(root, "ag-subject.review.md") };
}

function record(fields: Partial<Record<"verdict" | "reviewer" | "reviewed-sha" | "independence", string>>): string {
  return (["verdict", "reviewer", "reviewed-sha", "independence"] as const)
    .filter((key) => fields[key] !== undefined)
    .map((key) => `${key}: ${fields[key]}\n`)
    .join("");
}

// Runs the single shared definition in one of its two modes and returns the
// diagnostic code it published.
function check(artifact: string, mode: "exit" | "landing", repo: string, branch: string, reportSha: string) {
  const run = spawnSync(
    "bash",
    [checker, "--artifact", artifact, "--mode", mode, "--repo", repo, "--branch", branch, "--report-sha", reportSha],
    { encoding: "utf8" },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  return { status: run.status, code: output.match(/code=(\S+)/)?.[1] ?? null };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const valid = (sha: string) =>
  record({ verdict: "ACCEPT", reviewer: "independent <rev@example.test>", "reviewed-sha": sha, independence: "separate session" });

// Shape rules: both readers must reach the identical diagnostic.
const sharedCases: Array<{ name: string; body: (sha: string) => string; code: string }> = [
  { name: "missing verdict", body: (sha) => valid(sha).replace(/^verdict:.*\n/m, ""), code: "malformed-verdict" },
  { name: "duplicated verdict", body: (sha) => `verdict: ACCEPT\n${valid(sha)}`, code: "malformed-verdict" },
  { name: "missing reviewer", body: (sha) => valid(sha).replace(/^reviewer:.*\n/m, ""), code: "malformed-reviewer" },
  { name: "empty reviewer", body: (sha) => valid(sha).replace(/^reviewer:.*$/m, "reviewer:"), code: "malformed-reviewer" },
  { name: "missing reviewed-sha", body: (sha) => valid(sha).replace(/^reviewed-sha:.*\n/m, ""), code: "missing-reviewed-sha" },
  { name: "short reviewed-sha", body: () => valid("abc123"), code: "missing-reviewed-sha" },
  { name: "missing independence", body: (sha) => valid(sha).replace(/^independence:.*\n/m, ""), code: "missing-independence" },
  { name: "empty independence", body: (sha) => valid(sha).replace(/^independence:.*$/m, "independence:"), code: "missing-independence" },
  { name: "non-ascii reviewer", body: (sha) => valid(sha).replace("independent", "indepéndent"), code: "unsafe-identity-field" },
  { name: "nul byte", body: (sha) => `${valid(sha)}${String.fromCharCode(0)}\n`, code: "nul-byte" },
];

describe("review artifact contract — both readers, one definition", () => {
  for (const shared of sharedCases) {
    test(`landing and exit agree: ${shared.name}`, () => {
      const f = fixture();
      writeFileSync(f.artifact, shared.body(f.sha));
      const landing = check(f.artifact, "landing", f.repo, "ag-subject", f.sha);
      const exit = check(f.artifact, "exit", f.repo, "", "");
      expect(landing.status).toBe(2);
      expect(exit.status).toBe(2);
      expect(landing.code).toBe(shared.code);
      expect(exit.code).toBe(shared.code);
    });
  }

  test("a fully valid ACCEPT record satisfies both readers", () => {
    const f = fixture();
    writeFileSync(f.artifact, valid(f.sha));
    expect(check(f.artifact, "landing", f.repo, "ag-subject", f.sha).status).toBe(0);
    expect(check(f.artifact, "exit", f.repo, "", "").status).toBe(0);
  });

  test("a missing artifact is named the same way by both readers", () => {
    const f = fixture();
    const absent = join(f.root, "absent.review.md");
    expect(check(absent, "landing", f.repo, "ag-subject", f.sha).code).toBe("missing-artifact");
    expect(check(absent, "exit", f.repo, "", "").code).toBe("missing-artifact");
  });
});

// The three deliberate divergences. They are asserted so that a future change
// that quietly adds a fourth has to come here and say so.
describe("review artifact contract — the deliberate divergences", () => {
  test("REJECT: landing refuses it, lane exit accepts a completed review", () => {
    const f = fixture();
    writeFileSync(f.artifact, valid(f.sha).replace("ACCEPT", "REJECT"));
    expect(check(f.artifact, "landing", f.repo, "ag-subject", f.sha).code).toBe("rejected");
    expect(check(f.artifact, "exit", f.repo, "", "").status).toBe(0);
  });

  test("reviewed-sha equality is a landing concern only", () => {
    const f = fixture();
    writeFileSync(f.artifact, valid("a".repeat(40)));
    expect(check(f.artifact, "landing", f.repo, "ag-subject", f.sha).code).toBe("reviewed-sha-mismatch");
    expect(check(f.artifact, "exit", f.repo, "", "").status).toBe(0);
  });

  test("self-authorship is a landing concern only", () => {
    const f = fixture();
    writeFileSync(f.artifact, valid(f.sha).replace("independent <rev@example.test>", "Author <author@example.test>"));
    expect(check(f.artifact, "landing", f.repo, "ag-subject", f.sha).code).toBe("self-authored");
    expect(check(f.artifact, "exit", f.repo, "", "").status).toBe(0);
  });

  test("an unknown verdict token is refused at exit, so 'accepts a REJECT' is not 'accepts anything'", () => {
    const f = fixture();
    writeFileSync(f.artifact, valid(f.sha).replace("ACCEPT", "LGTM"));
    expect(check(f.artifact, "exit", f.repo, "", "").code).toBe("malformed-verdict");
  });
});

describe("review artifact contract — no second implementation", () => {
  test("the reviewer path owns no copy of the field rules", () => {
    // The guard may NAME fields in its human-readable diagnostics, but the
    // reviewer path must not PARSE them: parsing is what drifts. It reaches the
    // rules by spawning gate/review-artifact-check.sh, which sources the one
    // definition.
    //
    // Scope note: completion-guard.ts also has checkClaimedReview(), a narrower,
    // separate check belonging to the CODER contract (a coder claiming a review
    // happened via a `review:` field). That one is deliberately untouched here --
    // folding it into the shared contract would tighten the coder contract, which
    // V3-0.44 must not do. It is recorded as an open finding instead.
    const guard = readFileSync(join(import.meta.dir, "completion-guard.ts"), "utf8");
    const start = guard.indexOf("function runReviewerContract");
    expect(start).toBeGreaterThan(-1);
    const reviewerPath = guard.slice(start, guard.indexOf("\n}", start));
    expect(reviewerPath).toContain("review-artifact-check.sh");
    for (const field of ["verdict", "reviewer", "reviewed-sha", "independence"]) {
      expect(reviewerPath).not.toContain(`lineValue(contents, "${field}")`);
      expect(reviewerPath).not.toContain(`^${field}:`);
    }
  });

  test("land-lib.sh is the only file defining the contract", () => {
    const lib = readFileSync(join(import.meta.dir, "land-lib.sh"), "utf8");
    expect(lib).toContain("land_review_artifact_contract()");
    const adapter = readFileSync(checker, "utf8");
    expect(adapter).toContain("land_review_artifact_contract");
    // The adapter delegates; it must not re-derive any field itself.
    expect(adapter).not.toMatch(/sed -n 's\/\^(verdict|reviewer|reviewed-sha|independence):/);
  });
});
