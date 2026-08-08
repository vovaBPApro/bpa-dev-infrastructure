import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DECLARED_CHECKS,
  EXEMPTIONS_FILE,
  EXIT_CODES,
  WORLD_NAMES,
  buildWorlds,
  checkParity,
  exitStatusOnlyOutcomes,
  fleetCapOutcomes,
  ledgerOutcomes,
  mirrorWorkingTree,
  readParityExemptions,
  reachabilityOutcomes,
  runCheck,
  sharedStashOutcomes,
  type OutcomeSet,
  type ParityCheck,
} from "./check-checkout-parity";

const REAL_REPO = join(import.meta.dir, "..");
const CHECKER = join(REAL_REPO, "tools/check-checkout-parity.ts");

// A synthetic repository, because the point of every case below is to make ONE
// property differ between checkout kinds and see what the comparison says. The
// real tree cannot be bent that way without mutating it, and this checker's own
// promise is that it mutates nothing it reads.
function fixtureRepo(options: { tracked?: Record<string, string>; untracked?: Record<string, string>; ignored?: Record<string, string> } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "parity-fixture-"));
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  };
  run("init", "--quiet", "-b", "main");
  run("config", "user.email", "fixture@example.invalid");
  run("config", "user.name", "Fixture");
  write(repo, ".gitignore", "ignored-here/\n");
  for (const [path, contents] of Object.entries(options.tracked ?? {})) write(repo, path, contents);
  run("add", "-A");
  run("commit", "--quiet", "-m", "fixture");
  for (const [path, contents] of Object.entries(options.untracked ?? {})) write(repo, path, contents);
  for (const [path, contents] of Object.entries(options.ignored ?? {})) write(repo, join("ignored-here", path), contents);
  return repo;
}

function write(repo: string, path: string, contents: string): void {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * A check written as a shell script INSIDE the world, so each world runs its own
 * copy. The default extractor is the blind one on purpose: these fixtures test
 * world construction and the exit-status arm, and a synthetic output vocabulary
 * would only obscure which arm a case is exercising. The cases that test the
 * outcome-set arm pass `ledgerOutcomes` explicitly.
 */
function scriptCheck(id: string, relative: string, outcomes: ParityCheck["outcomes"] = exitStatusOnlyOutcomes): ParityCheck {
  return { id, argv: (world) => ["/bin/bash", join(world, relative), world], outcomes };
}

/** The reason an outcome set gave for being unreadable, or "" when it was read. */
function unmeasuredReason(set: OutcomeSet): string {
  return "unmeasured" in set ? set.unmeasured : "";
}

/** A file whose lines this test wrote, as a temp path the caller must remove. */
function tempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "parity-tsv-"));
  const path = join(dir, "exemptions.tsv");
  writeFileSync(path, contents);
  return path;
}

function withRepo<T>(options: Parameters<typeof fixtureRepo>[0], body: (repo: string) => T): T {
  const repo = fixtureRepo(options);
  try {
    return body(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// --- the green direction --------------------------------------------------

test("a check reading only tracked content agrees in all three worlds", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\ntest -f \"$1/tracked.txt\"\n", "tracked.txt": "present\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("tracked-only", "check.sh")] });
    expect(result.verdict).toBe("PASS");
    expect(result.evidence.join("\n")).toContain("check=tracked-only pass in primary, lane-worktree, land-main");
    expect(result.findings).toEqual([]);
  });
});

test("a check that fails everywhere is parity, not a defect — the verdict is what is compared", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 7\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("always-red", "check.sh")] });
    expect(result.verdict).toBe("PASS");
    expect(result.evidence.join("\n")).toContain("check=always-red fail in primary, lane-worktree, land-main");
  });
});

// --- the red direction: the consilium's own failure ------------------------

test("a check reading an UNTRACKED file diverges, and the finding names world and check", () => {
  // This is instance/decisions/inbox.jsonl in miniature: present in the primary
  // repository, structurally absent from a lane worktree and from land-main, so
  // the check that reads it passes in one world and fails in two.
  withRepo(
    { tracked: { "check.sh": "#!/bin/bash\ntest -f \"$1/inbox.jsonl\"\n" }, untracked: { "inbox.jsonl": "{}\n" } },
    (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("reads-untracked", "check.sh")] });
      expect(result.verdict).toBe("FAIL");
      const finding = result.findings.find((line) => line.includes("DIVERGED"));
      expect(finding).toBeDefined();
      expect(finding).toContain("check=reads-untracked");
      expect(finding).toContain("primary=pass");
      expect(finding).toContain("lane-worktree=fail");
      expect(finding).toContain("land-main=fail");
    },
  );
});

