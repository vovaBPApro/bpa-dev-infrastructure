// Fixture tests for the HR-state inversion and closure resolution (V3-3.1,
// plan items 1 and 2).
//
// THE POINT OF THIS FILE IS THAT THE CHECKER CAN FAIL. Seven "a check that
// cannot fail" instances were found in two days of audits, one of them added by
// the commit that fixed two others. Every test below is red-before/green-after:
// each builds a corpus that the OLD predicate accepted (and, where the old
// behaviour is still reachable, asserts that it did), then asserts the new
// predicate refuses it.
//
// No real chat text appears in any fixture. instance/decisions/inbox.jsonl is
// gitignored because raw inbound may contain credentials; these fixtures use
// invented ids and invented prose only.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHrAging,
  checkHrStates,
  checkTriageClosures,
  closureToken,
  hrDisposition,
  isHrOpen,
  parseHrFields,
  capturedMsgIds,
  dischargedMsgIds,
  collectWorkboardRows,
  resolvesTarget,
  resolveTarget,
  collectResolvables,
  readExemptions,
  readParkedHorizonDays,
  DEFAULT_PARKED_HORIZON_DAYS,
  HR_STATES,
  CONTAINER_FILES,
  WORKBOARD_PATH,
} from "./ledger.ts";

const NOW = Date.parse("2026-08-05T12:00:00Z");

// A disposable repo with the minimum this checker reads: a decisions dir, a
// workboard, and an instructions dir for doc-id resolution.
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "hr-state-"));
  mkdirSync(join(root, "instance", "decisions"), { recursive: true });
  mkdirSync(join(root, "instructions"), { recursive: true });
  writeFileSync(
    join(root, "instance", "workboard.md"),
    ["| id | need | acceptance | status |", "|---|---|---|---|", "| V3-9.1 | a real row | done | open |", ""].join("\n"),
  );
  writeFileSync(
    join(root, "instructions", "sample-doc.md"),
    ["---", "id: sample-doc", "layer: L1", "status: binding", "---", "", "# Sample", ""].join("\n"),
  );
  return root;
}

function writeHr(root: string, id: string, frontmatter: string[] | undefined, body = "# Requirement\n"): void {
  const contents = frontmatter === undefined ? body : ["---", ...frontmatter, "---", "", body].join("\n");
  writeFileSync(join(root, "instance", "decisions", `HR-${id}.md`), contents);
}

