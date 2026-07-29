#!/usr/bin/env bun
//
// Memory / harness-surface sweep (INSTRUCTIONS_CONSILIUM_FINAL.md §2.5, F14).
// Two always-loaded second-home surfaces have already forked from the
// instruction corpus and must be governed:
//
//   (a) ~/.claude/rules/*.mdc — an always-loaded rules surface. Per §2.5 it
//       becomes POINTERS-ONLY: a rules file may point at an instruction id but
//       must not itself carry binding rule text. A file is flagged when its
//       body (outside frontmatter and outside quote/code blocks) contains
//       binding verbs (MUST / NEVER / ALWAYS and the Ukrainian
//       обов'язково / ніколи / завжди), or when the body is longer than the
//       pointer-size budget (~30 lines).
//
//   (b) the orchestrator memory dir (*.md) — a cache, not a home. Per §2.5 any
//       entry that STATES a rule (binding verbs in its body) without a `home:`
//       field naming the instruction id it caches is a violation: an ungoverned
//       rule with no one-home anchor.
//
// The sweep is strictly NON-DESTRUCTIVE: it only reports and FILES defects. It
// never edits, rewrites, or deletes a rules file or a memory entry. Each
// violation is appended as one row to instance/decisions/inbox.jsonl with
// kind "memory-sweep-defect", reusing daemon/inbox-mirror.ts's serialization so
// the escaping is identical to the daemon's own capture rows. Filing into the
// inbox gives every defect an owner and a trigger (triage → HR), instead of a
// "weekly intention".
//
// Testability: --rules-root, --memory-root, and --repo all override the real
// paths so tests NEVER touch the real ~/.claude. With no overrides the tool
// targets the live surfaces.
//
// Usage: bun tools/instructions/memory-sweep.ts [--repo <path>]
//        [--rules-root <dir>] [--memory-root <dir>] [--dry-run]

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendInboxLine, serializeInboxLine } from "../../daemon/inbox-mirror.ts";

// English + Ukrainian binding verbs. Word-boundary for the ASCII set; the
// Cyrillic terms are matched as whole tokens (Unicode word boundaries are
// unreliable across engines, so we bound them with non-letter / string edges).
const BINDING_VERB_PATTERNS: RegExp[] = [
  /\bMUST\b/,
  /\bNEVER\b/,
  /\bALWAYS\b/,
  /(^|[^\p{L}])(обов'язково|ніколи|завжди)([^\p{L}]|$)/u,
];

// Pointer-size budget for a rules file body (§2.5 "pointers-only"). A pointer
// file naming a handful of ids stays well under this; a file past it is
// carrying content, not pointing.
export const RULES_BODY_LINE_BUDGET = 30;

export type Defect = {
  kind: "memory-sweep-defect";
  surface: "rules" | "memory";
  file: string; // path as scanned (may be absolute)
  reason: string;
};

// Strips a leading `--- ... ---` frontmatter block. Returns the body only, so
// frontmatter `description:` fields do not trip the binding-verb detector.
export function stripFrontmatter(contents: string): string {
  const normalized = contents.replace(/^﻿/, "");
  const match = normalized.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? normalized.slice(match[0].length) : normalized;
}

// Removes fenced code blocks (``` ... ```) and blockquote lines (`> ...`) so a
// binding verb QUOTED as evidence — e.g. a verbatim Human line — does not count
// as the file itself stating a rule. This is the "quote-block exemption" the
// consilium calls for (§2.2). Returns the remaining, non-exempt text.
export function stripQuotesAndCode(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*>/.test(line)) continue; // blockquote line — exempt
    out.push(line);
  }
  return out.join("\n");
}

// True when the given text (already frontmatter/quote-stripped) contains a
// binding verb.
export function hasBindingVerb(text: string): boolean {
  return BINDING_VERB_PATTERNS.some((re) => re.test(text));
}

// Reads *.md / *.mdc files directly under a dir (non-recursive — both surfaces
// are flat). Missing dir yields an empty list.
function listFiles(dir: string, extensions: string[]): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  const out: { name: string; path: string }[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    if (!extensions.some((ext) => name.endsWith(ext))) continue;
    out.push({ name, path });
  }
  return out;
}

// (a) rules surface: pointers-only. Body may name ids but must not carry binding
// verbs (outside quotes) and must be within the pointer-size budget.
export function scanRulesDir(rulesRoot: string): Defect[] {
  const defects: Defect[] = [];
  for (const { name, path } of listFiles(rulesRoot, [".mdc"])) {
    const body = stripFrontmatter(readFileSync(path, "utf8"));
    const nonBlankLines = body.split(/\r?\n/).filter((l) => l.trim() !== "").length;
    const exempt = stripQuotesAndCode(body);
    if (hasBindingVerb(exempt)) {
      defects.push({
        kind: "memory-sweep-defect",
        surface: "rules",
        file: path,
        reason: `rules file '${name}' carries binding verbs in its body (MUST/NEVER/ALWAYS/обов'язково/ніколи/завжди) — rules surface must be pointers-only`,
      });
    }
    if (nonBlankLines > RULES_BODY_LINE_BUDGET) {
      defects.push({
        kind: "memory-sweep-defect",
        surface: "rules",
        file: path,
        reason: `rules file '${name}' body is ${nonBlankLines} non-blank lines, over the ${RULES_BODY_LINE_BUDGET}-line pointer budget — demote content to an instruction id`,
      });
    }
  }
  return defects;
}