test("a check reading an IGNORED file diverges the same way", () => {
  withRepo(
    { tracked: { "check.sh": "#!/bin/bash\ntest -f \"$1/ignored-here/runtime.env\"\n" }, ignored: { "runtime.env": "TOKEN=\n" } },
    (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("reads-ignored", "check.sh")] });
      expect(result.verdict).toBe("FAIL");
      expect(result.findings.join("\n")).toContain("primary=pass");
    },
  );
});

test("a check reading repository-GLOBAL state separates a worktree from a clone", () => {
  // refs/stash is shared with the parent clone and private to an independent
  // one, which is the structural difference no file content can stand in for.
  withRepo(
    {
      tracked: {
        "check.sh": "#!/bin/bash\ntest \"$(git -C \"$1\" rev-parse --git-dir)\" = \"$(git -C \"$1\" rev-parse --git-common-dir)\"\n",
      },
    },
    (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("git-dir-shape", "check.sh")] });
      expect(result.verdict).toBe("FAIL");
      const finding = result.findings.find((line) => line.includes("DIVERGED"));
      expect(finding).toContain("lane-worktree=fail");
      expect(finding).toContain("primary=pass");
      expect(finding).toContain("land-main=pass");
    },
  );
});

// --- the divergence that exits 0 in both worlds ----------------------------
//
// This is the case an independent review executed against the real repository
// and this harness reported PASS on: the consilium's ledger divergence produces
// exit 0 EVERYWHERE. With the untracked inbox present the ledger aging check
// runs and prints `PASS instance [ledger]`; without it the check SKIPs. Same
// exit status, different measurement. The fixture reproduces that shape exactly,
// in the format tools/instructions/check.ts actually prints.

const INBOX_SHAPED_CHECK = [
  "#!/bin/bash",
  'world="$1"',
  'if [ -f "$world/inbox.jsonl" ]; then',
  '  echo "PASS instance [ledger]  rows, none aged untriaged"',
  '  echo ""',
  '  echo "summary: 0 FAIL, 0 UNKNOWN, 0 WARN, 0 SKIP, 1 PASS (3 docs)"',
  "else",
  '  echo "SKIP instance/decisions/inbox.jsonl [ledger]  capture.mode=manual - inbox not expected yet"',
  '  echo ""',
  '  echo "summary: 0 FAIL, 0 UNKNOWN, 0 WARN, 1 SKIP, 0 PASS (3 docs)"',
  "fi",
  "exit 0",
  "",
].join("\n");

const INBOX_FIXTURE = { tracked: { "check.sh": INBOX_SHAPED_CHECK }, untracked: { "inbox.jsonl": "{}\n" } };

const SPACED_LEDGER_LINE = "FAIL inbox.jsonl:msg 2721 [ledger]  untriaged inbound >24h with no HR-2721.md and no triage verdict";

/** The exact single-token subject parser rejected in r2, retained only as red evidence. */
function rejectedSingleTokenLedgerOutcomes(run: { stdout: string; stderr: string; status: number }): OutcomeSet {
  const text = `${run.stdout}\n${run.stderr}`;
  const finding = text.split("\n").map((line) => line.match(/^(FAIL|UNKNOWN|WARN|SKIP|PASS) +(\S+) +\[([^\]]+)\]/)).find(Boolean);
  const summary = text.match(/^summary: (\d+) FAIL, (\d+) UNKNOWN, (\d+) WARN, (\d+) SKIP, (\d+) PASS \((\d+) docs\)$/m);
  if (!summary || Number(summary[1]) !== (finding?.[1] === "FAIL" ? 1 : 0)) {
    return { unmeasured: "the ledger outcome set was not parsed faithfully" };
  }
  return {
    records: [
      { key: `${finding![2]} [${finding![3]}]`, value: finding![1]! },
      { key: "docs", value: summary[6]! },
      { key: "exit-status", value: String(run.status) },
    ],
  };
}

