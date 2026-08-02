#!/usr/bin/env bun
//
// Generates instructions/README.md from doc frontmatter (§2.1: the index is
// GENERATED, one line per doc, sorted by id). Idempotent: running twice yields
// byte-identical output. Docs without valid frontmatter are still listed (using
// their filename and any summary the raw block yields) so the index never hides
// a file — but the checker is what fails such docs.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { collectDocs, INDEX_FILENAME, INDEX_MARKER, type InstructionDoc } from "./docs.ts";
import { renderFloor, replaceFloorSection, CLAUDE_FILENAME, FloorError } from "./floor.ts";

type Options = { repo: string; write: boolean };

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun tools/instructions/index.ts [--repo <path>] [--check]",
      "",
      "  --repo <path>   Repository root (default: current directory)",
      "  --check         Print the index to stdout without writing the file",
      "  -h, --help      Show this usage",
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

// Sort key: docs with a valid id sort by id; the rest fall back to their
// relative path, and are grouped after id-bearing docs for a stable order.
function sortKey(doc: InstructionDoc): string {
  const id = doc.valid?.id ?? (typeof doc.frontmatter?.id === "string" ? doc.frontmatter.id : undefined);
  return id ? `0:${id}` : `1:${doc.relative}`;
}

function summaryOf(doc: InstructionDoc): string {
  const summary = doc.valid?.summary ?? doc.frontmatter?.summary;
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  return "(no summary)";
}

export function renderIndex(docs: InstructionDoc[]): string {
  const ordered = [...docs].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const lines = ordered.map((doc) => `- [${doc.relative}](${doc.relative}) — ${summaryOf(doc)}`);
  return [INDEX_MARKER, "# Instructions", "", ...lines, ""].join("\n");
}

// Only run the CLI when executed directly, not when imported (check.ts reuses
// renderIndex for its freshness comparison and must not trigger a file write).
if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const instructionsRoot = resolve(options.repo, "instructions");
  const docs = collectDocs(instructionsRoot);
  const rendered = renderIndex(docs);

  if (options.write) {
    writeFileSync(join(instructionsRoot, INDEX_FILENAME), rendered);
    console.log(`wrote ${INDEX_FILENAME} (${docs.length} docs)`);
    // Regenerate the CLAUDE.md Hard Floor from the same doc set so a single
    // `index.ts` run keeps both generated surfaces fresh. Skipped silently when
    // the repo has no CLAUDE.md (e.g. an instructions-only fixture).
    const claudePath = join(options.repo, CLAUDE_FILENAME);
    try {
      const current = readFileSync(claudePath, "utf8");
      const next = replaceFloorSection(current, renderFloor(docs));
      if (next !== current) {
        writeFileSync(claudePath, next);
        console.log(`updated Hard Floor in ${CLAUDE_FILENAME}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // No CLAUDE.md — nothing to regenerate.
      } else if (error instanceof FloorError) {
        process.stderr.write(`index: hard floor not updated: ${error.message}\n`);
        process.exitCode = 2;
      } else {
        throw error;
      }
    }
  } else {
    process.stdout.write(rendered);
  }
}
