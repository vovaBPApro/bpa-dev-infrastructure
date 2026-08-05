import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTree, renderInstanceIndex, INSTANCE_INDEX_MARKER } from "./index.ts";

const generator = join(import.meta.dir, "index.ts");
const checker = join(import.meta.dir, "..", "instructions", "check.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// A throwaway repository carrying the surfaces the checker and the generator
// read. It is a real git repo with everything staged: tracked-ness is what the
// generator enumerates, so a fixture that is not a repository would exercise the
// fallback instead of the path this installation actually runs.
function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "instance-index-"));
  temporaryDirectories.push(repo);
  const contents: Record<string, string> = {
    "instructions/valid-doc.md":
      "---\nid: valid-doc\nlayer: L1\nstatus: binding\naudience: all\ntags: [hygiene]\nsummary: A valid doc.\n---\n\nBody.\n",
    "gate/land-lib.sh": readFileSync(join(import.meta.dir, "../../gate/land-lib.sh"), "utf8"),
    ...files,
  };
  for (const [name, body] of Object.entries(contents)) {
    const full = join(repo, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  spawnSync("git", ["-C", repo, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
  return repo;
}

function triage(rows: Array<Record<string, unknown>>): string {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function directive(msg_id: number, quote: string, answer_status?: string): Record<string, unknown> {
  return {
    msg_id,
    verdict: "directive",
    category: "product-input",
    reason: "captured",
    triaged_by: "orchestrator",
    triaged_at: "2026-08-04",
    quote,
    ...(answer_status ? { answer_status } : {}),
  };
}

function runGenerator(repo: string, extra: string[] = []) {
  return spawnSync("bun", [generator, "--repo", repo, ...extra], { encoding: "utf8" });
}

function runCheck(repo: string) {
  return spawnSync("bun", [checker, "--repo", repo], { encoding: "utf8" });
}

describe("instance index generation", () => {
  test("is idempotent and carries the generator marker", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "перше", "owed")]),
    });
    expect(runGenerator(repo).status).toBe(0);
    const first = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(runGenerator(repo).status).toBe(0);
    const second = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(second).toBe(first);
    expect(first.startsWith(INSTANCE_INDEX_MARKER)).toBe(true);
    // The renderer and the CLI must agree, or --check would print something the
    // file never contains.
    expect(renderInstanceIndex(repo)).toBe(first);
  });

  test("--check prints without writing the file", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "перше", "owed")]),
    });
    const result = runGenerator(repo, ["--check"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(INSTANCE_INDEX_MARKER);
    expect(() => readFileSync(join(repo, "instance", "README.md"), "utf8")).toThrow();
  });

  test("an owed directive is listed verbatim; an answered one is not", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([
        directive(11, "це ще не дано", "owed"),
        directive(12, "на це вже відповіли", "answered"),
        { ...directive(13, "балачка"), verdict: "chatter" },
      ]),
    });
    runGenerator(repo);
    const index = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(index).toContain("**1 open**");
    expect(index).toContain("> це ще не дано");
    expect(index).not.toContain("на це вже відповіли");
    expect(index).not.toContain("балачка");
  });

  // The operator's objection to the whole design ("актуалізовувати треба"): a
  // row must leave the list because the LEDGER changed, with nobody editing the
  // index. This is that property, stated as a test.
  test("flipping a row to answered removes it on the next generation, with no edit to the file", () => {
    const ledger = ["instance", "decisions", "triage.jsonl"];
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "перше", "owed"), directive(12, "друге", "owed")]),
    });
    runGenerator(repo);
    expect(readFileSync(join(repo, "instance", "README.md"), "utf8")).toContain("**2 open**");

    writeFileSync(
      join(repo, ...ledger),
      triage([directive(11, "перше", "answered"), directive(12, "друге", "owed")]),
    );
    runGenerator(repo);
    const after = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(after).toContain("**1 open**");
    expect(after).not.toContain("> перше");
    expect(after).toContain("> друге");
  });

  test("a directive with no answer_status is named, not silently dropped", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "owed one", "owed"), directive(77, "unclassified one")]),
    });
    runGenerator(repo);
    const index = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(index).toContain("**1 unclassified:** `77`");
  });

  // inbox.jsonl is gitignored because raw inbound chat may carry credentials,
  // and this file is tracked. Nothing from it may ever appear here.
  test("nothing from inbox.jsonl reaches the generated file", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "quoted from the ledger", "owed")]),
      "instance/decisions/inbox.jsonl": JSON.stringify({
        msg_id: 999,
        ts: "2026-08-04T00:00:00Z",
        text: "UNIQUE-INBOX-CONTENT-THAT-MUST-NOT-LEAK",
      }),
    });
    runGenerator(repo);
    const index = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(index).not.toContain("UNIQUE-INBOX-CONTENT-THAT-MUST-NOT-LEAK");
    expect(index).not.toContain("999");
    // Indexed by path and purpose, which is the whole permitted treatment.
    expect(index).toContain("`instance/decisions/inbox.jsonl`");
  });

  test("credentials render from the tracked inventory, and a malformed row cannot half-render", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "x", "owed")]),
      "instance/credentials.tsv":
        "# comment\n" +
        "drive-key\t/root/.config/example.json\tagent@example.iam\twriting backups\toperator\n" +
        "broken-row\t/root/.config/broken.json\tonly-three-fields\n",
    });
    runGenerator(repo);
    const index = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(index).toContain("`drive-key`");
    expect(index).toContain("/root/.config/example.json");
    expect(index).toContain("agent@example.iam");
    expect(index).not.toContain("broken-row");
  });

  test("rulings are ordered by date, not by message id", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "x", "owed")]),
      // The Telegram numbering restarted: the five-digit id is the OLDER ruling.
      "instance/decisions/HR-11549.md": "---\nid: hr-11549\ndate: 2026-07-29\n---\n\n# HR-11549 — old ruling\n",
      "instance/decisions/HR-2456.md": "# HR-2456 — new ruling\n\ndate: 2026-08-05\n",
      "instance/decisions/HR-2171.md": "# HR-2171 — undated frontmatter\n\nRecorded 2026-08-04 from Telegram message 2171.\n",
    });
    runGenerator(repo);
    const index = readFileSync(join(repo, "instance", "README.md"), "utf8");
    const order = ["HR-2456", "HR-2171", "HR-11549"].map((id) => index.indexOf(`[${id}]`));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
    // The undated file's date is recovered from its opening lines.
    expect(index).toContain("[HR-2171](decisions/HR-2171.md) · 2026-08-04");
    expect(index).not.toContain("(no date)");
  });

  test("evidence directories are listed with their own titles", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "x", "owed")]),
      "instance/incidents/2026-08-05-something.md": "# The suite went red, 2026-08-05\n",
      "instance/sprints/sprint-01.md": "# Sprint 01\n",
    });
    runGenerator(repo);
    const index = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(index).toContain("### Incidents — 1 (`instance/incidents/`)");
    expect(index).toContain("— The suite went red, 2026-08-05");
    expect(index).toContain("### Sprints — 1 (`instance/sprints/`)");
    expect(index).toContain("### Audits — 0 (`instance/audits/`)");
  });

  test("enumeration is tracked-file based inside a repository", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "x", "owed")]),
      "instance/incidents/tracked.md": "# Tracked incident\n",
    });
    expect(createTree(repo).mode).toBe("git");
    // An untracked file must not enter the index: it exists in one worktree and
    // not another, so it would make the freshness comparison tree-dependent.
    writeFileSync(join(repo, "instance", "incidents", "untracked.md"), "# Untracked incident\n");
    runGenerator(repo);
    const index = readFileSync(join(repo, "instance", "README.md"), "utf8");
    expect(index).toContain("Tracked incident");
    expect(index).not.toContain("Untracked incident");
  });
});