const SPACED_LEDGER_CHECK = [
  "#!/bin/bash",
  'world="$1"',
  'if [ -f "$world/inbox.jsonl" ]; then',
  `  echo "${SPACED_LEDGER_LINE}"`,
  "else",
  '  echo "FAIL instance [ledger]  comparison fixture"',
  "fi",
  'echo ""',
  'echo "summary: 1 FAIL, 0 UNKNOWN, 0 WARN, 0 SKIP, 0 PASS (32 docs)"',
  "exit 1",
  "",
].join("\n");

const SPACED_LEDGER_FIXTURE = { tracked: { "check.sh": SPACED_LEDGER_CHECK }, untracked: { "inbox.jsonl": "{}\n" } };

test("RED BEFORE: the rejected single-token ledger parser makes the exact real spaced subject UNKNOWN", () => {
  withRepo(SPACED_LEDGER_FIXTURE, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("ledger", "check.sh", rejectedSingleTokenLedgerOutcomes)] });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("world=primary UNKNOWN: the ledger outcome set was not parsed faithfully");
  });
});

test("GREEN AFTER: the exact real spaced ledger subject is preserved and measured as a divergence", () => {
  withRepo(SPACED_LEDGER_FIXTURE, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("ledger", "check.sh", ledgerOutcomes)] });
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.join("\n")).toContain(
      'check=ledger DIVERGED outcome record="inbox.jsonl:msg 2721 [ledger]": primary=FAIL lane-worktree=absent land-main=absent',
    );
    expect(result.findings.join("\n")).not.toContain("UNKNOWN");
  });
});

test("RED BEFORE: comparing exit status alone reports parity on the consilium's own divergence", () => {
  // The blind extractor IS the rejected comparison, kept nameable so the defect
  // can be executed rather than described. This must pass, and its passing is
  // the failure.
  withRepo(INBOX_FIXTURE, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("ledger", "check.sh", exitStatusOnlyOutcomes)] });
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });
});

test("GREEN AFTER: the same run diverges on its outcome set, and the finding names the record and both outcomes", () => {
  withRepo(INBOX_FIXTURE, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("ledger", "check.sh", ledgerOutcomes)] });
    expect(result.verdict).toBe("FAIL");
    // The exit statuses still agree -- stated here so the lock records WHY the
    // previous comparison saw nothing, not merely that this one sees something.
    expect(result.evidence.join("\n")).toContain("check=ledger pass in primary, lane-worktree, land-main");
    expect(result.findings.join("\n")).not.toContain("DIVERGED verdict");
    const findings = result.findings.join("\n");
    expect(findings).toContain('check=ledger DIVERGED outcome record="instance [ledger]": primary=PASS lane-worktree=absent land-main=absent');
    expect(findings).toContain('check=ledger DIVERGED outcome record="instance/decisions/inbox.jsonl [ledger]": primary=absent lane-worktree=SKIP land-main=SKIP');
  });
});

test("a same-outcome pair stays PASS — identical outcome sets are parity, not a finding", () => {
  const always = [
    "#!/bin/bash",
    'echo "PASS instance [ledger]  rows, none aged untriaged"',
    'echo ""',
    'echo "summary: 0 FAIL, 0 UNKNOWN, 0 WARN, 0 SKIP, 1 PASS (3 docs)"',
    "",
  ].join("\n");
  withRepo({ tracked: { "check.sh": always } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("ledger", "check.sh", ledgerOutcomes)] });
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });
});

test("two worlds failing for DIFFERENT reasons diverge, though both exit non-zero", () => {
  // The same blindness read the other way: `fail === fail` compared equal.
  const differing = [
    "#!/bin/bash",
    'world="$1"',
    'if [ -f "$world/inbox.jsonl" ]; then',
    '  echo "MECHANISM-REACHABILITY unreachable mechanism: checker:alpha"',
    "else",
    '  echo "MECHANISM-REACHABILITY unreachable mechanism: checker:beta"',
    "fi",
    "exit 1",
    "",
  ].join("\n");
  withRepo({ tracked: { "check.sh": differing }, untracked: { "inbox.jsonl": "{}\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("reachability", "check.sh", reachabilityOutcomes)] });
    expect(result.verdict).toBe("FAIL");
    expect(result.evidence.join("\n")).toContain("check=reachability fail in primary, lane-worktree, land-main");
    expect(result.findings.join("\n")).toContain("unreachable mechanism: checker:alpha");
  });
});

// --- deliberate asymmetry goes through the tracked allowlist ----------------

test("an exemption greens a named divergence and records its reason in evidence", () => {
  const exemptions = tempFile(
    "# a header line\n" +
      'ledger\tinstance [ledger]\tthe aging check reads the untracked inbox on purpose\n' +
      "ledger\tinstance/decisions/inbox.jsonl [ledger]\tthe SKIP is the documented other half\n",
  );
  try {
    withRepo(INBOX_FIXTURE, (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("ledger", "check.sh", ledgerOutcomes)], exemptions });
      expect(result.verdict).toBe("PASS");
      expect(result.findings).toEqual([]);
      expect(result.evidence.join("\n")).toContain('check=ledger exempt record="instance [ledger]"');
      expect(result.evidence.join("\n")).toContain("reason=the aging check reads the untracked inbox on purpose");
    });
  } finally {
    rmSync(dirname(exemptions), { recursive: true, force: true });
  }
});

