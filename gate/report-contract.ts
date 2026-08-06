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
 * that: it is a line regex over the whole file. For a field a reader merely
 * requires, the difference costs a report a rewrite. For a field that GRANTS
 * something -- `review:`, `bare-world:` -- it is fail-open: a report documenting
 * the syntax in a fenced block silently claims the thing it was describing.
 * Measured, on this row's own report: a fenced `bare-world: capability=...`
 * example was read as a live capability declaration.
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