function writeTriage(root: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(root, "instance", "decisions", "triage.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
}

function fails(findings: Array<{ level: string; detail: string }>): string[] {
  return findings.filter((finding) => finding.level === "FAIL").map((finding) => finding.detail);
}

// The pre-inversion predicate, kept verbatim so "red before" is demonstrated
// against the real thing rather than against a paraphrase of it. Every delivery
// path in the repository was one of these two lines.
const OLD_DELIVERY_PREDICATE = (contents: string): boolean =>
  /^---\r?\n([\s\S]*?)\r?\n---/.exec(contents)?.[1]?.split(/\r?\n/).some((line) => /^state\s*:\s*pending\s*$/.test(line)) ??
  false;

describe("the trap the inversion removes", () => {
  test("RED BEFORE: a stateless capture was delivered by nothing and marked handled by its filename", () => {
    const root = makeRepo();
    try {
      writeHr(root, "2171", undefined, "# Backup design\n\nA long, well-written capture with no frontmatter.\n");
      const contents = ["---", "---", "", "# Backup design"].join("\n");

      // Both halves of the trap, asserted directly.
      expect(OLD_DELIVERY_PREDICATE(contents)).toBe(false); // reaches no pack, no session
      expect(capturedMsgIds(join(root, "instance", "decisions")).has("2171")).toBe(true); // suppresses the inbox row

      // GREEN AFTER: the same file is now open, delivered, and a FAIL.
      expect(isHrOpen("# Backup design\n")).toBe(true);
      expect(fails(checkHrStates(root, NOW)).some((detail) => detail.includes("no `state:` field"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("captured and discharged are different claims", () => {
    const root = makeRepo();
    try {
      // Captured only: an HR file exists, but its obligation is open.
      writeHr(root, "500", ["state: owed", "tracked-by: V3-9.1"]);
      // Discharged: closed state with a target that resolves.
      writeHr(root, "501", ["state: routed", "routes-to: sample-doc"]);
      // Closure claim that resolves to nothing -> NOT discharged.
      writeHr(root, "502", ["state: routed", "routes-to: NI-1"]);

      const captured = capturedMsgIds(join(root, "instance", "decisions"));
      expect(captured.has("500")).toBe(true);
      expect(captured.has("502")).toBe(true);

      const discharged = dischargedMsgIds(root);
      expect(discharged.has("501")).toBe(true);
      expect(discharged.has("500")).toBe(false); // owed is not discharged
      expect(discharged.has("502")).toBe(false); // an unresolvable claim is not a discharge
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkHrStates fails, by named rule", () => {
  test("a stateless HR file is a FAIL and is treated as open", () => {
    const root = makeRepo();
    try {
      writeHr(root, "100", undefined);
      const findings = checkHrStates(root, NOW);
      expect(fails(findings).some((detail) => detail.includes("no `state:` field"))).toBe(true);
      expect(hrDisposition(parseHrFields("# no frontmatter"))).toBe("open");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an out-of-vocabulary state is a FAIL and is treated as open", () => {
    const root = makeRepo();
    try {
      // The three strays measured in the real corpus, none of them declared.
      for (const [id, state] of [["101", "open"], ["102", "backlog"], ["103", "captured"]] as const) {
        writeHr(root, id, [`state: ${state}`]);
      }
      const detail = fails(checkHrStates(root, NOW));
      expect(detail.filter((line) => line.includes("outside the vocabulary")).length).toBe(3);
      expect(hrDisposition({ state: "backlog" })).toBe("open");
      expect(HR_STATES).not.toContain("backlog" as never);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`owed` without `tracked-by` is a FAIL", () => {
    const root = makeRepo();
    try {
      writeHr(root, "104", ["state: owed"]);
      expect(fails(checkHrStates(root, NOW)).some((detail) => detail.includes("requires `tracked-by:`"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`tracked-by` naming a workboard row that does not exist is a FAIL", () => {
    const root = makeRepo();
    try {
      writeHr(root, "105", ["state: owed", "tracked-by: V3-9.1"]); // exists
      writeHr(root, "106", ["state: owed", "tracked-by: NI-1"]); // renumbered away
      const detail = fails(checkHrStates(root, NOW));
      expect(detail.some((line) => line.includes("tracked-by 'NI-1'"))).toBe(true);
      expect(detail.some((line) => line.includes("HR-105"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F1 exactly: renumbering the board reddens the closure it orphaned", () => {
    const root = makeRepo();
    try {
      writeHr(root, "146", ["state: routed", "routes-to: NI-1"]);
      // Before the rebuild, NI-1 was a real row and the claim resolved.
      writeFileSync(
        join(root, "instance", "workboard.md"),
        ["| id | need |", "|---|---|", "| NI-1 | personas |", ""].join("\n"),
      );
      expect(fails(checkHrStates(root, NOW)).length).toBe(0);
      expect(dischargedMsgIds(root).has("146")).toBe(true);

      // The renumbering commit — the one that landed on 2026-07-31 and was not
      // caught for four days — now goes red, at the commit that breaks it.
      writeFileSync(
        join(root, "instance", "workboard.md"),
        ["| id | need |", "|---|---|", "| V3-9.1 | personas |", ""].join("\n"),
      );
      expect(fails(checkHrStates(root, NOW)).some((detail) => detail.includes("routes-to 'NI-1'"))).toBe(true);
      expect(dischargedMsgIds(root).has("146")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolution accepts a workboard row, a repo path, or a doc id — and only those", () => {
    const root = makeRepo();
    try {
      const resolvables = collectResolvables(root);
      expect(resolvesTarget(root, resolvables, "V3-9.1")).toBe(true);
      expect(resolvesTarget(root, resolvables, "sample-doc")).toBe(true);
      expect(resolvesTarget(root, resolvables, "instructions/sample-doc.md")).toBe(true);
      // Backtick wrapping is still accepted; the PROSE around it no longer is.
      // Round 1 resolved this whole sentence because one token inside it named
      // a doc — see the round-2 block at the bottom of this file.
      expect(resolvesTarget(root, resolvables, "`sample-doc`")).toBe(true);
      expect(resolvesTarget(root, resolvables, "`sample-doc` (a wrapped prose value)")).toBe(false);

      expect(resolvesTarget(root, resolvables, "workboard")).toBe(false); // names no row
      expect(resolvesTarget(root, resolvables, "NI-1")).toBe(false);
      expect(resolvesTarget(root, resolvables, "instructions/absent.md")).toBe(false);
      expect(resolvesTarget(root, resolvables, "")).toBe(false);
      expect(resolvesTarget(root, resolvables, undefined)).toBe(false);
      // A claim may not escape the repository to find something that exists.
      expect(resolvesTarget(root, resolvables, "../../etc/passwd")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("workboard row ids are read from the board, not from a hard-coded shape", () => {
    const root = makeRepo();
    try {
      writeFileSync(
        join(root, "instance", "workboard.md"),
        ["| **B-7** | bold id |", "| ZZ-12.4 | another installation's shape |", "| not-a-row | text |", ""].join("\n"),
      );
      const rows = collectWorkboardRows(root);
      expect(rows.has("B-7")).toBe(true);
      expect(rows.has("ZZ-12.4")).toBe(true);
      expect(rows.has("not-a-row")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("triage closure claims", () => {
  const row = (extra: Record<string, unknown>) => ({
    msg_id: 1,
    verdict: "directive",
    category: "sample",
    reason: "sample",
    triaged_by: "tester",
    triaged_at: "2026-08-05",
    quote: "an invented fixture quote",
    ...extra,
  });

  test("`closes:` pointing at a row id that does not exist is a FAIL", () => {
    const root = makeRepo();
    try {
      writeTriage(root, [row({ msg_id: 1, answer_status: "answered", closes: "NI-1" })]);
      expect(fails(checkTriageClosures(root, NOW)).some((d) => d.includes("closes 'NI-1'"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`closes:` pointing at a real row passes", () => {
    const root = makeRepo();
    try {
      writeTriage(root, [row({ msg_id: 1, answer_status: "answered", closes: "V3-9.1" })]);
      expect(fails(checkTriageClosures(root, NOW)).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directive with no answer_status is a FAIL — unknown is open, not silence", () => {
    const root = makeRepo();
    try {
      writeTriage(root, [row({ msg_id: 7 })]);
      expect(fails(checkTriageClosures(root, NOW)).some((d) => d.includes("msg 7 has no answer_status"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a chatter row needs no answer_status", () => {
    const root = makeRepo();
    try {
      writeTriage(root, [row({ msg_id: 8, verdict: "chatter" })]);
      expect(fails(checkTriageClosures(root, NOW)).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the exemption ledger cannot outlive its reason", () => {
  const entry = (subject: string, rule: string, expires: string) =>
    `${subject}\t${rule}\t${expires}\towner=V3-9.1; a named legacy reason\n`;

  function writeLedger(root: string, body: string): void {
    writeFileSync(join(root, "instance", "hr-state-exemptions.tsv"), `# header comment\n${body}`);
  }

  test("a live exemption downgrades its violation to a visible WARN, not silence", () => {
    const root = makeRepo();
    try {
      writeHr(root, "200", undefined);
      writeLedger(root, entry("instance/decisions/HR-200.md", "hr-state-missing", "2026-12-31"));
      const findings = checkHrStates(root, NOW);
      expect(fails(findings).length).toBe(0);
      expect(findings.some((f) => f.level === "WARN" && f.detail.includes("exempt until 2026-12-31"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an EXPIRED exemption fails, and the underlying violation comes back with it", () => {
    const root = makeRepo();
    try {
      writeHr(root, "201", undefined);
      writeLedger(root, entry("instance/decisions/HR-201.md", "hr-state-missing", "2026-08-04")); // yesterday
      const detail = fails(checkHrStates(root, NOW));
      expect(detail.some((d) => d.includes("EXEMPTION-EXPIRED"))).toBe(true);
      expect(detail.some((d) => d.includes("no `state:` field"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a STALE exemption fails — the V3-2.16 lesson, not a second design", () => {
    const root = makeRepo();
    try {
      writeHr(root, "202", ["state: routed", "routes-to: sample-doc"]); // no longer violates
      writeLedger(root, entry("instance/decisions/HR-202.md", "hr-state-missing", "2026-12-31"));
      expect(fails(checkHrStates(root, NOW)).some((d) => d.includes("EXEMPTION-STALE"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a NEW violation is not exempted by an unrelated entry on the same file", () => {
    const root = makeRepo();
    try {
      // Exempted for a missing state; it now has a state, and a broken closure.
      writeHr(root, "203", ["state: routed", "routes-to: NI-1"]);
      writeLedger(root, entry("instance/decisions/HR-203.md", "hr-state-missing", "2026-12-31"));
      const detail = fails(checkHrStates(root, NOW));
      // The new violation rides in on nothing: keyed on subject+rule, not subject.
      expect(detail.some((d) => d.includes("routes-to 'NI-1'"))).toBe(true);
      // ...and the now-discharged exemption is itself reported.
      expect(detail.some((d) => d.includes("EXEMPTION-STALE"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an HR pass does not declare triage debt discharged, or the reverse", () => {
    const root = makeRepo();
    try {
      writeHr(root, "204", ["state: routed", "routes-to: sample-doc"]);
      writeTriage(root, [
        {
          msg_id: 9,
          verdict: "directive",
          category: "sample",
          reason: "sample",
          triaged_by: "tester",
          triaged_at: "2026-08-05",
          quote: "an invented fixture quote",
        },
      ]);
      writeLedger(root, entry("msg:9", "triage-answer-status-missing", "2026-12-31"));
      // The HR pass owns none of the triage rules, so it must not call this stale.
      expect(fails(checkHrStates(root, NOW)).some((d) => d.includes("EXEMPTION-STALE"))).toBe(false);
      // The triage pass consumes it, so it is not stale there either.
      expect(fails(checkTriageClosures(root, NOW)).length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed, unowned, undated or unknown-rule entry is itself a FAIL", () => {
    const root = makeRepo();
    try {
      writeHr(root, "205", undefined);
      writeLedger(
        root,
        [
          "instance/decisions/HR-205.md\thr-state-missing\t2026-12-31", // 3 columns
          "instance/decisions/HR-205.md\tinvented-rule\t2026-12-31\towner=V3-9.1; r",
          "instance/decisions/HR-205.md\thr-state-missing\tnot-a-date\towner=V3-9.1; r",
          "instance/decisions/HR-205.md\thr-state-missing\t2026-12-31\tno owner field",
          "",
        ].join("\n"),
      );
      const detail = fails(checkHrStates(root, NOW));
      expect(detail.some((d) => d.includes("malformed entry"))).toBe(true);
      expect(detail.some((d) => d.includes("unknown rule 'invented-rule'"))).toBe(true);
      expect(detail.some((d) => d.includes("unparseable expiry"))).toBe(true);
      expect(detail.some((d) => d.includes("owner=<id>"))).toBe(true);
      // None of them excused the real violation.
      expect(detail.some((d) => d.includes("no `state:` field"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a duplicate subject+rule entry is a FAIL", () => {
    const root = makeRepo();
    try {
      writeHr(root, "206", undefined);
      writeLedger(
        root,
        entry("instance/decisions/HR-206.md", "hr-state-missing", "2026-12-31") +
          entry("instance/decisions/HR-206.md", "hr-state-missing", "2027-12-31"),
      );
      expect(fails(checkHrStates(root, NOW)).some((d) => d.includes("duplicate exemption"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readExemptions ignores comments and blank lines", () => {
    const root = makeRepo();
    try {
      writeFileSync(
        join(root, "instance", "hr-state-exemptions.tsv"),
        ["# a comment", "", "  # an indented comment", entry("instance/decisions/HR-1.md", "hr-state-missing", "2026-12-31")].join("\n"),
      );
      const { entries, findings } = readExemptions(root);
      expect(entries.length).toBe(1);
      expect(findings.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("delivery polarity", () => {
  test("isHrOpen selects everything not provably closed", () => {
    expect(isHrOpen("---\nstate: pending\n---\n")).toBe(true);
    expect(isHrOpen("---\nstate: owed\n---\n")).toBe(true);
    expect(isHrOpen("---\nstate: backlog\n---\n")).toBe(true); // out of vocabulary
    expect(isHrOpen("# no frontmatter at all\n")).toBe(true);

    expect(isHrOpen("---\nstate: routed\n---\n")).toBe(false);
    expect(isHrOpen("---\nstate: superseded\n---\n")).toBe(false);
    expect(isHrOpen("---\nstate: parked\n---\n")).toBe(false); // deferred, not open
  });

  test("RED BEFORE: the old allowlist selected none of the open ones", () => {
    for (const contents of [
      "---\nstate: owed\n---\n",
      "---\nstate: backlog\n---\n",
      "# no frontmatter at all\n",
    ]) {
      expect(OLD_DELIVERY_PREDICATE(contents)).toBe(false); // invisible before
      expect(isHrOpen(contents)).toBe(true); // delivered now
    }
  });

  test("parseHrFields reads the closure fields the old parser dropped", () => {
    const fields = parseHrFields(
      ["---", "state: owed", "date: 2026-08-05", "tracked-by: V3-9.1", "routes-to: sample-doc", "superseded-by: HR-1", "---", ""].join("\n"),
    );
    expect(fields.state).toBe("owed");
    expect(fields.trackedBy).toBe("V3-9.1");
    expect(fields.routesTo).toBe("sample-doc");
    expect(fields.supersededBy).toBe("HR-1");
  });
});

// ---------------------------------------------------------------------------
// Round-2 review, finding 3: a closure claim must resolve to a SPECIFIC target.
//
// Round 1 resolved a claim when AT LEAST ONE whitespace-separated token in it
// named something real. The reviewer measured five values against a fresh
// `state: routed` HR file; four of them were accepted, including one whose own
// words say the work is not done. Those five are the fixtures below, verbatim
// from the review, with `V3-9.1` standing in for this corpus's row id and
// `sample-doc` for a doc id. The pass/fail column is what must hold NOW; the
// OLD_TOKEN_OR predicate reproduces round 1's rule so each case is red-before
// as well as green-after, and shows exactly which ones flipped.
// ---------------------------------------------------------------------------

// Round 1's resolver, kept verbatim in behaviour: split on whitespace, resolve
// on any token that names something. It is the thing being refuted.
function OLD_TOKEN_OR(root: string, resolvables: ReturnType<typeof collectResolvables>, value: string): boolean {
  const tokens: string[] = [];
  for (const match of value.matchAll(/`([^`]+)`/g)) tokens.push(match[1].trim());
  for (const raw of value.split(/[\s,;()]+/)) {
    const token = raw.replace(/^[`'"]+|[`'".,;:]+$/g, "").trim();
    if (token !== "") tokens.push(token);
  }
  for (const token of tokens) {
    if (resolvables.workboardRows.has(token)) return true;
    if (resolvables.docIds.has(token)) return true;
    if (/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(token) && !token.includes("..")) {
      if (token.includes("/") && existsSync(join(root, token))) return true;
    }
  }
  return false;
}

describe("a closure claim resolves to one specific target, not to a token in a sentence", () => {
  // The reviewer's five measured cases, in their order, with the verdict each
  // must now produce and the reason a reader gets.
  const CASES: Array<{ value: string; resolution: string; oldVerdict: boolean }> = [
    // A container: it exists no matter what happened to the row the claim was
    // about, so it discharges nothing. This is the one that broke acceptance
    // item 4 — with the board path accepted, renaming the row left the claim
    // green, and 21 of 21 resolving claims in the real corpus used this shape.
    { value: "instance/workboard.md", resolution: "container", oldVerdict: true },
    // Prose. `sample-doc` is a real doc id, which is the ONLY reason round 1
    // accepted a sentence that names no target at all.
    { value: "handled in the sample-doc doc", resolution: "prose", oldVerdict: true },
    { value: "see instructions/sample-doc.md for the rest", resolution: "prose", oldVerdict: true },
    // The case that decides the design: a closure claim whose own words say the
    // work is NOT done, accepted because it happened to mention the board file.
    { value: "not done yet, tracked in instance/workboard.md", resolution: "prose", oldVerdict: true },
    // Already correct before this change, and locked so it stays that way: the
    // fix must not be a blanket refusal that would pass this test for the wrong
    // reason.
    { value: "V3-NONEXISTENT", resolution: "unresolved", oldVerdict: false },
  ];

  for (const { value, resolution, oldVerdict } of CASES) {
    test(`'${value}' -> ${resolution}`, () => {
      const root = makeRepo();
      try {
        const resolvables = collectResolvables(root);
        // RED BEFORE: round 1's rule, run here, gives the verdict the review
        // measured. Four of these five were accepted.
        expect(OLD_TOKEN_OR(root, resolvables, value)).toBe(oldVerdict);
        // GREEN AFTER: none of the five resolves.
        expect(resolveTarget(root, resolvables, value)).toBe(resolution as never);
        expect(resolvesTarget(root, resolvables, value)).toBe(false);

        // And the whole checker goes red on a real HR file carrying it, with
        // the rule name the exemption ledger keys on.
        writeHr(root, "90001", ["id: hr-90001", "date: 2026-08-04", "state: routed", `routes-to: ${value}`]);
        const finding = checkHrStates(root, NOW).find((f) => f.file.endsWith("HR-90001.md"));
        expect(finding?.level).toBe("FAIL");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("ACCEPTANCE ITEM 4: renaming the row an HR points at turns the suite red, untouched", () => {
    // The property round 1 claimed and did not have. The HR file is written
    // once and never edited; only the board changes.
    const root = makeRepo();
    try {
      writeHr(root, "90002", ["id: hr-90002", "date: 2026-08-04", "state: routed", "routes-to: V3-9.1"]);
      expect(checkHrStates(root, NOW).find((f) => f.file.endsWith("HR-90002.md"))?.level).toBe("PASS");

      // Renumber the board. Nothing else moves.
      writeFileSync(
        join(root, "instance", "workboard.md"),
        ["| id | need | acceptance | status |", "|---|---|---|---|", "| V3-9.2 | a real row | done | open |", ""].join("\n"),
      );
      expect(checkHrStates(root, NOW).find((f) => f.file.endsWith("HR-90002.md"))?.level).toBe("FAIL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("RED BEFORE: the board-path shape survived the same renumbering", () => {
    // Why the corpus had to be rewritten rather than left alone: under round 1
    // this exact edit was invisible, because the board file resolved regardless.
    const root = makeRepo();
    try {
      const value = "instance/workboard.md V3-9.1";
      writeFileSync(
        join(root, "instance", "workboard.md"),
        ["| id | need | acceptance | status |", "|---|---|---|---|", "| V3-9.2 | renamed | done | open |", ""].join("\n"),
      );
      const resolvables = collectResolvables(root);
      expect(OLD_TOKEN_OR(root, resolvables, value)).toBe(true);   // renumbering unnoticed
      expect(resolvesTarget(root, resolvables, value)).toBe(false); // now noticed
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory and a README are containers; a file inside them is not", () => {
    const root = makeRepo();
    try {
      writeFileSync(join(root, "instructions", "README.md"), "# generated index\n");
      const resolvables = collectResolvables(root);
      expect(resolveTarget(root, resolvables, "instructions/README.md")).toBe("container");
      expect(resolveTarget(root, resolvables, "instance/decisions")).toBe("container");
      expect(resolveTarget(root, resolvables, "instructions/sample-doc.md")).toBe("resolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("closureToken keeps one layer of wrapping and refuses everything with a space in it", () => {
    expect(closureToken("V3-9.1")).toBe("V3-9.1");
    expect(closureToken("  V3-9.1  ")).toBe("V3-9.1");
    expect(closureToken("`V3-9.1`")).toBe("V3-9.1");
    expect(closureToken('"V3-9.1"')).toBe("V3-9.1");
    expect(closureToken("V3-9.1 and V3-9.2")).toBeUndefined();
    expect(closureToken("")).toBeUndefined();
    expect(closureToken(undefined)).toBeUndefined();
  });

  test("a triage `closes:` claim is refused for the same container, however it is spelled", () => {
    // Same resolver, second field. Round 2 shipped the container rule with
    // `closes: instance/workboard.md` refused and `closes: ./instance/
    // workboard.md` producing no finding at all, so the bypass reproduced here
    // verbatim.
    const root = makeRepo();
    try {
      for (const value of ["instance/workboard.md", "./instance/workboard.md", "instance//workboard.md"]) {
        writeTriage(root, [
          {
            msg_id: 90004,
            verdict: "directive",
            category: "infra",
            reason: "routed",
            triaged_by: "orch",
            triaged_at: "2026-08-04",
            quote: "an invented directive",
            answer_status: "answered",
            closes: value,
          },
        ]);
        const findings = checkTriageClosures(root, NOW);
        expect(
          findings.some((f) => f.level === "FAIL" && f.detail.includes("is a container that exists regardless")),
        ).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a triage `closes:` claim is held to the same rule", () => {
    const root = makeRepo();
    try {
      writeTriage(root, [
        {
          msg_id: 90003,
          verdict: "directive",
          category: "infra",
          reason: "routed",
          triaged_by: "orch",
          triaged_at: "2026-08-04",
          quote: "an invented directive",
          answer_status: "answered",
          closes: "not done yet, tracked in instance/workboard.md",
        },
      ]);
      const findings = checkTriageClosures(root, NOW);
      expect(findings.some((f) => f.level === "FAIL" && f.detail.includes("is prose, not a target"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Round-3 review, finding A: a container is a container however it is spelled.
//
// Round 2 fixed the case the round-1 reviewer measured and left the PROPERTY
// false. It decided the two file containers by comparing the token STRING, so
// one file got opposite verdicts depending on two characters of typing:
// `instance/workboard.md` was refused, `./instance/workboard.md` discharged the
// obligation and left the checker green, and `./CLAUDE.md` did the same to a
// file round 1 had named by name.
//
// A list of the spellings someone thought of would repeat that mistake one
// round later, so this locks the property instead: every container in the rule
// crossed with every spelling transform, asserted to give ONE answer. Adding a
// container to `CONTAINER_FILES` or a transform to `SPELLINGS` extends the grid
// without touching a case.
// ---------------------------------------------------------------------------

// Round 2's rule, kept verbatim in behaviour beside round 1's above, so "red
// before" is demonstrated against the real thing rather than a paraphrase.
function OLD_STRING_CONTAINER(root: string, token: string): "container" | "resolved" | "unresolved" {
  const container = (): boolean => {
    if (token === "instance/workboard.md") return true;
    if (token.split("/").pop() === "README.md") return true;
    try {
      return statSync(join(root, token)).isDirectory();
    } catch {
      return false;
    }
  };
  if (/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(token) && !token.includes("..")) {
    // node's join() normalizes, so `existsSync` already answered about the
    // resolved file while the container test above answered about the token.
    // That disagreement between two lines is the whole defect.
    if (token.includes("/") && existsSync(join(root, token))) {
      return container() ? "container" : "resolved";
    }
  }
  return "unresolved";
}

// Ways of writing the same repo-relative path. Every one is legal, every one is
// already used by tracked docs somewhere, and none of them changes which file is
// named. `instructions/` is used as the pivot because makeRepo() always creates
// it.
const SPELLINGS: Array<{ name: string; spell: (path: string) => string }> = [
  { name: "canonical", spell: (path) => path },
  { name: "leading ./", spell: (path) => `./${path}` },
  { name: "repeated ./", spell: (path) => `././${path}` },
  { name: "leading .//", spell: (path) => `.//${path}` },
  { name: "up and back", spell: (path) => `instructions/../${path}` },
  { name: "up, back and down", spell: (path) => `instructions/.././${path}` },
  {
    name: "interior /./",
    spell: (path) => (path.includes("/") ? path.replace("/", "/./") : `./${path}`),
  },
  {
    name: "interior //",
    spell: (path) => (path.includes("/") ? path.replace("/", "//") : `.//${path}`),
  },
  { name: "trailing /.", spell: (path) => `${path}/.` },
];

describe("a container is a container however it is spelled", () => {
  // Gives makeRepo() the rest of the container set: the root agent contract
  // pair (AGENTS.md a symlink to CLAUDE.md, as Hard Rule 5 requires) and a
  // generated index.
  function makeContainerRepo(): string {
    const root = makeRepo();
    writeFileSync(join(root, "CLAUDE.md"), "# Agent contract\n");
    symlinkSync("CLAUDE.md", join(root, "AGENTS.md"));
    writeFileSync(join(root, "instructions", "README.md"), "# generated index\n");
    return root;
  }

  // Every kind of container the rule names, each written the canonical way.
  const CONTAINERS = [
    "instance/workboard.md", // the file row ids are enumerated out of
    "CLAUDE.md", // the root agent contract
    "AGENTS.md", // ... and its symlink, which is the same file
    "instructions/README.md", // a generated index
    "instructions", // a directory
    "instance/decisions", // a nested directory
  ];

  for (const container of CONTAINERS) {
    for (const { name, spell } of SPELLINGS) {
      const value = spell(container);
      test(`${container} spelled '${value}' (${name}) discharges nothing`, () => {
        const root = makeContainerRepo();
        try {
          const resolvables = collectResolvables(root);
          expect(resolveTarget(root, resolvables, value)).toBe("container");
          expect(resolvesTarget(root, resolvables, value)).toBe(false);

          // And the whole rule goes red on a real HR file carrying it, with the
          // repair a reader can act on rather than a bare "invalid".
          writeHr(root, "90201", ["id: hr-90201", "date: 2026-08-04", "state: routed", `routes-to: ${value}`]);
          const finding = checkHrStates(root, NOW).find((f) => f.file.endsWith("HR-90201.md"));
          expect(finding?.level).toBe("FAIL");
          expect(finding?.detail).toContain("is a container that exists regardless");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  test("RED BEFORE: round 2's string comparison discharged the obligation for most of that grid", () => {
    // The regression this locks, stated as a count so it cannot quietly shrink
    // to zero: under round 2's rule, some spelling of a container resolved.
    const root = makeContainerRepo();
    try {
      const escaped: string[] = [];
      for (const container of CONTAINERS) {
        for (const { spell } of SPELLINGS) {
          const value = spell(container);
          if (OLD_STRING_CONTAINER(root, value) !== "container") escaped.push(value);
        }
      }
      expect(escaped.length).toBeGreaterThan(0);
      // The two the round-3 review measured by hand are in it, by name.
      expect(escaped).toContain("./instance/workboard.md");
      expect(escaped).toContain("./CLAUDE.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a NON-container resolves under every one of those spellings", () => {
    // Without this the grid above would pass for the wrong reason: a rule that
    // refuses everything with a `.` in it locks nothing.
    const root = makeContainerRepo();
    try {
      const resolvables = collectResolvables(root);
      for (const { name, spell } of SPELLINGS) {
        const value = spell("instructions/sample-doc.md");
        expect([name, resolveTarget(root, resolvables, value)]).toEqual([name, "resolved"]);
      }
      // ... and so does a real workboard row, which is not a path at all.
      expect(resolveTarget(root, resolvables, "V3-9.1")).toBe("resolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a symlink to a container is the container, and a symlink out of the repo resolves to nothing", () => {
    // Identity, not spelling, is what the rule now reads — so a name that does
    // not look like any container in the set is still refused when it IS one,
    // and the containment rule survives the one escape a string-level `..`
    // refusal could never see.
    const root = makeContainerRepo();
    try {
      symlinkSync(join(root, "instance", "workboard.md"), join(root, "instructions", "board-link.md"));
      symlinkSync(join(root, "instructions", "README.md"), join(root, "instructions", "index-link.md"));
      symlinkSync(tmpdir(), join(root, "instructions", "escape"));
      const resolvables = collectResolvables(root);
      expect(resolveTarget(root, resolvables, "instructions/board-link.md")).toBe("container");
      expect(resolveTarget(root, resolvables, "instructions/index-link.md")).toBe("container");
      expect(resolveTarget(root, resolvables, "instructions/escape")).toBe("unresolved");
      expect(resolveTarget(root, resolvables, "../etc/hostname")).toBe("unresolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the container set is data the rule reads, not a literal repeated in it", () => {
    // WORKBOARD_PATH is shared with collectWorkboardRows(), so the file row ids
    // come OUT of is the same file the rule refuses. Locked because the two
    // drifting apart is exactly how a container becomes discharging again.
    expect(CONTAINER_FILES).toContain(WORKBOARD_PATH);
    expect(CONTAINER_FILES).toContain("CLAUDE.md");
    expect(CONTAINER_FILES).toContain("AGENTS.md");
  });
});

// ---------------------------------------------------------------------------
// Round-2 review, finding 5: `parked` is bounded and counted.
// ---------------------------------------------------------------------------

describe("parked is bounded and counted, not a quiet hiding place", () => {
  const parkedHr = (reviewBy: string) => [
    "id: hr-90004",
    "date: 2026-08-04",
    "state: parked",
    "parked: waiting on the operator",
    `review-by: ${reviewBy}`,
  ];

  test("RED BEFORE: an unbounded horizon was green, undelivered and uncounted", () => {
    const root = makeRepo();
    try {
      // The reviewer's example, verbatim. `review-by:` was mandatory and bit
      // when past, but had no ceiling, so this parked the row for 73 years.
      writeHr(root, "90004", parkedHr("2099-01-01"));
      const findings = checkHrAging(root, NOW);
      const finding = findings.find((f) => f.file.endsWith("HR-90004.md"));
      expect(finding?.level).toBe("FAIL");
      expect(finding?.detail).toContain("parked horizon");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a park inside the horizon still passes — the bound is a ceiling, not a ban", () => {
    const root = makeRepo();
    try {
      writeHr(root, "90004", parkedHr("2026-09-15")); // 41 days out, inside 90
      expect(checkHrAging(root, NOW).find((f) => f.file.endsWith("HR-90004.md"))?.level).toBe("PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the horizon is an instance parameter, not a hard-coded number", () => {
    const root = makeRepo();
    try {
      expect(readParkedHorizonDays(root)).toBe(DEFAULT_PARKED_HORIZON_DAYS);
      writeFileSync(join(root, "instance", "params.yaml"), "ledger:\n  parked_horizon_days: 7\n");
      expect(readParkedHorizonDays(root)).toBe(7);
      writeHr(root, "90004", parkedHr("2026-09-15")); // inside 90, outside 7
      expect(checkHrAging(root, NOW).find((f) => f.file.endsWith("HR-90004.md"))?.level).toBe("FAIL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parked rows are counted next to open ones, never folded into them", () => {
    const root = makeRepo();
    try {
      writeHr(root, "90004", parkedHr("2026-09-15"));
      writeHr(root, "90005", ["id: hr-90005", "date: 2026-08-04", "state: owed", "tracked-by: V3-9.1"]);
      const summary = checkHrStates(root, NOW).find((f) => f.file === "instance/decisions/");
      expect(summary?.detail).toContain("1 open HR obligation(s)");
      expect(summary?.detail).toContain("1 parked");
      // A parked row is deferred: not open, not delivered, but on the count.
      expect(hrDisposition(parseHrFields(["---", ...parkedHr("2026-09-15"), "---"].join("\n")))).toBe("deferred");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