test("an exemption whose divergence has gone away FAILs as stale", () => {
  const exemptions = tempFile("ledger\tinstance [ledger]\tno longer true\n");
  try {
    const always = [
      "#!/bin/bash",
      'echo "PASS instance [ledger]  rows"',
      'echo ""',
      'echo "summary: 0 FAIL, 0 UNKNOWN, 0 WARN, 0 SKIP, 1 PASS (3 docs)"',
      "",
    ].join("\n");
    withRepo({ tracked: { "check.sh": always } }, (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("ledger", "check.sh", ledgerOutcomes)], exemptions });
      expect(result.verdict).toBe("FAIL");
      expect(result.findings.join("\n")).toContain('FAIL stale exemption: check=ledger record="instance [ledger]"');
    });
  } finally {
    rmSync(dirname(exemptions), { recursive: true, force: true });
  }
});

test("an exemption naming no declared check FAILs as an orphan", () => {
  const exemptions = tempFile("no-such-check\tsome record\twritten against a check that is gone\n");
  try {
    withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("tracked-only", "check.sh")], exemptions });
      expect(result.verdict).toBe("FAIL");
      expect(result.findings.join("\n")).toContain("FAIL orphan exemption: check=no-such-check");
    });
  } finally {
    rmSync(dirname(exemptions), { recursive: true, force: true });
  }
});

test("an exemption whose check could not be compared is UNVERIFIED, never called stale", () => {
  // Saying "stale" here would assert something about evidence this run does not
  // have -- the same defect the stranded-work checker was corrected for.
  const exemptions = tempFile("absent\tsome record\tdeliberate somewhere else\n");
  try {
    withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
      const result = checkParity({
        repo,
        checks: [{ id: "absent", argv: (world) => ["/bin/bash", join(world, "no-such-check.sh")], outcomes: exitStatusOnlyOutcomes }],
        exemptions,
      });
      expect(result.verdict).toBe("UNKNOWN");
      expect(result.findings.join("\n")).toContain("UNKNOWN unverified exemption: check=absent");
      expect(result.findings.join("\n")).not.toContain("stale exemption");
    });
  } finally {
    rmSync(dirname(exemptions), { recursive: true, force: true });
  }
});

test("a malformed exemptions row is UNKNOWN, never a silently ignored line", () => {
  const exemptions = tempFile("ledger\tonly-two-columns\n");
  try {
    withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
      const result = checkParity({ repo, checks: [scriptCheck("tracked-only", "check.sh")], exemptions });
      expect(result.verdict).toBe("UNKNOWN");
      expect(result.findings.join("\n")).toContain("not a three-column check/record/reason row");
    });
  } finally {
    rmSync(dirname(exemptions), { recursive: true, force: true });
  }
});

test("an absent exemptions file exempts nothing rather than failing the run", () => {
  withRepo(INBOX_FIXTURE, (repo) => {
    const result = checkParity({
      repo,
      checks: [scriptCheck("ledger", "check.sh", ledgerOutcomes)],
      exemptions: join(repo, "no-such-exemptions.tsv"),
    });
    expect(result.verdict).toBe("FAIL");
    expect(result.evidence.join("\n")).toContain("exemptions=0");
  });
});

// --- the extractors read output, and refuse output they cannot read ---------