// The freshness lock: the property the operator asked for is that this file
// cannot quietly go stale. These drive it through the checker that already runs
// in the suite, in both directions.
describe("instance index freshness [check.ts]", () => {
  test("PASS after generation, FAIL when a source moves underneath it", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "перше", "owed")]),
    });
    expect(runGenerator(repo).status).toBe(0);
    spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });

    const fresh = runCheck(repo);
    expect(fresh.stdout).toContain("PASS instance/README.md [instance-index-freshness]");

    // A new owed row, and nobody regenerated: the index now understates what is
    // owed, which is exactly the failure this check exists to make loud.
    writeFileSync(
      join(repo, "instance", "decisions", "triage.jsonl"),
      triage([directive(11, "перше", "owed"), directive(12, "друге", "owed")]),
    );
    const stale = runCheck(repo);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("FAIL instance/README.md [instance-index-freshness]");

    // Regenerating is the whole fix.
    expect(runGenerator(repo).status).toBe(0);
    const regenerated = runCheck(repo);
    expect(regenerated.stdout).toContain("PASS instance/README.md [instance-index-freshness]");
    expect(regenerated.stdout).not.toContain("FAIL instance/README.md [instance-index-freshness]");
  });

  test("a hand-edited index is caught even when the sources did not move", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "перше", "owed")]),
    });
    runGenerator(repo);
    spawnSync("git", ["-C", repo, "add", "-A"], { encoding: "utf8" });
    const index = join(repo, "instance", "README.md");
    writeFileSync(index, readFileSync(index, "utf8").replace("**1 open**", "**0 open**"));

    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL instance/README.md [instance-index-freshness]");
  });

  test("an index without the generator marker is SKIP, not FAIL", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "перше", "owed")]),
      "instance/README.md": "# This installation\n\nhand written\n",
    });
    const result = runCheck(repo);
    expect(result.stdout).toContain("SKIP instance/README.md [instance-index-freshness]");
    expect(result.stdout).not.toContain("FAIL instance/README.md [instance-index-freshness]");
  });

  // Absence is deliberately not this check's job: CLAUDE.md cites the path, so a
  // deleted index is already a FAIL under the path-exists check. Locking the SKIP
  // keeps the two checks from both claiming the same ground and disagreeing.
  test("a missing index is SKIP here, because path-exists owns its existence", () => {
    const repo = repoWith({
      "instance/decisions/triage.jsonl": triage([directive(11, "перше", "owed")]),
    });
    const result = runCheck(repo);
    expect(result.stdout).toContain("SKIP instance/README.md [instance-index-freshness]");
  });
});
