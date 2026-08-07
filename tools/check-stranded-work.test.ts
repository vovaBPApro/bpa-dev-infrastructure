import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXIT_CODES,
  checkStrandedWork,
  parseRemoteRefs,
  presentCommits,
  readExemptions,
  sweep,
} from "./check-stranded-work";

const REAL_REPO = join(import.meta.dir, "..");
const CHECKER = join(REAL_REPO, "tools/check-stranded-work.ts");

// A repository with two commits: `landed` is published to the fixture's origin
// listing, `stranded` is not. Everything below is one question asked against
// this pair, so a wrong answer is attributable to the change under test and not
// to the fixture.
type Fixture = { repo: string; lanes: string; landed: string; stranded: string; remoteRefs: string; exemptions: string };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "stranded-fixture-"));
  const repo = join(root, "repo");
  const lanes = join(root, "lanes");
  mkdirSync(repo);
  mkdirSync(lanes);
  const git = (...args: string[]) => {
    const run = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  };
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "landed");
  const landed = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "stranded");
  const stranded = git("rev-parse", "HEAD");
  // Origin publishes `landed` and nothing else. `stranded` is a descendant, so
  // it is on this host and reachable from no ref origin has.
  const remoteRefs = join(root, "remote-refs.txt");
  writeFileSync(remoteRefs, `${landed}\trefs/heads/main\n`);
  const exemptions = join(root, "exemptions.tsv");
  writeFileSync(exemptions, "# none\n");
  return { repo, lanes, landed, stranded, remoteRefs, exemptions };
}

function review(fx: Fixture, branch: string, body: string): string {
  const path = join(fx.lanes, `${branch}.review.md`);
  writeFileSync(path, body);
  return path;
}

function acceptArtifact(sha: string): string {
  return [
    "verdict: ACCEPT",
    "reviewer: independent reviewer lane (Tier A)",
    `reviewed-sha: ${sha}`,
    "independence: I did not author this change.",
    "",
    "# Review",
    "",
    "Looks right.",
  ].join("\n");
}

function run(fx: Fixture, overrides: Partial<Parameters<typeof checkStrandedWork>[0]> = {}) {
  return checkStrandedWork({ repo: fx.repo, lanesDir: fx.lanes, remote: "origin", remoteRefsFile: fx.remoteRefs, exemptions: fx.exemptions, ...overrides });
}

function withFixture<T>(body: (fx: Fixture) => T): T {
  const fx = fixture();
  try {
    return body(fx);
  } finally {
    rmSync(join(fx.repo, ".."), { recursive: true, force: true });
  }
}

// --- the green direction --------------------------------------------------

test("an ACCEPT whose sha origin publishes exactly is not stranded", () => {
  withFixture((fx) => {
    review(fx, "ag-green", acceptArtifact(fx.landed));
    const result = run(fx);
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
    expect(result.evidence.join("\n")).toContain("accept-attestations=1");
  });
});

test("an ACCEPT whose sha is an ANCESTOR of a published ref is not stranded — that is what landing means", () => {
  withFixture((fx) => {
    // Publish the descendant; the ACCEPT names its parent.
    writeFileSync(fx.remoteRefs, `${fx.stranded}\trefs/heads/main\n`);
    review(fx, "ag-landed", acceptArtifact(fx.landed));
    expect(run(fx).verdict).toBe("PASS");
  });
});

test("a REJECT is not an ACCEPT and is swept past without a finding", () => {
  withFixture((fx) => {
    review(fx, "ag-rejected", `verdict: REJECT\nreviewer: r\nreviewed-sha: ${fx.stranded}\nindependence: x\n`);
    const result = run(fx);
    expect(result.verdict).toBe("PASS");
    expect(result.evidence.join("\n")).toContain("accept-attestations=0");
  });
});

test("an ACCEPT reachable only through a non-branch namespace ref still counts — attempt refs are origin", () => {
  withFixture((fx) => {
    // gate/land.sh publishes reviewed attempts under refs/bpa-review-attempts.
    writeFileSync(fx.remoteRefs, `${fx.landed}\trefs/heads/main\n${fx.stranded}\trefs/bpa-review-attempts/V3-1/1-${fx.stranded}\n`);
    review(fx, "ag-attempt", acceptArtifact(fx.stranded));
    expect(run(fx).verdict).toBe("PASS");
  });
});

