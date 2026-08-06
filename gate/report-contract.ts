import { resolve } from "node:path";

// A `label: value` line is anchored and must occur exactly once. The
// dispatcher delegates the complete verdict below, so adding a guard rule
// cannot leave its synthetic-worker path behind.
export function lineValue(contents: string, label: string): string | undefined {
  const matches = contents.match(new RegExp(`^${label}:\\s*(.*)$`, "gm"));
  if (matches?.length !== 1) return undefined;
  return matches[0].slice(label.length + 1).trim();
}

/**
 * Every occurrence of a `label: value` FIELD, fenced code blocks excluded.
 *
 * The report contract (`lane-lifecycle`) says a field-looking line inside a
 * closed backtick or tilde fenced block is an EXAMPLE, not a field, and that an
 * unterminated fence makes the report malformed. `lineValue` above cannot know
 * that: it is a line regex over the whole file.
 *
 * THIS READER IS FOR `review:` AND FOR FIELDS THAT BEHAVE LIKE IT -- see
 * contractHeader() below for why a GRANTING field must not use it. `review:`
 * DEMANDS: its presence requires a sibling review artifact that must exist,
 * carry exactly one `verdict: ACCEPT` and name the report commit. So every
 * extra line this reader matches is one more thing the report has to PROVE, and
 * over-matching is fail-CLOSED. That is what makes the permissive surface the
 * contract states -- any indentation, any case, whitespace before the colon --
 * safe here and only here.
 *
 * The field name is matched case-insensitively and may carry leading whitespace
 * and whitespace before the colon, exactly as the contract states.
 */
export function fieldValues(contents: string, label: string): { values: string[]; unterminatedFence: boolean } {
  const field = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.*)$`, "i");
  const values: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of contents.split(/\r?\n/)) {
    if (fence) {
      const closing = line.match(/^\s{0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
      continue;
    }

    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})(?:[^\r\n]*)$/);
    if (opening) {
      fence = { marker: opening[1][0] as "`" | "~", length: opening[1].length };
      continue;
    }

    const match = line.match(field);
    if (match) values.push(match[1].trim());
  }

  return { values, unterminatedFence: fence !== undefined };
}

export type HeaderField = { label: string; value: string };

// A contract-header line: column 0, no whitespace before the colon, a space or
// end-of-line after it, and the label spelled exactly. Nothing about this regex
// is negotiable by indentation or by case -- that is the entire point.
const HEADER_FIELD = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t](.*))?$/;
// What may precede the block and still leave it "the top": a markdown title and
// blank lines. A report that opens with prose has no contract header at all.
const HEADER_PREAMBLE = /^(?:[ \t]*|#{1,6}(?:[ \t].*)?)$/;

/**
 * The report's CONTRACT HEADER: the contiguous run of `field: value` lines the
 * report opens with -- the block that already carries `commit:`, `verify:`,
 * `result:`, `secret-scan:` and `remaining:`. A markdown title and blank lines
 * may come first; the first line that is none of those three things ends the
 * search, and the first non-field line after the block closes it. Everything
 * past that is BODY, and the body is prose no matter what it looks like.
 *
 * This position exists for GRANTING fields, and the demanding/granting
 * distinction is the whole reason there are two readers:
 *
 *   `review:` DEMANDS (fieldValues above): over-matching adds an obligation.
 *   `bare-world:` GRANTS: its presence buys a clearance past a fail-closed
 *   gate, so every extra line matched is a grant nobody wrote, and over-
 *   matching is fail-OPEN.
 *
 * Two rounds of review found two different prose contexts that granted one: a
 * fenced example, and then -- after the fence was handled -- an indented one.
 * That is what any match surface wide enough to reach prose guarantees, because
 * markdown has more ways to spell an example than a parser has patches. So the
 * granting field is not read out of prose at all. It is read out of ONE
 * position, and a line anywhere else means what it says on the page: nothing.
 *
 * Fences need no handling here for the same reason: a fenced block lives in the
 * body, and the body is not read. (An unterminated fence still makes a report
 * malformed -- gate/completion-guard.ts rejects it before any of this runs.)
 */
export function contractHeader(contents: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(HEADER_FIELD);
    if (match) {
      fields.push({ label: match[1], value: (match[2] ?? "").trim() });
      continue;
    }
    if (fields.length > 0) break;
    if (HEADER_PREAMBLE.test(line)) continue;
    break;
  }
  return fields;
}

/** Every value `label` carries in the contract header, spelled exactly. */
export function headerValues(contents: string, label: string): string[] {
  return contractHeader(contents)
    .filter((field) => field.label === label)
    .map((field) => field.value);
}

export type CompletionReportVerdict = "clean" | "NO-GO" | "invalid";

/** Invoke the authoritative contract. Callers must not reproduce a subset. */
export function completionReportVerdict(options: {
  report: string;
  repo: string;
  branch: string;
}): CompletionReportVerdict {
  const args = [process.execPath, resolve(import.meta.dir, "completion-guard.ts"), "--report", options.report, "--repo", options.repo, "--branch", options.branch];
  const result = Bun.spawnSync(args, { stdout: "ignore", stderr: "ignore" });
  if (result.exitCode === 0) return "clean";
  if (result.exitCode === 3) return "NO-GO";
  return "invalid";
}