test("the ledger extractor reads levels and files, and drops the trailing detail", () => {
  const set = ledgerOutcomes(
    {
      stdout: "PASS instance [ledger]  865 rows in /tmp/world-a\n\nsummary: 0 FAIL, 0 UNKNOWN, 0 WARN, 0 SKIP, 1 PASS (32 docs)\n",
      stderr: "",
      status: 0,
    },
    "/tmp/world-a",
  );
  expect("records" in set).toBe(true);
  const records = (set as { records: { key: string; value: string }[] }).records;
  expect(records).toContainEqual({ key: "instance [ledger]", value: "PASS" });
  expect(records).toContainEqual({ key: "docs", value: "32" });
  expect(records.map((record) => record.key).join(" ")).not.toContain("865 rows");
});

test("a ledger run whose printed tally disagrees with what this harness parsed is unmeasured", () => {
  // A parser that silently drops lines and then compares what it kept is the
  // false green the outcome set exists to remove, so the mismatch is fatal.
  const set = ledgerOutcomes(
    { stdout: "PASS instance [ledger]\n\nsummary: 0 FAIL, 0 UNKNOWN, 0 WARN, 0 SKIP, 4 PASS (32 docs)\n", stderr: "", status: 0 },
    "",
  );
  expect(unmeasuredReason(set)).toContain("not parsed faithfully");
});

test("a ledger run that printed no summary did not finish, and is unmeasured rather than empty", () => {
  const set = ledgerOutcomes({ stdout: "PASS instance [ledger]\n", stderr: "", status: 0 }, "");
  expect(unmeasuredReason(set)).toContain("no summary line");
});

test("an unparseable outcome set makes that world UNKNOWN, never compared as if it had been read", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\necho no-vocabulary-here\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("ledger", "check.sh", ledgerOutcomes)] });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("world=primary UNKNOWN: the ledger check printed no summary line");
  });
});

test("the shared-stash extractor drops the worktree count, which differs between the kinds by definition", () => {
  const worktree = sharedStashOutcomes({ stdout: "SHARED-STASH status=clean worktrees=2\n", stderr: "", status: 0 }, "");
  const clone = sharedStashOutcomes({ stdout: "SHARED-STASH status=clean worktrees=1\n", stderr: "", status: 0 }, "");
  expect(worktree).toEqual(clone);
  expect(worktree).toEqual({ records: [{ key: "status", value: "clean" }, { key: "exit-status", value: "0" }] });
});

test("the fleet-cap control compares every tracked-derived field it prints", () => {
  const set = fleetCapOutcomes({ stdout: "FLEET-CAP clean cap=10 wake_below=3 target=0 declared_by=lane:a\n", stderr: "", status: 0 }, "");
  const records = (set as { records: { key: string; value: string }[] }).records;
  expect(records).toContainEqual({ key: "cap", value: "10" });
  expect(records).toContainEqual({ key: "declared_by", value: "lane:a" });
});

test("a world path in printed output is normalized away, so three directories are not three divergences", () => {
  const a = reachabilityOutcomes({ stdout: "MECHANISM-REACHABILITY unreadable file: /tmp/a/x.tsv\n", stderr: "", status: 1 }, "/tmp/a");
  const b = reachabilityOutcomes({ stdout: "MECHANISM-REACHABILITY unreadable file: /tmp/b/x.tsv\n", stderr: "", status: 1 }, "/tmp/b");
  expect(a).toEqual(b);
});

// --- UNKNOWN, never PASS ---------------------------------------------------

test("a source with no resolvable HEAD is UNKNOWN, not PASS", () => {
  const notARepo = mkdtempSync(join(tmpdir(), "parity-bare-"));
  try {
    const result = checkParity({ repo: notARepo, checks: [scriptCheck("never-runs", "check.sh")] });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("no resolvable HEAD");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test("a check absent from a world is UNKNOWN for that world, and one measured world is never a parity", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [{ id: "absent", argv: (world) => ["/bin/bash", join(world, "no-such-check.sh")], outcomes: exitStatusOnlyOutcomes }] });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("check=absent world=primary UNKNOWN");
    expect(result.findings.join("\n")).toContain("was measured in 0 world(s)");
  });
});

test("a check killed by the bound is UNKNOWN named as a kill, never a pass and never a fail", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nsleep 30\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [scriptCheck("hangs", "check.sh")], timeoutMs: 300 });
    expect(result.verdict).toBe("UNKNOWN");
    const finding = result.findings.find((line) => line.includes("check=hangs world=primary"));
    expect(finding).toContain("was killed by");
    expect(result.findings.join("\n")).not.toContain("DIVERGED");
  });
});