// --- the red direction ----------------------------------------------------

test("an ACCEPT whose work exists only on this host is a FAIL that names it", () => {
  withFixture((fx) => {
    review(fx, "ag-stranded", acceptArtifact(fx.stranded));
    const result = run(fx);
    expect(result.verdict).toBe("FAIL");
    const finding = result.findings.find((line) => line.startsWith("FAIL stranded"));
    expect(finding).toContain("ag-stranded.review.md");
    expect(finding).toContain(fx.stranded);
    expect(finding).toContain("reachable from no ref origin publishes");
  });
});

test("a lane report claiming a completed review is a second, independent arm", () => {
  withFixture((fx) => {
    // No review artifact at all: only the report's `review:` claim and its
    // contract-header `commit:`. The artifact arm sees nothing here.
    writeFileSync(
      join(fx.lanes, "ag-reported.report.md"),
      [`commit: ${fx.stranded} [CODER] work`, "verify: bun test", "result: clean", "secret-scan: clean", "remaining: none", "review: ACCEPT r1", "", "Body."].join("\n"),
    );
    const result = run(fx);
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.join("\n")).toContain("FAIL stranded lane-report ag-reported.report.md");
  });
});

test("a lane report with no review claim is not an ACCEPT and is left alone", () => {
  withFixture((fx) => {
    writeFileSync(
      join(fx.lanes, "ag-unreviewed.report.md"),
      [`commit: ${fx.stranded} [CODER] work`, "verify: bun test", "result: clean", "secret-scan: clean", "remaining: review outstanding", "", "Body."].join("\n"),
    );
    const result = run(fx);
    expect(result.verdict).toBe("PASS");
    expect(result.evidence.join("\n")).toContain("accept-attestations=0");
  });
});

test("a `review:` line inside a fenced block is an example, not a claim", () => {
  withFixture((fx) => {
    writeFileSync(
      join(fx.lanes, "ag-documents.report.md"),
      [`commit: ${fx.stranded} [CODER] work`, "verify: bun test", "result: clean", "secret-scan: clean", "remaining: none", "", "The syntax is:", "", "```text", "review: ACCEPT r1", "```", ""].join("\n"),
    );
    expect(run(fx).verdict).toBe("PASS");
  });
});

// --- exemptions, both directions ------------------------------------------

test("a matching exemption clears a stranded ACCEPT and records the reason", () => {
  withFixture((fx) => {
    review(fx, "ag-superseded", acceptArtifact(fx.stranded));
    writeFileSync(fx.exemptions, `ag-superseded.review.md\t${fx.stranded}\tsuperseded by round 2\n`);
    const result = run(fx);
    expect(result.verdict).toBe("PASS");
    expect(result.evidence.join("\n")).toContain("exempt ag-superseded.review.md");
    expect(result.evidence.join("\n")).toContain("reason=superseded by round 2");
  });
});

test("an exemption naming a different sha in the same file does not widen to cover it", () => {
  withFixture((fx) => {
    review(fx, "ag-superseded", acceptArtifact(fx.stranded));
    writeFileSync(fx.exemptions, `ag-superseded.review.md\t${fx.landed}\tblessed other work\n`);
    const result = run(fx);
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.join("\n")).toContain("FAIL stranded review-artifact ag-superseded.review.md");
    expect(result.findings.join("\n")).toContain("FAIL orphan exemption: ag-superseded.review.md carries no ACCEPT attesting");
  });
});

test("an exemption that is no longer needed is a FAIL, not a silent pass", () => {
  withFixture((fx) => {
    review(fx, "ag-green", acceptArtifact(fx.landed));
    writeFileSync(fx.exemptions, `ag-green.review.md\t${fx.landed}\tstale\n`);
    const result = run(fx);
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.join("\n")).toContain("FAIL stale exemption: ag-green.review.md");
  });
});

