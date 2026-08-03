// Shared, authoritative field-parsing for lane terminal reports.
//
// instance/workboard.md "Two live report contracts" documents that
// gate/completion-guard.ts (the CLAUDE.md commit:/verify:/result:/
// secret-scan:/remaining: contract) and orchestrator/dispatcher.ts's
// validTerminal() (the fenced-dispatch lane:/attempt:/commit:/result:
// contract) are two SEPARATE report shapes that were deliberately not
// reconciled in V3-0.2 -- reconciling the shapes needs a branch field on
// LaneRecord, which is bigger than that row.
//
// What CAN be shared, and must not silently diverge, is how a single
// `label: value` line is read out of report text: anchored to the start of
// a line, and rejected (undefined, not a guess) unless the label occurs
// exactly once. Before this module existed, dispatcher.ts used a plain
// `report.includes("commit: <sha>")` substring test, which a report can
// satisfy by mentioning the right text anywhere -- inside a `blocker:`
// sentence, a duplicate/conflicting line, anywhere -- without that text
// being the actual, single, well-formed field line. Both parsers now import
// this one function, so a report either contract accepts is read the same,
// stricter way by both.
export function lineValue(contents: string, label: string): string | undefined {
  const matches = contents.match(new RegExp(`^${label}:\\s*(.*)$`, "gm"));
  if (matches?.length !== 1) return undefined;
  return matches[0].slice(label.length + 1).trim();
}