test("an empty declared check set measures nothing and says so", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const result = checkParity({ repo, checks: [] });
    expect(result.verdict).toBe("UNKNOWN");
    expect(result.findings.join("\n")).toContain("declared check set is empty");
  });
});

test("an observed divergence outranks an unbuildable world", () => {
  // A world nobody could build does not un-observe a disagreement between two
  // worlds that WERE built, so the verdict is FAIL and the UNKNOWN rides along.
  withRepo(
    { tracked: { "check.sh": "#!/bin/bash\ntest -f \"$1/inbox.jsonl\"\n" }, untracked: { "inbox.jsonl": "{}\n" } },
    (repo) => {
      const root = mkdtempSync(join(tmpdir(), "parity-root-"));
      try {
        // Occupy the lane-worktree path so `git worktree add` cannot create it.
        mkdirSync(join(root, "lane-worktree"), { recursive: true });
        writeFileSync(join(root, "lane-worktree", "in-the-way"), "");
        const result = checkParity({ repo, root, checks: [scriptCheck("reads-untracked", "check.sh")] });
        expect(result.verdict).toBe("FAIL");
        expect(result.evidence.join("\n")).toContain("world=lane-worktree UNBUILT");
        expect(result.findings.join("\n")).toContain("DIVERGED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

test("an UNKNOWN caused only by an unbuilt world states the reason as a FINDING, not only in evidence", () => {
  // A consumer that reads findings saw an unexplained UNKNOWN before this.
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const root = mkdtempSync(join(tmpdir(), "parity-root-"));
    try {
      mkdirSync(join(root, "lane-worktree"), { recursive: true });
      writeFileSync(join(root, "lane-worktree", "in-the-way"), "");
      const result = checkParity({ repo, root, checks: [scriptCheck("tracked-only", "check.sh")] });
      expect(result.verdict).toBe("UNKNOWN");
      const finding = result.findings.find((line) => line.startsWith("world=lane-worktree UNBUILT:"));
      expect(finding).toBeDefined();
      expect(finding).toContain("worktree-add-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- world construction ----------------------------------------------------

test("building the lane worktree does not add a sibling to the primary world", () => {
  withRepo({ tracked: { "a.txt": "a\n" } }, (repo) => {
    const root = mkdtempSync(join(tmpdir(), "parity-root-"));
    try {
      const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
      const worlds = buildWorlds(repo, sha, root);
      expect(worlds.map((world) => world.name)).toEqual([...WORLD_NAMES]);
      const primary = worlds.find((world) => world.name === "primary")!;
      expect("path" in primary).toBe(true);
      const listed = Bun.spawnSync(["git", "-C", (primary as { path: string }).path, "worktree", "list", "--porcelain"]).stdout.toString();
      expect(listed.split("\n").filter((line) => line.startsWith("worktree ")).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("the primary world says out loud when the source carried nothing extra", () => {
  withRepo({ tracked: { "a.txt": "a\n" } }, (repo) => {
    const root = mkdtempSync(join(tmpdir(), "parity-root-"));
    try {
      const sha = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
      const primary = buildWorlds(repo, sha, root).find((world) => world.name === "primary")!;
      expect((primary as { note: string }).note).toContain("differs from land-main structurally only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("an over-bound mirror makes the primary world UNKNOWN rather than a second land-main", () => {
  const repo = fixtureRepo({ tracked: { "a.txt": "a\n" } });
  const destination = mkdtempSync(join(tmpdir(), "parity-dest-"));
  try {
    for (let index = 0; index < 12; index += 1) writeFileSync(join(repo, `untracked-${index}.txt`), "xxxx");
    // Below the bound the mirror is faithful; above it the world is UNKNOWN.
    // A bound that silently produced a thinner primary would make the primary
    // world compare as a second land-main, which is the fail-open shape gate E
    // exists to remove.
    expect(mirrorWorkingTree(repo, destination, { maxPaths: 12 })).toEqual({ note: "mirrored 12 untracked/ignored path(s) from the source checkout" });
    const overPaths = mirrorWorkingTree(repo, destination, { maxPaths: 11 });
    expect(overPaths).toEqual({ unknown: "the source checkout carries 12 untracked/ignored path(s), over the 11 bound this harness will mirror" });
    const overBytes = mirrorWorkingTree(repo, destination, { maxBytes: 8 });
    expect("unknown" in overBytes && overBytes.unknown).toContain("exceeds the 8-byte bound");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("a symlink is mirrored as a symlink, not resolved into its target's bytes", () => {
  const repo = fixtureRepo({ tracked: { "a.txt": "a\n" }, untracked: { "real.txt": "real\n" } });
  const destination = mkdtempSync(join(tmpdir(), "parity-dest-"));
  try {
    symlinkSync("real.txt", join(repo, "link.txt"));
    // Dangling too: an installed dependency tree carries both, and a mirror
    // that refused either would leave the primary world permanently UNKNOWN on
    // the one repository gate E is about.
    symlinkSync("gone.txt", join(repo, "dangling"));
    expect(mirrorWorkingTree(repo, destination)).toEqual({ note: "mirrored 3 untracked/ignored path(s) from the source checkout" });
    expect(lstatSync(join(destination, "link.txt")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(destination, "link.txt"))).toBe("real.txt");
    expect(lstatSync(join(destination, "dangling")).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("a mirror that cannot be completed is UNKNOWN, not a thinner primary world", () => {
  const repo = fixtureRepo({ tracked: { "a.txt": "a\n" }, untracked: { "nested/file.txt": "x\n" } });
  const destination = mkdtempSync(join(tmpdir(), "parity-dest-"));
  try {
    // `nested` is already a regular FILE in the destination, so creating the
    // directory the mirror needs cannot succeed even for root.
    writeFileSync(join(destination, "nested"), "in the way");
    const mirrored = mirrorWorkingTree(repo, destination);
    expect("unknown" in mirrored).toBe(true);
    expect((mirrored as { unknown: string }).unknown).toContain("nested/file.txt");
    expect((mirrored as { unknown: string }).unknown).toContain("could not be mirrored into the primary world");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test("an unbuildable primary world is UNKNOWN and never compared as if it were built", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const root = mkdtempSync(join(tmpdir(), "parity-root-"));
    try {
      // Occupy the primary path so `git clone` cannot create it.
      mkdirSync(join(root, "primary"), { recursive: true });
      writeFileSync(join(root, "primary", "in-the-way"), "");
      const result = checkParity({ repo, root, checks: [scriptCheck("green", "check.sh")] });
      expect(result.verdict).toBe("UNKNOWN");
      expect(result.evidence.join("\n")).toContain("world=primary UNBUILT");
      expect(result.evidence.join("\n")).toContain("clone-failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// --- the declared set is declared -----------------------------------------

test("every declared check names a file the real tree tracks", () => {
  const tracked = new Set(Bun.spawnSync(["git", "-C", REAL_REPO, "ls-files", "-z"]).stdout.toString().split("\0").filter(Boolean));
  expect(DECLARED_CHECKS.length).toBeGreaterThan(0);
  for (const check of DECLARED_CHECKS) {
    const argv = check.argv(REAL_REPO, process.execPath);
    const relative = argv[1]!.slice(REAL_REPO.length + 1);
    expect(tracked.has(relative), `${check.id} -> ${relative}`).toBe(true);
  }
});

test("the declared set stays a bounded sample and every member is justified in the header", () => {
  const source = readFileSync(join(import.meta.dir, "check-checkout-parity.ts"), "utf8");
  const header = source.slice(0, source.indexOf("import {"));
  expect(DECLARED_CHECKS.length).toBeLessThanOrEqual(6);
  for (const check of DECLARED_CHECKS) expect(header, `header must justify ${check.id}`).toContain(check.id);
  expect(header).toContain("THE DECLARED CHECK SET");
});

test("no declared member is compared on exit status alone", () => {
  // The structural half of the repair. The blind extractor stays reachable so
  // the rejected comparison can be executed in a lock, and is refused to every
  // member of the declared set, so blindness cannot return by omission.
  for (const check of DECLARED_CHECKS) {
    expect(check.outcomes, `${check.id} must declare an outcome extractor`).toBeDefined();
    expect(check.outcomes, `${check.id} must not be exit-status blind`).not.toBe(exitStatusOnlyOutcomes);
  }
});

test("the tracked exemptions file exists, parses, and is empty of rows", () => {
  const rows = readParityExemptions(join(REAL_REPO, EXEMPTIONS_FILE));
  expect(Array.isArray(rows), "the tracked exemptions file must parse").toBe(true);
  expect(rows).toEqual([]);
  const tracked = Bun.spawnSync(["git", "-C", REAL_REPO, "ls-files", "--error-unmatch", EXEMPTIONS_FILE], { stdout: "pipe", stderr: "pipe" });
  expect(tracked.exitCode).toBe(0);
});

test("the checker carries no numeric verify count and no verify-count field", () => {
  const source = readFileSync(join(import.meta.dir, "check-checkout-parity.ts"), "utf8");
  expect(source).not.toContain("verify-count");
});

// --- the executable, end to end -------------------------------------------

test("the CLI exits 0 on parity, 1 on divergence, 3 on unknown", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 0\n" } }, (repo) => {
    const green = Bun.spawnSync([process.execPath, CHECKER, "--repo", repo, "--timeout-ms", "60000"], { stdout: "pipe", stderr: "pipe" });
    // The real declared set is absent from this fixture, so every check is
    // UNKNOWN there -- which is itself the fail-closed answer under test.
    expect(green.exitCode).toBe(EXIT_CODES.UNKNOWN);
    expect(green.stdout.toString()).toContain("CHECKOUT-PARITY UNKNOWN");
  });

  const real = Bun.spawnSync([process.execPath, CHECKER, "--repo", REAL_REPO], { stdout: "pipe", stderr: "pipe" });
  expect([EXIT_CODES.PASS, EXIT_CODES.FAIL, EXIT_CODES.UNKNOWN]).toContain(real.exitCode);
  expect(real.stdout.toString()).toContain(`worlds=${WORLD_NAMES.join(",")}`);
});

test("the CLI really exits 1 on a divergence — the arm the fixture set above never reached", () => {
  // The declared set is what the executable runs, so a fixture repo cannot make
  // it diverge. Copying the four declared checks into a fixture as scripts
  // would test the copies. Instead the fixture supplies the ONE declared member
  // whose divergence is cheap to stage -- hygiene/check-shared-stash.sh, whose
  // whole job is to tell a linked worktree from a clone -- and the other three
  // stay absent, which is UNKNOWN. A divergence outranks that, so the exit is 1.
  withRepo({}, (repo) => {
    mkdirSync(join(repo, "hygiene"), { recursive: true });
    writeFileSync(
      join(repo, "hygiene/check-shared-stash.sh"),
      [
        "#!/bin/bash",
        'if [ "$(git -C "$1" rev-parse --git-dir)" = "$(git -C "$1" rev-parse --git-common-dir)" ]; then',
        '  echo "SHARED-STASH status=clean worktrees=1"',
        "else",
        '  echo "SHARED-STASH status=fail detail=worktree-inventory-empty worktrees=2" >&2',
        "  exit 1",
        "fi",
        "",
      ].join("\n"),
    );
    const commit = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    commit("add", "-A");
    commit("commit", "--quiet", "-m", "stage a divergence in one declared member");
    const run = Bun.spawnSync([process.execPath, CHECKER, "--repo", repo, "--timeout-ms", "60000"], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(EXIT_CODES.FAIL);
    expect(run.stdout.toString()).toContain("CHECKOUT-PARITY FAIL");
    expect(run.stderr.toString()).toContain("check=shared-stash DIVERGED");
  });
});

test("a missing argument value is UNKNOWN, never a silent default", () => {
  const run = Bun.spawnSync([process.execPath, CHECKER, "--repo"], { stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(EXIT_CODES.UNKNOWN);
  expect(run.stderr.toString()).toContain("argument-missing");
});

test("runCheck reports a non-zero exit as a fail verdict rather than an error", () => {
  withRepo({ tracked: { "check.sh": "#!/bin/bash\nexit 3\n" } }, (repo) => {
    const outcome = runCheck(scriptCheck("red", "check.sh"), repo, process.execPath, 30_000);
    expect(outcome).toEqual({ verdict: "fail", status: 3, outcomes: { records: [{ key: "exit-status", value: "3" }] } });
  });
});

// --- registration ----------------------------------------------------------

test("the checker is registered under the id gate E looks for, in both manifests", () => {
  for (const manifest of ["instance/required-mechanisms.tsv", "instance/expected-mechanisms.tsv"]) {
    const contents = readFileSync(join(REAL_REPO, manifest), "utf8");
    expect(contents, manifest).toContain("checker:checkout-parity\tchecker\ttools/check-checkout-parity.ts");
  }
});
