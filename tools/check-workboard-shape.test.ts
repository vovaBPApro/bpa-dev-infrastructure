/**
 * The board is read by two audiences and neither tolerates a ragged table.
 *
 * GitHub-flavoured markdown DROPS every cell past the header count, so a row that
 * grew a fifth cell renders as though the fifth cell were never written. That is
 * how the 2026-08-05 triage (`04f70d5`) wrote 59 dispositions -- with their proving
 * SHAs and re-entry conditions -- into a column the operator cannot see. Worse, GFM
 * refuses a table OUTRIGHT when the delimiter row and the header row disagree on
 * cell count: the same commit dropped the pipe before `state` in three headers, and
 * those three tables stopped rendering as tables at all.
 *
 * `orchestrator/fleet/fleet-nudge.sh` reads the same file every ten minutes and
 * refuses the whole board on a malformed row, which turns `main` red and pages the
 * operator directly. It identifies a state column by the LAST header cell being
 * literally `state`, so a rename there silently disables the watchdog's
 * unrecognised-state reporting -- pinned below for that reason.
 *
 * Escaped pipes are the trap in checking any of this: row text carries `\|` inside
 * code spans and prose, so a naive `split("|")` miscounts. The splitter here is
 * exercised against synthetic fixtures first, so a green result cannot come from a
 * checker that is itself miscounting.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const BOARD = "instance/workboard.md";

/**
 * Split one markdown table line into cells the way GFM does: a backslash-escaped
 * pipe is literal text, every other pipe is a delimiter. The leading and trailing
 * pipes of a fully-delimited row produce empty outer fields, which are not cells.
 */
export function splitCells(line: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) { cur += ch + line[i + 1]; i++; continue; }
    if (ch === "|") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  if (parts.length && parts[0].trim() === "") parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === "") parts.pop();
  return parts;
}

const isDelimiter = (cells: string[]) => cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));

export type Table = { headerLine: number; columns: number; header: string[] };

/**
 * Every way this file can render as something other than the table it claims to be.
 * Returns human-readable errors; an empty array is the only passing result.
 */
export function boardShapeErrors(text: string): string[] {
  const errors: string[] = [];
  const lines = text.split("\n");
  const ids = new Map<string, number>();
  let table: Table | null = null;
  let delimiterSeen = false;
  let tables = 0;

  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];
    if (!line.trimStart().startsWith("|")) { table = null; delimiterSeen = false; continue; }
    const cells = splitCells(line);

    if (table === null) {
      table = { headerLine: n, columns: cells.length, header: cells.map((c) => c.trim()) };
      delimiterSeen = false;
      tables++;
      // The fleet-nudge watchdog keys its state column off the last header cell.
      if (table.header[table.header.length - 1].toLowerCase() !== "state") {
        errors.push(`line ${n}: table header must end with a \`state\` column, got \`${table.header.join(" | ")}\``);
      }
      continue;
    }

    if (!delimiterSeen) {
      delimiterSeen = true;
      // GFM does not recognise the table AT ALL when these two disagree.
      if (!isDelimiter(cells)) {
        errors.push(`line ${n}: expected a delimiter row directly under the header at line ${table.headerLine}`);
      } else if (cells.length !== table.columns) {
        errors.push(
          `line ${n}: delimiter declares ${cells.length} cells, header at line ${table.headerLine} declares ${table.columns}` +
          ` -- GFM refuses the whole table, so every row below renders as literal text`,
        );
      }
      continue;
    }

    if (cells.length !== table.columns) {
      errors.push(
        `line ${n}: row \`${cells[0]?.trim() ?? ""}\` has ${cells.length} cells, header at line ${table.headerLine}` +
        ` declares ${table.columns}` +
        (cells.length > table.columns
          ? ` -- markdown drops the extra cell, so its content does not render`
          : ` -- the row renders short`),
      );
    }
    const id = (cells[0] ?? "").trim();
    const previous = ids.get(id);
    if (previous !== undefined) errors.push(`line ${n}: duplicate row id \`${id}\`, first seen at line ${previous}`);
    else ids.set(id, n);
  }

  if (tables === 0) errors.push("no markdown table found -- the board did not parse");
  return errors;
}

describe("splitCells", () => {
  test("an escaped pipe is cell text, not a delimiter", () => {
    expect(splitCells("| a | b \\| c | d |")).toEqual([" a ", " b \\| c ", " d "]);
  });

  test("a BARE pipe inside a code span still splits, exactly as GFM splits it", () => {
    // This is not a checker bug being documented -- it is the defect the board hit.
    // `|---|` written without escapes really does become four cells, not two.
    expect(splitCells("| a | see `|---|` here |")).toEqual([" a ", " see `", "---", "` here "]);
    expect(splitCells("| a | see `\\|---\\|` here |")).toEqual([" a ", " see `\\|---\\|` here "]);
  });

  test("outer pipes do not count as cells", () => {
    expect(splitCells("| a | b |")).toEqual([" a ", " b "]);
    expect(splitCells("|---|---|")).toEqual(["---", "---"]);
  });
});

describe("boardShapeErrors", () => {
  const header = "| id | row | acceptance | earlier state | state |\n|---|---|---|---|---|\n";

  test("a well-formed table produces no errors", () => {
    expect(boardShapeErrors(`${header}| V3-0.1 | r | a | | **done** |\n`)).toEqual([]);
  });

  test("a row with an extra cell is an error naming the row", () => {
    const errors = boardShapeErrors(`${header}| V3-0.1 | r | a | | **done** | extra |\n`);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("V3-0.1");
    expect(errors[0]).toContain("6 cells");
  });

  test("a row with a missing cell is an error", () => {
    const errors = boardShapeErrors(`${header}| V3-0.1 | r | a | **done** |\n`);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("renders short");
  });

  test("a header/delimiter mismatch is caught -- GFM drops the whole table", () => {
    const errors = boardShapeErrors("| id | row | acceptance  state |\n|---|---|---|---|\n| V3-0.1 | r | a | s |\n");
    expect(errors.some((e) => e.includes("refuses the whole table"))).toBe(true);
  });

  test("a header not ending in `state` is caught -- it disables the watchdog's state column", () => {
    const errors = boardShapeErrors("| id | row | acceptance | triage |\n|---|---|---|---|\n| V3-0.1 | r | a | t |\n");
    expect(errors.some((e) => e.includes("must end with a `state` column"))).toBe(true);
  });

  test("a duplicate row id is caught", () => {
    const errors = boardShapeErrors(`${header}| V3-0.1 | r | a | | s |\n| V3-0.1 | r | a | | s |\n`);
    expect(errors.some((e) => e.includes("duplicate row id"))).toBe(true);
  });

  test("escaped pipes in a row do not make it miscount", () => {
    expect(boardShapeErrors(`${header}| V3-0.1 | a \\| b | c \\| d | | **done** |\n`)).toEqual([]);
  });

  test("a stray pipe line outside a table does not start a phantom table", () => {
    expect(boardShapeErrors(`${header}| V3-0.1 | r | a | | s |\n\nprose\n`)).toEqual([]);
  });
});

describe("instance/workboard.md", () => {
  test("every row renders every cell it carries", () => {
    const errors = boardShapeErrors(readFileSync(join(REPO, BOARD), "utf8"));
    expect(errors).toEqual([]);
  });
});
