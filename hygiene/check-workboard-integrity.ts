#!/usr/bin/env bun
// Structural integrity checker for instance/workboard.md. Filed as V3-0.43:
// e0cd52b landed a workboard corrupted by a JavaScript string-replacement
// `$&`/`` $` ``/`$'` expansion (66 spurious duplicated lines) through the full
// gate, and stayed wrong for hours because nothing ever read the file's shape.
import { readFileSync, statSync } from "fs";

export type Cell = string;
export type Header = { columns: string[]; line: number; section: string };
export type Row = { id: string; line: number; cells: Cell[]; raw: string; header: Header | null };
export type Heading = { text: string; line: number };
export type Issue = { message: string };

const ROW_ID_PATTERN = /^V\d+-\d+(?:\.\d+)*[a-z]?$/;

// Split a markdown table row on unescaped `|`. `\|` is a literal pipe inside
// a cell, not a column separator -- the rule the corrupted rows violated.
export function splitTableRow(line: string): Cell[] {
  const cells: Cell[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      current += "\\|";
      i++;
      continue;
    }
    if (line[i] === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += line[i];
  }
  cells.push(current);
  return cells;
}

function isTableLine(line: string): boolean {
  return /^\|.*\|\s*$/.test(line);
}

function isSeparatorRow(cells: Cell[]): boolean {
  return cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
}

export function headings(text: string): Heading[] {
  const found: Heading[] = [];
  text.split("\n").forEach((line, index) => {
    if (/^#{1,6}\s+\S/.test(line)) found.push({ text: line.trim(), line: index + 1 });
  });
  return found;
}

// A table's shape is declared by its own header row, not by a constant here.
// The live board proved why: Phases 2, 3 and 4 each declared three columns
// while carrying four-cell rows, so a hard-coded `4` called 25 correct rows
// broken and let a genuinely four-cell row in a three-column table (V3-3.10)
// pass in silence. Read what the document declares, then hold rows to it.
export function tables(text: string): { headers: Header[]; rows: Row[] } {
  const lines = text.split("\n");
  const headers: Header[] = [];
  const found: Row[] = [];
  let header: Header | null = null;
  let section = "";
  lines.forEach((line, index) => {
    if (/^#{1,6}\s+\S/.test(line)) {
      section = line.trim();
      header = null; // a heading ends the table above it
      return;
    }
    if (!isTableLine(line)) {
      if (line.trim() === "") header = null; // a blank line ends the table block
      return;
    }
    const inner = splitTableRow(line).slice(1, -1); // drop the empty edges before the first and after the last `|`
    if (isSeparatorRow(inner)) return;
    const id = (inner[0] ?? "").trim();
    if (!ROW_ID_PATTERN.test(id)) {
      // Not a data row, so it opens a table block: this is its header.
      if (header === null) {
        header = { columns: inner.map((cell) => cell.trim()), line: index + 1, section };
        headers.push(header);
      }
      return;
    }
    found.push({ id, line: index + 1, cells: inner, raw: line, header });
  });
  return { headers, rows: found };
}

export function rows(text: string): Row[] {
  return tables(text).rows;
}

// Only used for a data row that has no header above it -- a detached row, which
// the e0cd52b block duplication could produce. It is reported as detached, and
// checked against the board's usual four columns so the row is never skipped.
const FALLBACK_CELLS = 4;
const STATE_COLUMN = "state";

export function checkWorkboard(text: string): string[] {
  const issues: string[] = [];

  const headingCounts = new Map<string, number[]>();
  for (const h of headings(text)) {
    const seen = headingCounts.get(h.text) ?? [];
    seen.push(h.line);
    headingCounts.set(h.text, seen);
  }
  for (const [text_, lines] of headingCounts) {
    if (lines.length > 1) issues.push(`duplicate-heading heading=${JSON.stringify(text_)} lines=${lines.join(",")}`);
  }

  const { headers, rows: allRows } = tables(text);

  // A table that carries item rows must declare where their state lives. Without
  // this, the state rule could be silenced by deleting a column header rather
  // than by producing evidence -- which is how Phases 2-4 came to have no state
  // column at all while their rows still needed one.
  for (const header of headers) {
    if (!allRows.some((row) => row.header === header)) continue;
    if (!header.columns.some((column) => column.toLowerCase() === STATE_COLUMN)) {
      issues.push(`no-state-column section=${JSON.stringify(header.section || "(none)")} header-line=${header.line} columns=${header.columns.join(",")}`);
    }
  }

  const idLines = new Map<string, number[]>();
  for (const row of allRows) {
    const seen = idLines.get(row.id) ?? [];
    seen.push(row.line);
    idLines.set(row.id, seen);
  }
  for (const [id, lines] of idLines) {
    if (lines.length > 1) issues.push(`duplicate-row-id id=${id} lines=${lines.join(",")}`);
  }

  for (const row of allRows) {
    const expected = row.header ? row.header.columns.length : FALLBACK_CELLS;
    if (row.header === null) issues.push(`detached-row id=${row.id} line=${row.line} (no table header above it)`);
    if (row.cells.length !== expected) {
      const source = row.header ? `header-line=${row.header.line}` : "workboard-default";
      issues.push(`bad-cell-count id=${row.id} line=${row.line} cells=${row.cells.length} expected=${expected} ${source}`);
      continue;
    }
    const stateIndex = row.header
      ? row.header.columns.findIndex((column) => column.toLowerCase() === STATE_COLUMN)
      : FALLBACK_CELLS - 1;
    if (stateIndex < 0) continue; // already reported as no-state-column
    if ((row.cells[stateIndex] ?? "").trim().length === 0) issues.push(`empty-state id=${row.id} line=${row.line}`);
  }

  return issues;
}

function readableFile(path: string): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o444) === 0) throw new Error("unreadable");
    return readFileSync(path, "utf8");
  } catch (error) {
    console.error(`WORKBOARD-INTEGRITY FAIL cause=file-unreadable path=${path} detail=${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function argument(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Bun.argv[index + 1];
  if (!value) {
    console.error(`WORKBOARD-INTEGRITY FAIL cause=argument-missing name=${name}`);
    process.exit(1);
  }
  return value;
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  const path = argument("--workboard", `${root}instance/workboard.md`);
  const text = readableFile(path);
  const issues = checkWorkboard(text);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`WORKBOARD-INTEGRITY FAIL ${issue}`);
    process.exit(1);
  }
  console.log(`WORKBOARD-INTEGRITY PASS rows=${rows(text).length}`);
}