test("an exemption for an artifact that is gone is an orphan and fails", () => {
  withFixture((fx) => {
    writeFileSync(fx.exemptions, `ag-vanished.review.md\t${fx.stranded}\tgone\n`);
    const result = run(fx);
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.join("\n")).toContain("FAIL orphan exemption: ag-vanished.review.md holds no ACCEPT this sweep can see");
  });
});

test("a malformed exemptions row is UNKNOWN, never an empty exemption set", () => {
  withFixture((fx) => {
    review(fx, "ag-stranded", acceptArtifact(fx.stranded));
    writeFileSync(fx.exemptions, "ag-stranded.review.md\tjust two columns\n");
    expect(run(fx).verdict).toBe("UNKNOWN");
    writeFileSync(fx.exemptions, "ag-stranded.review.md\tnot-a-sha\treason\n");
    expect(run(fx).findings.join("\n")).toContain("non-40-hex sha");
  });
});

test("an absent exemptions file means nothing is exempt, which is the strict reading", () => {
  withFixture((fx) => {
    review(fx, "ag-stranded", acceptArtifact(fx.stranded));
    expect(run(fx, { exemptions: join(fx.repo, "no-such-file.tsv") }).verdict).toBe("FAIL");
    expect(readExemptions(join(fx.repo, "no-such-file.tsv"))).toEqual([]);
  });
});

// --- UNKNOWN, never PASS ---------------------------------------------------

test("origin that cannot be asked is UNKNOWN, never PASS", () => {
  withFixture((fx) => {
    review(fx, "ag-green", acceptArtifact(fx.landed));
    const result = run(fx, { remoteRefsFile: join(fx.repo, "no-such-listing.txt") });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("remote ref listing unreadable");
  });
});

test("an empty origin ref listing is UNKNOWN, not a FAIL against every ACCEPT on the box", () => {
  withFixture((fx) => {
    review(fx, "ag-green", acceptArtifact(fx.landed));
    writeFileSync(fx.remoteRefs, "\n");
    const result = run(fx);
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("names no ref");
  });
});

test("an ACCEPT with no single verdict field is UNKNOWN, not skipped", () => {
  withFixture((fx) => {
    review(fx, "ag-double", `verdict: ACCEPT\nverdict: ACCEPT\nreviewed-sha: ${fx.landed}\n`);
    const result = run(fx);
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("no single `verdict:` field");
  });
});

test("an ACCEPT with no usable reviewed-sha is UNKNOWN, not skipped", () => {
  withFixture((fx) => {
    review(fx, "ag-vague", "verdict: ACCEPT\nreviewed-sha: deadbeef\n");
    const result = run(fx);
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("the accepted work is unidentifiable");
  });
});

test("a report claiming review with no single header commit is UNKNOWN", () => {
  withFixture((fx) => {
    writeFileSync(join(fx.lanes, "ag-headless.report.md"), "Some prose first.\n\ncommit: abc\nreview: ACCEPT\n");
    const result = run(fx);
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("the reviewed work is unidentifiable");
  });
});

test("an ACCEPT whose sha this host no longer holds is UNKNOWN, never counted as fine", () => {
  withFixture((fx) => {
    review(fx, "ag-pruned", acceptArtifact("0".repeat(40)));
    const result = run(fx);
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("absent from this host's object database");
  });
});

test("an unreadable lanes directory is UNKNOWN", () => {
  withFixture((fx) => {
    const result = run(fx, { lanesDir: join(fx.repo, "no-such-lanes") });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("lanes directory unreadable");
    expect(sweep(join(fx.repo, "a.txt"))).toEqual({ unknown: `lanes directory is not a directory: ${join(fx.repo, "a.txt")}` });
  });
});

// --- the sweep mutates nothing --------------------------------------------

test("the sweep leaves every artifact byte-identical and adds no file", () => {
  withFixture((fx) => {
    review(fx, "ag-stranded", acceptArtifact(fx.stranded));
    review(fx, "ag-green", acceptArtifact(fx.landed));
    writeFileSync(join(fx.lanes, "ag-stranded.report.md"), `commit: ${fx.stranded} t\nreview: ACCEPT\n`);
    const before = readdirSync(fx.lanes).sort().map((name) => {
      const path = join(fx.lanes, name);
      return `${name}\t${readFileSync(path, "utf8")}\t${statSync(path).mtimeMs}`;
    });
    run(fx);
    const after = readdirSync(fx.lanes).sort().map((name) => {
      const path = join(fx.lanes, name);
      return `${name}\t${readFileSync(path, "utf8")}\t${statSync(path).mtimeMs}`;
    });
    expect(after).toEqual(before);
  });
});

