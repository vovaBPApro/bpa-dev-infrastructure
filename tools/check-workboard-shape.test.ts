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
 * A whole section appearing twice, which is the shape `e0cd52b` pasted in.
 *
 * The filing tool replaced an anchor with a *string* replacement, and JavaScript
 * expands `$&`, `` $` `` and `$'` inside one. The V3-0.38 row quotes a regex ending
 * in `$` immediately before a backtick, so `` $` `` expanded to the entire document
 * before the match -- pasting a second copy of the header, Phase 0 and Phase 1.
 *
 * The row-level checks above catch that only INCIDENTALLY, through the duplicate ids
 * the paste happened to carry. A section duplicated without rows -- a heading and its
 * prose -- produces no row error at all and lands silently. So this is its own pass:
 * a heading that repeats means a section was pasted, whatever the paste contained.
 *
 * Fenced blocks are skipped because the board embeds `sh` examples whose comment
 * lines begin with `#`, and those are not headings.
 *
 * Two properties of that skip were findings against the first round of this check,
 * and both are closed here rather than carried:
 *
 * - An UNTERMINATED fence is never closed, so it silently disables this whole pass
 *   for the rest of the document. That is not a theoretical hole for the class being
 *   locked: a partial paste that duplicates a region containing one fence marker
 *   unbalances the document and suppresses the detector at the same stroke. So an
 *   unterminated fence is reported as its own error -- the check refuses to be
 *   silently switched off.
 * - Identity is the ancestor PATH, not the heading alone. Two phases each carrying a
 *   `### Evidence` subsection is ordinary markdown, not damage, and keying on
 *   `(level, text)` over the whole document refused it. A pasted section repeats its
 *   parent headings too, so the path still collides on the real damage shape.
 */
