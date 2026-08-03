import { resolve } from "node:path";

// A `label: value` line is anchored and must occur exactly once. The
// dispatcher delegates the complete verdict below, so adding a guard rule
// cannot leave its synthetic-worker path behind.
export function lineValue(contents: string, label: string): string | undefined {
  const matches = contents.match(new RegExp(`^${label}:\\s*(.*)$`, "gm"));
  if (matches?.length !== 1) return undefined;
  return matches[0].slice(label.length + 1).trim();
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