// --- units ----------------------------------------------------------------

test("parseRemoteRefs reads ls-remote output and ignores everything else", () => {
  const parsed = parseRemoteRefs(["a".repeat(40) + "\trefs/heads/main", "not a ref line", "b".repeat(40) + "\trefs/tags/v1^{}"].join("\n"));
  expect(parsed.count).toBe(2);
  expect(parsed.targets.has("a".repeat(40))).toBe(true);
  expect(parsed.targets.has("b".repeat(40))).toBe(true);
});

test("presentCommits answers for many shas in one call and excludes what is absent", () => {
  withFixture((fx) => {
    const present = presentCommits(fx.repo, [fx.landed, fx.stranded, "0".repeat(40)]);
    expect(present.has(fx.landed)).toBe(true);
    expect(present.has(fx.stranded)).toBe(true);
    expect(present.has("0".repeat(40))).toBe(false);
  });
});

// --- the executable, end to end -------------------------------------------

test("the CLI exits 0 on a clean sweep, 1 on stranded work, 3 when it cannot ask origin", () => {
  withFixture((fx) => {
    const argv = (extra: string[]) => [process.execPath, CHECKER, "--repo", fx.repo, "--lanes-dir", fx.lanes, "--exemptions", fx.exemptions, ...extra];
    review(fx, "ag-green", acceptArtifact(fx.landed));
    const green = Bun.spawnSync(argv(["--remote-refs", fx.remoteRefs]), { stdout: "pipe", stderr: "pipe" });
    expect(green.exitCode).toBe(EXIT_CODES.PASS);
    expect(green.stdout.toString()).toContain("STRANDED-WORK PASS");

    review(fx, "ag-stranded", acceptArtifact(fx.stranded));
    const red = Bun.spawnSync(argv(["--remote-refs", fx.remoteRefs]), { stdout: "pipe", stderr: "pipe" });
    expect(red.exitCode).toBe(EXIT_CODES.FAIL);
    expect(red.stderr.toString()).toContain("FAIL stranded review-artifact ag-stranded.review.md");

    // No `--remote-refs`, and the fixture repository has no `origin` remote.
    const unknown = Bun.spawnSync(argv([]), { stdout: "pipe", stderr: "pipe" });
    expect(unknown.exitCode).toBe(EXIT_CODES.UNKNOWN);
    expect(unknown.stderr.toString()).toContain("so origin was not asked");
  });
});

test("a missing argument value is UNKNOWN, never a silent default", () => {
  const run = Bun.spawnSync([process.execPath, CHECKER, "--lanes-dir"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(EXIT_CODES.UNKNOWN);
  expect(run.stderr.toString()).toContain("argument-missing");
});

test("the checker carries no verify-count field", () => {
  expect(readFileSync(join(import.meta.dir, "check-stranded-work.ts"), "utf8")).not.toContain("verify-count");
});

// --- registration ----------------------------------------------------------

test("the checker is registered under the id gate F looks for, in both manifests", () => {
  for (const manifest of ["instance/required-mechanisms.tsv", "instance/expected-mechanisms.tsv"]) {
    const contents = readFileSync(join(REAL_REPO, manifest), "utf8");
    expect(contents, manifest).toContain("checker:stranded-work\tchecker\ttools/check-stranded-work.ts");
  }
});

test("the tracked exemptions file exists and states both failure directions", () => {
  const contents = readFileSync(join(REAL_REPO, "instance/stranded-work-exemptions.tsv"), "utf8");
  expect(contents).toContain("STALE");
  expect(contents).toContain("ORPHAN");
  expect(readExemptions(join(REAL_REPO, "instance/stranded-work-exemptions.tsv"))).toEqual([]);
});
