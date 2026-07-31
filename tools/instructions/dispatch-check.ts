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

import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { PACK_MARKER_PREFIX, readPacks } from "./compose.ts";
import { collectRepoDocs } from "./docs.ts";
import { AUDIENCES } from "./schema.ts";

// The ops journal is a runtime artifact: gitignored, host-only. Overridable via
// ORCH_OPS_JOURNAL (tests point it at a temp dir; the daemon/orchestrator may
// relocate its state dir). Default lives under orchestrator/runtime/, which the
// repo .gitignore excludes.
export const DEFAULT_OPS_JOURNAL_RELATIVE = join("orchestrator", "runtime", "ops-journal.log");

const COMPOSE_ROLES = AUDIENCES.filter((audience) => audience !== "all");
const COMPOSE_MARKER = new RegExp(
  `^${escapeRegExp(PACK_MARKER_PREFIX)} role=(${COMPOSE_ROLES.join("|")}) l1=([0-9a-fA-F]{8,40}) -->$`,
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveOpsJournalPath(
  repoRoot: string,
  override: string | undefined = process.env.ORCH_OPS_JOURNAL,
): string {
  if (override && override.trim() !== "") {
    return isAbsolute(override) ? override : join(repoRoot, override);
  }
  return join(repoRoot, DEFAULT_OPS_JOURNAL_RELATIVE);
}

// True when `contents` begins — after any leading blank lines — with a complete,
// valid compose marker. Anchoring at the first non-blank line prevents a quoted
// marker deeper in the body from spoofing the check.
export function hasComposeMarker(contents: string): boolean {
  const normalized = contents.replace(/^﻿/, "");
  for (const rawLine of normalized.split(/\r?\n/)) {
    if (rawLine.trim() === "") continue;
    return COMPOSE_MARKER.test(rawLine.trimStart());
  }
  return false; // empty / whitespace-only file has no marker
}

type PackValidation = { valid: true } | { valid: false; reason: string };

function shortHash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex").slice(0, 12);
}

