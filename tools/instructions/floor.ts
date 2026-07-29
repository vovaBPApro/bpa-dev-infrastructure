#!/usr/bin/env bun
//
// Generates the Hard Floor section inside root CLAUDE.md from instruction docs
// carrying `floor: true` frontmatter (§2.1 of
// migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md). Each floor doc contributes
// exactly one `floor-line:` imperative. The section is delimited by HTML marker
// comments so the checker can diff the committed section against this generated
// output and FAIL on any hand-edit — the summary-vs-source drift vector dies.
//
// Idempotent: rendering twice yields byte-identical output. Deterministic: lines
// are ordered by source doc id, never by filesystem or authoring order.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { collectDocs, type InstructionDoc } from "./docs.ts";

export const FLOOR_BEGIN = "<!-- hard-floor:begin -->";
export const FLOOR_END = "<!-- hard-floor:end -->";
export const CLAUDE_FILENAME = "CLAUDE.md";

// A single floor imperative sourced from one doc.
export type FloorLine = { id: string; line: string };

// Collects floor imperatives from schema-valid docs carrying `floor: true`.
// A `floor: true` doc without a `floor-line:` is a hard error: the pairing is
// the whole contract (a floor rule with no imperative is a silent gap).
export function collectFloorLines(docs: InstructionDoc[]): FloorLine[] {
  const lines: FloorLine[] = [];
  for (const doc of docs) {
    if (!doc.valid) continue;
    if (doc.valid.floor !== true) continue;
    const line = doc.valid["floor-line"];
    if (typeof line !== "string" || line.trim() === "") {
      throw new FloorError(`doc '${doc.valid.id}' has floor: true but no floor-line`);
    }
    lines.push({ id: doc.valid.id, line: line.trim() });
  }
  lines.sort((a, b) => a.id.localeCompare(b.id));
  return lines;
}

export class FloorError extends Error {}

// Renders the Hard Floor section body (marker-to-marker inclusive). This is the
// canonical text the checker compares against and the writer injects.
export function renderFloor(docs: InstructionDoc[]): string {
  const lines = collectFloorLines(docs);
  if (lines.length > 10) {
    throw new FloorError(`hard floor has ${lines.length} lines, exceeds the ceiling of 10`);
  }
  const out: string[] = [FLOOR_BEGIN];
  out.push("## Hard Floor");
  out.push("");
  out.push(
    "Generated from `instructions/*` docs carrying `floor: true` (edit the source " +
      "doc's `floor-line:`, then regenerate — hand-edits here fail the checker).",
  );
  out.push("");
  let n = 1;
  for (const entry of lines) {
    out.push(`${n}. ${entry.line} (\`${entry.id}\`)`);
    n += 1;
  }
  out.push(FLOOR_END);
  return out.join("\n");
}

// Replaces the region between (and including) the markers in `claudeText` with
// the freshly rendered section. Throws when a marker is missing or duplicated —
// silently appending would let a hand-deleted marker escape the drift check.
export function replaceFloorSection(claudeText: string, rendered: string): string {
  const beginCount = occurrences(claudeText, FLOOR_BEGIN);
  const endCount = occurrences(claudeText, FLOOR_END);
  if (beginCount === 0 || endCount === 0) {
    throw new FloorError(
      `CLAUDE.md is missing a hard-floor marker (begin=${beginCount}, end=${endCount}); ` +
        "add both marker comments to make the section generator-owned",
    );
  }
  if (beginCount > 1 || endCount > 1) {
    throw new FloorError(`CLAUDE.md has duplicated hard-floor markers (begin=${beginCount}, end=${endCount})`);
  }
  const beginIndex = claudeText.indexOf(FLOOR_BEGIN);
  const endIndex = claudeText.indexOf(FLOOR_END);
  if (endIndex < beginIndex) {
    throw new FloorError("CLAUDE.md hard-floor markers are out of order (end precedes begin)");
  }
  const before = claudeText.slice(0, beginIndex);
  const after = claudeText.slice(endIndex + FLOOR_END.length);
  return before + rendered + after;
}

// Extracts the current marker-to-marker section for the checker's drift diff.
// Returns undefined when a marker is missing (the checker reports that itself).
export function extractFloorSection(claudeText: string): string | undefined {
  const beginIndex = claudeText.indexOf(FLOOR_BEGIN);
  const endIndex = claudeText.indexOf(FLOOR_END);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) return undefined;
  return claudeText.slice(beginIndex, endIndex + FLOOR_END.length);
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

type Options = { repo: string; write: boolean };

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun tools/instructions/floor.ts [--repo <path>] [--check]",
      "",
      "  --repo <path>   Repository root (default: current directory)",
      "  --check         Print the generated section to stdout without writing CLAUDE.md",
      "  -h, --help      Show this usage",
      "",
      "Exit codes: 0 success, 2 usage/marker/floor error.",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function parseArgs(args: string[]): Options {
  const options: Options = { repo: process.cwd(), write: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--check") {
      options.write = false;
      continue;
    }
    if (arg === "--repo") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) usage(2);
      options.repo = value;
      index += 1;
      continue;
    }
    usage(2);
  }
  return options;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const instructionsRoot = resolve(options.repo, "instructions");
  const docs = collectDocs(instructionsRoot);
  try {
    const rendered = renderFloor(docs);
    if (!options.write) {
      process.stdout.write(rendered + "\n");
    } else {
      const claudePath = join(options.repo, CLAUDE_FILENAME);
      const current = readFileSync(claudePath, "utf8");
      const next = replaceFloorSection(current, rendered);
      writeFileSync(claudePath, next);
      const lines = collectFloorLines(docs);
      console.log(`wrote Hard Floor into ${CLAUDE_FILENAME} (${lines.length} lines)`);
    }
  } catch (error) {
    if (error instanceof FloorError) {
      process.stderr.write(`floor: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  }
}