export function boardSectionErrors(text: string): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const ancestors: { level: number; text: string }[] = [];
  let fence: { marker: string; line: number } | null = null;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];

    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = { marker, line: n };
      else if (fence.marker === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const heading = line.match(/^(#{1,6})[ \t]+(.*\S)[ \t]*$/);
    if (!heading) continue;

    const level = heading[1].length;
    const title = heading[2].trim();
    // Close every ancestor this heading is a sibling of, or outranks.
    while (ancestors.length && ancestors[ancestors.length - 1].level >= level) ancestors.pop();

    // The key is the path from the document root, serialized rather than joined on a
    // separator: no separator character is safe against heading text that contains it,
    // and the first round of this check reached for a NUL for exactly that reason.
    const key = JSON.stringify([...ancestors, { level, text: title }].map((h) => [h.level, h.text]));
    const parent = ancestors[ancestors.length - 1];
    const previous = seen.get(key);
    if (previous !== undefined) {
      errors.push(
        `line ${n}: duplicate section heading \`${line.trim()}\`` +
        (parent ? ` under \`${parent.text}\`` : ` at the top level`) +
        `, first seen at line ${previous}` +
        ` -- a section appearing twice is the \`e0cd52b\` paste shape, and the second copy` +
        ` silently diverges from the first`,
      );
    } else {
      seen.set(key, n);
    }
    ancestors.push({ level, text: title });
  }

  if (fence !== null) {
    errors.push(
      `line ${fence.line}: unterminated \`${fence.marker.repeat(3)}\` fence` +
      ` -- every heading below it is skipped, so a duplicated section pasted after this` +
      ` point would not be reported; the fence is the error`,
    );
  }

  return errors;
}

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
  // Folded in rather than left as a second entry point: the landing tier asserts on
  // this function alone, so a check it does not call is a check that does not run.
  errors.push(...boardSectionErrors(text));
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

describe("boardSectionErrors", () => {
  test("a duplicated section is caught even when it carries no rows at all", () => {
    // The case the row-level checks are blind to: no duplicate id, no ragged row,
    // nothing to count -- and a whole section pasted in twice.
    const doc = "# board\n\n## Phase 0\n\nprose\n\n## Phase 0\n\nprose\n";
    const errors = boardSectionErrors(doc);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("duplicate section heading");
    expect(errors[0]).toContain("## Phase 0");
    expect(errors[0]).toContain("first seen at line 3");
  });

  test("the same heading text at a different level is not a duplicate", () => {
    expect(boardSectionErrors("## Phase 0\n\n### Phase 0\n")).toEqual([]);
  });

  test("a `#` comment inside a fenced block is not a heading", () => {
    // The board really does embed an `sh` block; without fence handling every
    // shell comment in it would read as a section and could collide.
    const doc = "# board\n\n```sh\n# setup\n# setup\n```\n";
    expect(boardSectionErrors(doc)).toEqual([]);
  });

  test("distinct headings are accepted", () => {
    expect(boardSectionErrors("# board\n\n## Phase 0\n\n## Phase 1\n")).toEqual([]);
  });

  test("a duplicated section is reported through boardShapeErrors too", () => {
    // The fold-in is the thing that makes this run in the landing tier.
    const errors = boardShapeErrors("# board\n\n## Phase 0\n\n## Phase 0\n");
    expect(errors.some((e) => e.includes("duplicate section heading"))).toBe(true);
  });

  // --- review finding 2: an unbalanced fence must not switch the check off ---

  test("an unterminated fence is an error in its own right", () => {
    const errors = boardSectionErrors("# board\n\n```sh\necho hi\n");
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("unterminated");
    expect(errors[0]).toContain("line 3");
  });

  test("a duplicated section hidden behind an unterminated fence cannot pass silently", () => {
    // The pre-fix behaviour on this exact document was an EMPTY result: the fence was
    // never closed, so both `## Phase 0` headings were skipped as fenced content. The
    // duplicate is still invisible to the heading pass -- that is inherent to skipping
    // fences -- but the document is no longer green, which is the property that matters.
    const doc = "# board\n\n```sh\necho hi\n\n## Phase 0\n\n## Phase 0\n";
    const errors = boardSectionErrors(doc);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("unterminated"))).toBe(true);
  });

  test("the unterminated fence reaches the landing tier through boardShapeErrors", () => {
    const errors = boardShapeErrors("# board\n\n~~~\nstuff\n");
    expect(errors.some((e) => e.includes("unterminated"))).toBe(true);
  });

  test("a balanced fence is still not an error", () => {
    expect(boardSectionErrors("# board\n\n```sh\necho hi\n```\n\n## Phase 0\n")).toEqual([]);
  });

  // --- review finding 3: legitimately repeated subsections are not damage ---

  test("the same subsection heading under two different parents is accepted", () => {
    // Two phases each carrying `### Evidence` is ordinary markdown. Keying identity on
    // `(level, text)` over the whole document refused this, which would have turned the
    // landing tier red on a perfectly well-formed board.
    const doc = "# board\n\n## Phase 0\n\n### Evidence\n\n## Phase 1\n\n### Evidence\n";
    expect(boardSectionErrors(doc)).toEqual([]);
  });

  test("the same subsection heading twice under the SAME parent is still caught", () => {
    // The other half of finding 3: the fix must narrow the check, not delete it.
    const doc = "# board\n\n## Phase 0\n\n### Evidence\n\n### Evidence\n";
    const errors = boardSectionErrors(doc);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("### Evidence");
    expect(errors[0]).toContain("under `Phase 0`");
  });

  test("a top-level section pasted twice is still caught, and says so", () => {
    // Path-scoped identity must not weaken the e0cd52b shape itself.
    const errors = boardSectionErrors("# board\n\n## Phase 0\n\n## Phase 1\n\n## Phase 0\n");
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("under `board`");
  });

  test("a repeated parent carries its whole duplicated subtree, path and all", () => {
    // The paste shape at full size: the parent repeats AND its children repeat under it.
    // Path identity must flag both, or a pasted section with subsections would report
    // only its top line and read as a smaller problem than it is.
    const doc = "# board\n\n## Phase 0\n\n### Rows\n\n## Phase 0\n\n### Rows\n";
    const errors = boardSectionErrors(doc);
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain("## Phase 0");
    expect(errors[1]).toContain("### Rows");
  });
});

describe("the e0cd52b damage, replayed from the real documents", () => {
  // `tools/fixtures/workboard-e0cd52b-{before,after}.md` are `git show e0cd52b~1`
  // and `git show e0cd52b` of instance/workboard.md, committed verbatim so the
  // replay needs no reachable history and survives a shallow clone.
  const read = (name: string) => readFileSync(join(REPO, "tools/fixtures", name), "utf8");
  const before = read("workboard-e0cd52b-before.md");
  const after = read("workboard-e0cd52b-after.md");

  test("the pre-damage board carries NO section error", () => {
    // The discriminator. Both documents carry the same historic ragged-row noise,
    // so a section error present in one and absent in the other is caused by the
    // paste and by nothing else.
    expect(boardSectionErrors(before)).toEqual([]);
  });

  test("the damaged board names both pasted sections", () => {
    const errors = boardSectionErrors(after);
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain("Phase 0 — make the loop work at all");
    expect(errors[1]).toContain("Phase 1 — a clean server can be rebuilt from this repo");
  });

  test("the damaged board also duplicates row ids; the pre-damage board does not", () => {
    const dupIds = (text: string) => boardShapeErrors(text).filter((e) => e.includes("duplicate row id"));
    expect(dupIds(before)).toEqual([]);
    expect(dupIds(after).length).toBeGreaterThan(0);
  });
});

describe("instance/workboard.md", () => {
  test("every row renders every cell it carries", () => {
    const errors = boardShapeErrors(readFileSync(join(REPO, BOARD), "utf8"));
    expect(errors).toEqual([]);
  });
});