function repositorySha(repo: string): string {
  return execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// Validates the complete compiler output, not merely its public marker. Because
// the marker is pinned to the current repository SHA, the repository's docs are
// the unambiguous source bytes for checking each embedded materialized body.
export function validateComposePack(contents: string, repo: string): PackValidation {
  const normalized = contents.replace(/^﻿/, "");
  const firstLine = normalized.split(/\r?\n/).find((line) => line.trim() !== "");
  const marker = firstLine?.trimStart().match(COMPOSE_MARKER);
  if (!marker) return { valid: false, reason: "missing or invalid compose.ts pack marker" };

  const [, role, stampedL1] = marker;
  let currentL1: string;
  try {
    currentL1 = repositorySha(repo);
  } catch {
    return { valid: false, reason: "cannot resolve repository L1 SHA" };
  }
  if (stampedL1.toLowerCase() !== currentL1.toLowerCase()) {
    return { valid: false, reason: `L1 SHA mismatch (pack ${stampedL1}, repository ${currentL1})` };
  }

  const manifestStart = normalized.indexOf("## MANIFEST\n");
  const factsStart = normalized.indexOf("\n## INSTANCE FACTS", manifestStart);
  const documentsStart = normalized.indexOf("\n## DOCUMENTS\n", factsStart);
  if (manifestStart < 0 || factsStart < 0 || documentsStart < 0) {
    return { valid: false, reason: "missing MANIFEST, INSTANCE FACTS, or DOCUMENTS section" };
  }

  const manifestText = normalized.slice(manifestStart, factsStart);
  const manifestRows = [...manifestText.matchAll(
    /^- ([a-z0-9][a-z0-9-]*)  sha256:([0-9a-f]{12})  \((baseline|tag|interim)\)  .+$/gm,
  )];
  if (manifestRows.length === 0) return { valid: false, reason: "MANIFEST declares no documents" };

  let baseline: string[];
  try {
    baseline = readPacks(repo).get(role) ?? [];
  } catch (error) {
    return { valid: false, reason: `cannot load role baseline: ${(error as Error).message}` };
  }
  if (baseline.length === 0) return { valid: false, reason: `role '${role}' has no baseline` };

  const declared = new Map<string, { hash: string; reason: string }>();
  for (const row of manifestRows) {
    const [, id, hash, reason] = row;
    if (declared.has(id)) return { valid: false, reason: `duplicate MANIFEST id '${id}'` };
    declared.set(id, { hash, reason });
  }
  for (const id of baseline) {
    if (declared.get(id)?.reason !== "baseline") {
      return { valid: false, reason: `missing baseline id '${id}' from MANIFEST` };
    }
  }

  const docs = new Map(
    collectRepoDocs(repo)
      .filter((doc) => doc.valid)
      .map((doc) => [doc.valid!.id, doc]),
  );
  const documentText = normalized.slice(documentsStart + 1);
  for (const [id, entry] of declared) {
    if (entry.reason === "interim") continue;
    const doc = docs.get(id);
    if (!doc) return { valid: false, reason: `declared doc '${id}' does not exist at stamped L1` };
    const actualHash = shortHash(doc.contents);
    if (entry.hash !== actualHash) {
      return { valid: false, reason: `hash mismatch for manifest doc '${id}'` };
    }
    const header = `<!-- doc id=${id} sha256:${entry.hash} source=${doc.relative} -->\n`;
    const headerAt = documentText.indexOf(header);
    if (headerAt < 0) return { valid: false, reason: `missing materialized doc '${id}'` };
    if (documentText.indexOf(header, headerAt + header.length) >= 0) {
      return { valid: false, reason: `duplicate materialized doc '${id}'` };
    }
    const materialized = doc.contents.replace(/\s+$/, "");
    if (!documentText.startsWith(materialized, headerAt + header.length)) {
      return { valid: false, reason: `hash mismatch for materialized doc '${id}'` };
    }
  }

  return { valid: true };
}

function isPathWithin(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot !== "" && !pathFromRoot.startsWith(".." + "/") && pathFromRoot !== ".." && !isAbsolute(pathFromRoot);
}

function requireDurableJournalPath(repoRoot: string, path: string): void {
  const journalRoot = resolve(repoRoot, dirname(DEFAULT_OPS_JOURNAL_RELATIVE));
  if (!isPathWithin(resolve(path), journalRoot)) {
    throw new Error(`ops journal must be a regular writable file under ${journalRoot}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  const canonicalRoot = realpathSync(journalRoot);
  const canonicalParent = realpathSync(dirname(path));
  if (!isPathWithin(canonicalParent, canonicalRoot) && canonicalParent !== canonicalRoot) {
    throw new Error(`ops journal parent escapes ${journalRoot}`);
  }

  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error("ops journal must be a regular file (symlinks and special files are refused)");
  }
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
  requireDurableJournalPath(repoRoot, path);
  const ts = entry.ts ?? new Date().toISOString();
  // Single line; the reason is JSON-escaped so a newline in it cannot forge a
  // second journal row.
  const line =
    `${ts}\tDISPATCH_OVERRIDE\tprompt=${entry.promptPath}\treason=${JSON.stringify(entry.reason)}\n`;
  const sizeBefore = existsSync(path) ? statSync(path).size : 0;
  appendFileSync(path, line);
  const after = statSync(path);
  accessSync(path, constants.W_OK);
  if (!after.isFile() || after.size < sizeBefore + Buffer.byteLength(line) || !readFileSync(path, "utf8").includes(line)) {
    throw new Error("ops journal append could not be durably verified");
  }
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

  const validation = validateComposePack(contents, repo);
  if (validation.valid) {
    process.stdout.write(`dispatch-check: OK (full pack valid) ${options.promptPath}\n`);
    process.exit(0);
  }

  const override = process.env.DISPATCH_OVERRIDE;
  if (override !== undefined) {
    if (override.trim() === "") {
      fail("DISPATCH_OVERRIDE is set but empty — a break-glass override MUST carry a reason");
    }
    let journal: string;
    try {
      journal = appendOverrideJournal(repo, {
        promptPath: options.promptPath,
        reason: override,
      });
    } catch (error) {
      fail(`DISPATCH_OVERRIDE refused: ${(error as Error).message}`);
    }
    process.stderr.write(
      `dispatch-check: OVERRIDE accepted (reason logged to ${journal}); ` +
        `prompt failed full-pack validation (${validation.reason}): ${options.promptPath}\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `dispatch-check: REFUSED — ${validation.reason}: ${options.promptPath}\n` +
      `dispatch-check: render lane prompts via 'bun tools/instructions/compose.ts', or set ` +
      `DISPATCH_OVERRIDE=<reason> to break glass for a tooling-repair lane.\n`,
  );
  process.exit(3);
}