// Reads a `home:` field from a memory file's frontmatter (or its body, tolerant
// of either placement). Returns the value or undefined.
export function readHomeField(contents: string): string | undefined {
  const fm = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const scope = fm ? fm[1] : contents;
  for (const line of scope.split(/\r?\n/)) {
    const m = line.match(/^\s*home\s*:\s*(.+)$/);
    if (m) {
      const value = m[1].trim().replace(/^["']|["']$/g, "");
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

// (b) memory surface: any rule-stating entry (binding verbs in its body,
// excluding quotes) without a `home:` id is a violation. MEMORY.md (the index)
// is skipped — it is a pointer index, not a rule store.
export function scanMemoryDir(memoryRoot: string): Defect[] {
  const defects: Defect[] = [];
  for (const { name, path } of listFiles(memoryRoot, [".md"])) {
    if (name === "MEMORY.md") continue;
    const contents = readFileSync(path, "utf8");
    const body = stripFrontmatter(contents);
    const exempt = stripQuotesAndCode(body);
    if (!hasBindingVerb(exempt)) continue; // not a rule-stating entry
    if (readHomeField(contents) === undefined) {
      defects.push({
        kind: "memory-sweep-defect",
        surface: "memory",
        file: path,
        reason: `memory '${name}' states a rule (binding verbs) but has no home: field naming its instruction id — memory is a cache, every rule needs a one-home anchor`,
      });
    }
  }
  return defects;
}

export type SweepResult = { defects: Defect[]; filed: number; inboxPath?: string };

// Runs both scans and (unless dryRun) files each defect into the repo's inbox as
// one JSONL row. Returns the defects and the count filed. The inbox row is
// {msg_id, chat_id, ts, text} where text carries the kind + surface + reason;
// we reuse the daemon serializer so escaping is identical. msg_id is a synthetic
// "memsweep-<n>" so it never collides with a numeric Telegram msg-id.
export function runMemorySweep(opts: {
  repo: string;
  rulesRoot: string;
  memoryRoot: string;
  dryRun: boolean;
  nowIso?: string;
}): SweepResult {
  const defects = [...scanRulesDir(opts.rulesRoot), ...scanMemoryDir(opts.memoryRoot)];
  if (opts.dryRun || defects.length === 0) {
    return { defects, filed: 0 };
  }
  const ts = opts.nowIso ?? new Date().toISOString();
  let inboxPath: string | undefined;
  defects.forEach((defect, index) => {
    inboxPath = appendInboxLine(opts.repo, {
      msg_id: `memsweep-${ts}-${index}`,
      chat_id: "memory-sweep",
      ts,
      text: JSON.stringify({
        kind: defect.kind,
        surface: defect.surface,
        file: defect.file,
        reason: defect.reason,
      }),
    });
  });
  return { defects, filed: defects.length, inboxPath };
}

type Options = {
  repo: string;
  rulesRoot: string;
  memoryRoot: string;
  dryRun: boolean;
};

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun tools/instructions/memory-sweep.ts [options]",
      "",
      "Scans the always-loaded rules surface and the orchestrator memory cache",
      "for ungoverned binding rules; FILES each violation into the inbox as a",
      "memory-sweep-defect row. Non-destructive: never edits rules or memory.",
      "",
      "  --repo <path>          Repo root whose instance/decisions/inbox.jsonl",
      "                         receives filed defects (default: current dir).",
      "  --rules-root <dir>     Rules surface to scan (default: ~/.claude/rules).",
      "  --memory-root <dir>    Memory dir to scan (default: the orchestrator's",
      "                         ~/.claude/projects/*/memory — see below).",
      "  --dry-run              Report only; file nothing.",
      "  -h, --help             Show this usage.",
      "",
      "Exit codes: 0 no defects, 1 defects found (filed unless --dry-run),",
      "2 usage error.",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function fail(message: string): never {
  process.stderr.write(`memory-sweep: ${message}\n`);
  process.exit(2);
}

// Default live memory dir for this deployment. Kept as a function so tests never
// resolve it (they pass --memory-root). Matches the orchestrator's project
// memory path under the home dir.
function defaultMemoryRoot(): string {
  return join(homedir(), ".claude", "projects", "-home-bpa-shell", "memory");
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    repo: process.cwd(),
    rulesRoot: join(homedir(), ".claude", "rules"),
    memoryRoot: defaultMemoryRoot(),
    dryRun: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--repo" || arg === "--rules-root" || arg === "--memory-root") {
      const value = args[++index];
      if (!value || value.startsWith("--")) usage(2);
      if (arg === "--repo") options.repo = value;
      else if (arg === "--rules-root") options.rulesRoot = value;
      else options.memoryRoot = value;
      continue;
    }
    usage(2);
  }
  return options;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const result = runMemorySweep({
    repo: resolve(options.repo),
    rulesRoot: options.rulesRoot,
    memoryRoot: options.memoryRoot,
    dryRun: options.dryRun,
  });
  for (const defect of result.defects) {
    process.stdout.write(`DEFECT [${defect.surface}] ${defect.file}\n  ${defect.reason}\n`);
  }
  if (result.defects.length === 0) {
    process.stdout.write("memory-sweep: clean (no ungoverned rules found)\n");
  } else if (options.dryRun) {
    process.stdout.write(`memory-sweep: ${result.defects.length} defect(s), not filed (--dry-run)\n`);
  } else {
    process.stdout.write(
      `memory-sweep: ${result.filed} defect(s) filed to ${result.inboxPath}\n`,
    );
  }
  process.exit(result.defects.length === 0 ? 0 : 1);
}

// Re-exported so a caller/test can assert the exact serialization the sweep uses
// when filing (it is the daemon's own row serializer).
export { serializeInboxLine };
