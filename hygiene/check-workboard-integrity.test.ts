import { expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { checkWorkboard, splitTableRow, tables } from "./check-workboard-integrity.ts";

const repoRoot = join(import.meta.dir, "..");

function git(args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// Every fixture below is a whole table -- header, separator, rows -- because the
// checker derives a table's shape from its own header rather than from a
// constant. A row is only checkable against the columns its table declares.
function table(header: string, ...rows: string[]): string {
  const separator = `|${"---|".repeat(splitTableRow(header).length - 2)}`;
  return ["## Phase 9 — fixture", "", header, separator, ...rows].join("\n");
}

test("splitTableRow treats \\| as a literal cell character, not a separator", () => {
  expect(splitTableRow("|a|b\\|c|d|")).toEqual(["", "a", "b\\|c", "d", ""]);
});

test("red-before: replays the exact e0cd52b damage and refuses it", () => {
  const corrupted = git(["show", "e0cd52b:instance/workboard.md"]);
  const issues = checkWorkboard(corrupted);
  expect(issues.some((i) => i.startsWith("duplicate-heading") && i.includes("Phase 0"))).toBe(true);
  expect(issues.some((i) => i.startsWith("duplicate-heading") && i.includes("Phase 1"))).toBe(true);
  expect(issues.some((i) => i.startsWith("duplicate-row-id") && i.includes("id=V3-0.1 "))).toBe(true);
});

// c0c0609 (the commit e0cd52b corrupted) predates this row's own fix, so it still
// carries the separate, pre-existing missing-state defect (V3-0.43's second finding)
// -- it must NOT carry the e0cd52b-specific duplication, which is what this locks.
test("green-after (corruption-specific): the pre-corruption workboard at c0c0609 has no duplicated heading or row id", () => {
  const clean = git(["show", "c0c0609:instance/workboard.md"]);
  const issues = checkWorkboard(clean);
  expect(issues.filter((i) => i.startsWith("duplicate-heading") || i.startsWith("duplicate-row-id"))).toEqual([]);
});

test("refuses a duplicated section heading, naming it", () => {
  const text = [
    "# v3 workboard",
    "",
    "## Phase 0 — x",
    "",
    "| id | row | acceptance | state |",
    "|---|---|---|---|",
    "| V3-0.1 | do a thing | it works | **done** |",
    "",
    "## Phase 0 — x",
    "",
  ].join("\n");
  const issues = checkWorkboard(text);
  expect(issues.some((i) => i.startsWith("duplicate-heading") && i.includes("Phase 0"))).toBe(true);
});

test("refuses the document header appearing more than once", () => {
  const text = ["# v3 workboard", "", "text", "", "# v3 workboard", ""].join("\n");
  const issues = checkWorkboard(text);
  expect(issues.some((i) => i.startsWith("duplicate-heading") && i.includes("v3 workboard"))).toBe(true);
});

test("refuses a duplicated row id, naming it", () => {
  const text = table(
    "| id | row | acceptance | state |",
    "| V3-9.1 | first filing | acceptance text | **done** |",
    "| V3-9.1 | a stale second copy | acceptance text | **open** |",
  );
  const issues = checkWorkboard(text);
  expect(issues.some((i) => i === "duplicate-row-id id=V3-9.1 lines=5,6")).toBe(true);
});

test("refuses a row whose cell count differs from its table header, with \\| correctly counted as escaped", () => {
  const text = table(
    "| id | row | acceptance | state |",
    "| V3-9.2 | a row with no state column at all | acceptance text |",
    "| V3-9.3 | row | acceptance | **partial** — a | **done** — b |",
    "| V3-9.4 | row | a \\| b | **done** |",
  );
  const issues = checkWorkboard(text);
  expect(issues.some((i) => i.startsWith("bad-cell-count id=V3-9.2") && i.includes("cells=3 expected=4"))).toBe(true);
  expect(issues.some((i) => i.startsWith("bad-cell-count id=V3-9.3") && i.includes("cells=5 expected=4"))).toBe(true);
  expect(issues.some((i) => i.includes("id=V3-9.4"))).toBe(false);
});

test("refuses a row with an empty state cell, naming it", () => {
  const text = table("| id | row | acceptance | state |", "| V3-9.5 | row | acceptance |  |");
  expect(checkWorkboard(text)).toEqual(["empty-state id=V3-9.5 line=5"]);
});

test("an id-only row with a mismatched column count still counts as one bad row, not a silent pass", () => {
  const text = table("| id | row | acceptance | state |", "| V3-9.6 | row |");
  expect(checkWorkboard(text)).toEqual(["bad-cell-count id=V3-9.6 line=5 cells=2 expected=4 header-line=3"]);
});

test("a header row, separator row, and non-item prose table are not mistaken for data rows", () => {
  const text = table("| id | row | acceptance | state |", "| not-an-id | x | y | z |");
  expect(checkWorkboard(text)).toEqual([]);
});

test("undetermined is an accepted, non-empty state", () => {
  const text = table("| id | row | acceptance | state |", "| V3-9.7 | row | acceptance | **undetermined** — no landing evidence found |");
  expect(checkWorkboard(text)).toEqual([]);
});

// The letter-suffixed ids are the reason this checker exists in the shape it
// does: the orchestrator's own first audit matched `V3-[0-9.]+` and silently
// skipped V3-1.9a/V3-1.9b, which is how V3-1.9b's missing state went unseen.
// A checker that does not see a row cannot refuse it.
test("letter-suffixed ids are checked, not skipped", () => {
  const text = table("| id | row | acceptance | state |", "| V3-1.9b | row | acceptance |");
  expect(checkWorkboard(text)).toEqual(["bad-cell-count id=V3-1.9b line=5 cells=3 expected=4 header-line=3"]);
  expect(tables(table("| id | row | acceptance | state |", "| V3-1.9a | r | a | **done** |")).rows.map((r) => r.id)).toEqual(["V3-1.9a"]);
});

// The three-column half of the same defect. Before this row, Phases 2, 3 and 4
// declared `| id | row | acceptance |` while carrying rows that did have a
// state; a fixed four-column rule called their correct rows broken and let a
// genuine four-cell row in a three-column table pass. Both directions locked.
test("a table whose header declares no state column is refused, naming the section", () => {
  const text = table("| id | row | acceptance |", "| V3-9.8 | row | acceptance |");
  const issues = checkWorkboard(text);
  expect(issues.some((i) => i.startsWith("no-state-column") && i.includes("Phase 9 — fixture") && i.includes("columns=id,row,acceptance"))).toBe(true);
});

test("a four-cell row inside a three-column table is refused, not silently accepted", () => {
  const text = table("| id | row | acceptance |", "| V3-9.9 | row | acceptance | **done** |");
  const issues = checkWorkboard(text);
  expect(issues.some((i) => i.startsWith("bad-cell-count id=V3-9.9") && i.includes("cells=4 expected=3"))).toBe(true);
});

test("the state column is located by name, not by position", () => {
  const filled = table("| id | state | row | acceptance |", "| V3-9.10 | **done** | row | acceptance |");
  expect(checkWorkboard(filled)).toEqual([]);
  const blank = table("| id | state | row | acceptance |", "| V3-9.11 |  | row | acceptance |");
  expect(checkWorkboard(blank)).toEqual(["empty-state id=V3-9.11 line=5"]);
});

test("a data row with no table header above it is reported detached rather than skipped", () => {
  const text = ["## Phase 9 — fixture", "", "| V3-9.12 | row | acceptance | **done** |"].join("\n");
  const issues = checkWorkboard(text);
  expect(issues).toEqual(["detached-row id=V3-9.12 line=3 (no table header above it)"]);
});

test("the landed workboard passes clean", () => {
  const text = readFileSync(join(repoRoot, "instance", "workboard.md"), "utf8");
  expect(checkWorkboard(text)).toEqual([]);
});

// Every row on the real board carries a non-empty state. Asserted separately
// from the clean check so that a future weakening of `checkWorkboard` cannot
// make this property vanish quietly along with it.
test("every row on the landed workboard carries a non-empty state", () => {
  const { rows } = tables(readFileSync(join(repoRoot, "instance", "workboard.md"), "utf8"));
  expect(rows.length).toBeGreaterThan(0);
  const stateless = rows.filter((row) => {
    const index = row.header?.columns.findIndex((column) => column.toLowerCase() === "state") ?? -1;
    return index < 0 || (row.cells[index] ?? "").trim().length === 0;
  });
  expect(stateless.map((row) => row.id)).toEqual([]);
});

test("CLI exits non-zero and names the fault on a corrupted file, zero on the real board", () => {
  const bad = spawnSync("bun", [join(import.meta.dir, "check-workboard-integrity.ts"), "--workboard", "/dev/null"], { encoding: "utf8" });
  expect(bad.status).not.toBe(0);

  const good = spawnSync("bun", [join(import.meta.dir, "check-workboard-integrity.ts"), "--workboard", join(repoRoot, "instance", "workboard.md")], {
    encoding: "utf8",
  });
  expect(good.status).toBe(0);
  expect(good.stdout).toContain("WORKBOARD-INTEGRITY PASS");
});

// V3-0.28's lesson: a checker that exists but is never invoked is not a
// mechanism. Assert the gate actually runs this one, and that it is registered
// in the repository's mechanism inventory rather than excluded from it.
test("the landing gate invokes this checker, and the inventory names it", () => {
  expect(readFileSync(join(repoRoot, "gate/land.sh"), "utf8")).toContain("hygiene/check-workboard-integrity.ts");
  expect(readFileSync(join(repoRoot, "instance/expected-mechanisms.tsv"), "utf8")).toContain("hygiene/check-workboard-integrity.ts");
  expect(readFileSync(join(repoRoot, "instance/required-mechanisms.tsv"), "utf8")).toContain("hygiene/check-workboard-integrity.ts");
  expect(readFileSync(join(repoRoot, "instance/expected-mechanism-exclusions.tsv"), "utf8")).not.toContain("checker:workboard-integrity");
});
