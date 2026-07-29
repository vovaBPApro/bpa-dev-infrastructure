#!/usr/bin/env bun
//
// Dispatcher compose-marker check (INSTRUCTIONS_CONSILIUM_FINAL.md §2.3: "the
// dispatcher refuses any lane prompt without the compose marker"). This is the
// consumption-side gate for compiled delivery: a lane prompt that was NOT
// produced by tools/instructions/compose.ts carries no marker header, so it was
// hand-assembled — exactly the mechanism that already failed (B276-class loss).
// Such a prompt is refused before the lane launches.
//
// Contract (fail-closed):
//   - A prompt file whose contents begin (ignoring leading blank lines) with the
//     compose marker line `<!-- compose.ts pack v1 role=<role> l1=<sha> -->` is
//     OK (exit 0).
//   - A prompt file lacking the marker is REFUSED: exit 3, diagnostic on stderr.
//   - A missing/unreadable prompt file is a usage error: exit 2.
//   - Break-glass: DISPATCH_OVERRIDE=<reason> forces OK even without a marker
//     (exit 0), for lanes that repair the compose/check tooling itself — the
//     "fail-closed never becomes cannot-dispatch-the-fix" lesson. EVERY override
//     is appended to the ops journal (a gitignored runtime path) with a
//     timestamp, the prompt path, and the reason. An override with an empty
//     reason is rejected (exit 2) so the break-glass always carries a why.
//
// The marker is matched anchored at the first non-blank line, not by substring
// search, so a marker quoted deeper inside the body (e.g. inside a doc snippet
// the pack itself carries) cannot spoof a hand-written prompt into passing.
//
// Usage: bun tools/instructions/dispatch-check.ts <prompt-file> [--repo <path>]
// See --help for the full flag semantics.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PACK_MARKER_PREFIX } from "./compose.ts";

// The ops journal is a runtime artifact: gitignored, host-only. Overridable via
// ORCH_OPS_JOURNAL (tests point it at a temp dir; the daemon/orchestrator may
// relocate its state dir). Default lives under orchestrator/runtime/, which the
// repo .gitignore excludes.
export const DEFAULT_OPS_JOURNAL_RELATIVE = join("orchestrator", "runtime", "ops-journal.log");

export function resolveOpsJournalPath(
  repoRoot: string,
  override: string | undefined = process.env.ORCH_OPS_JOURNAL,
): string {
  if (override && override.trim() !== "") {
    return isAbsolute(override) ? override : join(repoRoot, override);
  }
  return join(repoRoot, DEFAULT_OPS_JOURNAL_RELATIVE);
}

// True when `contents` begins — after any leading blank lines — with the compose
// marker. Anchored at the first non-blank line so a marker appearing deeper in
// the body cannot spoof the check.
export function hasComposeMarker(contents: string): boolean {
  const normalized = contents.replace(/^﻿/, "");
  for (const rawLine of normalized.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    return rawLine.trimStart().startsWith(PACK_MARKER_PREFIX);
  }
  return false; // empty / whitespace-only file has no marker
}

// Appends one override record to the ops journal, creating the file and its
// parent dir if missing. Append-only; never rewrites existing content. Returns
// the path written.
export function appendOverrideJournal(
  repoRoot: string,
  entry: { promptPath: string; reason: string; ts?: string },
  override?: string,
): string {
  const path = resolveOpsJournalPath(repoRoot, override);
  mkdirSync(dirname(path), { recursive: true });
  const ts = entry.ts ?? new Date().toISOString();
  // Single line; the reason is JSON-escaped so a newline in it cannot forge a
  // second journal row.
  const line =
    `${ts}\tDISPATCH_OVERRIDE\tprompt=${entry.promptPath}\treason=${JSON.stringify(entry.reason)}\n`;
  appendFileSync(path, line);
  return path;
}

type Options = { promptPath: string; repo: string };

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun tools/instructions/dispatch-check.ts <prompt-file> [--repo <path>]",
      "",
      "Refuses to dispatch a lane prompt that lacks the compose.ts pack marker.",
      "",
      "  <prompt-file>   Path to the rendered lane prompt to validate (required).",
      "  --repo <path>   Repository root, for the ops-journal path (default: cwd).",
      "  -h, --help      Show this usage.",
      "",
      "Break-glass: set DISPATCH_OVERRIDE=<reason> to force OK on a marker-less",
      "prompt (only for lanes repairing the compose/check tooling). Every override",
      "is logged to the ops journal (orchestrator/runtime/ops-journal.log).",
      "",
      "Exit codes: 0 OK (marker present or override), 2 usage/IO error,",
      "3 refusal (marker missing, no override).",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function fail(message: string): never {
  process.stderr.write(`dispatch-check: ${message}\n`);
  process.exit(2);
}

function parseArgs(args: string[]): Options {
  let promptPath: string | undefined;
  let repo = process.cwd();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--repo") {
      const value = args[++index];
      if (!value || value.startsWith("--")) usage(2);
      repo = value;
      continue;
    }
    if (arg.startsWith("--")) usage(2);
    if (promptPath !== undefined) fail("only one prompt file may be given");
    promptPath = arg;
  }
  if (promptPath === undefined) fail("a prompt file argument is required");
  return { promptPath, repo };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const repo = resolve(options.repo);

  if (!existsSync(options.promptPath)) {
    fail(`prompt file not found: ${options.promptPath}`);
  }
  let contents: string;
  try {
    contents = readFileSync(options.promptPath, "utf8");
  } catch (error) {
    fail(`cannot read prompt file '${options.promptPath}': ${(error as Error).message}`);
  }

  if (hasComposeMarker(contents)) {
    process.stdout.write(`dispatch-check: OK (compose marker present) ${options.promptPath}\n`);
    process.exit(0);
  }

  const override = process.env.DISPATCH_OVERRIDE;
  if (override !== undefined) {
    if (override.trim() === "") {
      fail("DISPATCH_OVERRIDE is set but empty — a break-glass override MUST carry a reason");
    }
    const journal = appendOverrideJournal(repo, {
      promptPath: options.promptPath,
      reason: override,
    });
    process.stderr.write(
      `dispatch-check: OVERRIDE accepted (reason logged to ${journal}); ` +
        `prompt lacks a compose marker: ${options.promptPath}\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `dispatch-check: REFUSED — prompt lacks the compose.ts pack marker: ${options.promptPath}\n` +
      `dispatch-check: render lane prompts via 'bun tools/instructions/compose.ts', or set ` +
      `DISPATCH_OVERRIDE=<reason> to break glass for a tooling-repair lane.\n`,
  );
  process.exit(3);
}
