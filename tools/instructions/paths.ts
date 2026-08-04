// Referenced-path existence check (workboard V3-2.13).
//
// A binding document that names a repository path is stating a fact to every
// agent that receives it. `check.ts` already verified two *command* forms
// (`bun tools/...`, `bash gate/...`), but a bare path in backticks -- which is
// how documents actually cite files -- was invisible to it. So four binding
// docs could name `gate/land-batch.sh`, which does not exist, and the checker
// still reported green (instance/audits/false-facts-2026-08-04.md, F5).
//
// Two properties matter more than reach here:
//
//   1. Absence FAILS, it never skips. A rule that cannot be evaluated is the
//      defect this whole row exists to remove (`active_scope` had no predicate,
//      so it never had anything to fail).
//   2. The false-positive surface -- illustrative, external, planned and
//      generated paths -- is handled by a NAMED exemption carrying a reason,
//      not by narrowing the match until the noise disappears. Narrowing is
//      exactly how the original defect survived.
//
// An exemption is a debt, not a dismissal: it reports as a WARN so it stays
// visible, an unconsulted row FAILS, and a row naming a path that now exists
// FAILS so the exemption cannot outlive the reason it was granted for.

import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { InstructionDoc } from "./docs.ts";
import { CLAUDE_FILENAME } from "./floor.ts";

export type PathLevel = "PASS" | "WARN" | "FAIL" | "SKIP";
export type PathFinding = { level: PathLevel; file: string; check: string; detail: string };

// Repo-relative location of the exemption ledger. Same idiom (and same
// fail-closed posture) as instance/unit-path-exemptions.tsv.
export const PATH_EXEMPTIONS_FILE = join("instance", "doc-path-exemptions.tsv");

// Instance parameters are scanned too: session-load.ts pushes this file into
// the orchestrator's standing context verbatim, comments included, so a path it
// names is asserted to an agent exactly like a binding doc's is. Its tokens are
// not backticked, so the same predicate runs over bare whitespace tokens.
export const PARAMS_FILE = join("instance", "params.yaml");

// Closed vocabulary. An unknown reason is a hard FAIL rather than a free-text
// column nobody can check: the reason decides whether the row is a debt with a
// fix row behind it or a permanent property of the citation.
//
//   illustrative  a placeholder path in an example, never meant to resolve
//   external      outside this repository's tree (another repo, a host path)
//   planned       deliberately not built yet, tracked in its own row
//   generated     a deliberately untracked runtime artifact — held to its own
//                 predicate instead of the stale/unused checks (see below)
//   pending-<row> a citation believed FALSE, awaiting the row named here
const FIXED_REASONS = new Set(["illustrative", "external", "planned", "generated"]);
const PENDING_REASON = /^pending-[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Field separator for the (source, path) key. US (0x1F) cannot occur in either
// field. Keyed on the pair, never on the source alone: a whole-file exemption
// would silently license every future dangling path added to that file under
// the original, unrelated justification (the lesson already paid for in
// bootstrap/check-unit-drift.sh).
const KEY_SEP = "\u001f";

export type PathExemption = {
  source: string;
  path: string;
  reason: string;
  note: string;
  line: number;
};

// ── The match rule ─────────────────────────────────────────────────────────
//
// A token "looks like a repo-relative path" when, after stripping the prose
// wrapping around it, it is a slash-separated path naming a file (a final
// extension) or an explicit directory (a trailing slash). The rule is stated
// once, here, and the same function serves docs, CLAUDE.md and params.yaml.
export function normalizePathToken(raw: string): string | undefined {
  let token = raw.trim();
  // Prose wrapping: parentheses, quotes, brackets, trailing sentence marks.
  token = token.replace(/^[("'«\[]+/, "").replace(/[.,;:!?)\]»"']+$/, "");
  // Line/anchor suffix a document uses to point INTO a file: `check.ts:261`,
  // `tools/state-contract/check.ts:FLEET-IDLE`. The file is still the claim.
  token = token.replace(/:(?:\d+|[A-Z][A-Z0-9_-]*)$/, "");
  if (token === "") return undefined;
  // Repo-relative only. An absolute path is host state, a `~` path is the
  // operator's home, and neither is a claim about this repository's contents.
  if (!/^[A-Za-z0-9][A-Za-z0-9._*?+/-]*$/.test(token)) return undefined;
  // `..` traversal and `a/b...c` shell forms (`origin/main...HEAD`) are not
  // repository path citations.
  if (token.includes("..")) return undefined;
  if (!token.includes("/")) return undefined;
  const last = token.split("/").filter(Boolean).pop() ?? "";
  if (!token.endsWith("/") && !/\.[A-Za-z0-9]{1,8}$/.test(last)) return undefined;
  return token;
}

// Every path-like token in free text, whitespace-tokenized. Used for
// instance/params.yaml, whose citations are bare rather than backticked.
export function extractPathTokens(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const token = normalizePathToken(raw);
    if (token) found.add(token);
  }
  return [...found].sort();
}

// Every path-like token inside inline backticks. Markdown documents cite files
// in code spans; a span may hold a whole command, so each span is tokenized
// rather than matched whole (`bun tools/instructions/check.ts --repo <path>`
// yields exactly one candidate).
export function extractBacktickedPathTokens(contents: string): string[] {
  const found = new Set<string>();
  for (const match of contents.matchAll(/`([^`\r\n]+)`/g)) {
    for (const token of extractPathTokens(match[1])) found.add(token);
  }
  return [...found].sort();
}

// ── The existence predicate ────────────────────────────────────────────────
//
// "Does the repository carry this path" is answered from GIT, not from the
// filesystem, because the filesystem answers a different question on every
// tree. Two cases proved it, both real:
//
//   - `stand/` is an empty leftover directory on the canonical host and does
//     not exist in any lane worktree. On disk the same citation is true in one
//     tree and false in the other, and the empty directory carries none of the
//     mechanism the doc claims for it.
//   - `instance/decisions/inbox.jsonl` is deliberately gitignored: present in
//     the canonical checkout, absent in every lane worktree by design.
//
// Tracked-ness is the same answer everywhere, and it is the answer Hard Floor 5
// cares about: a destroyed host must be rebuildable from the repository alone,
// so a path only this host has is exactly the thing that must not count.
export type PathResolver = {
  satisfied: (token: string) => boolean;
  mode: "git" | "filesystem";
};

export function createPathResolver(repo: string): PathResolver {
  const listed = spawnSync("git", ["-C", repo, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.error || listed.status !== 0) {
    // Not a git repository (a fixture, an exported tree). Degrade to filesystem
    // existence rather than pass everything, and say so out loud at the call
    // site -- an unanswerable predicate is never a silent pass.
    return { satisfied: (token) => existsOnDisk(repo, token), mode: "filesystem" };
  }
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const entry of listed.stdout.split("\0")) {
    if (entry === "") continue;
    files.add(entry);
    const segments = entry.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return {
    mode: "git",
    satisfied: (token) => {
      const probe = literalPrefix(token);
      if (probe === undefined) return true; // `*.md` names no directory to check
      if (token.endsWith("/") || probe !== token.replace(/\/+$/, "")) return directories.has(probe);
      return files.has(probe) || directories.has(probe);
    },
  };
}

// The part of a token before any glob segment, with a trailing slash removed.
// A glob is answered by its deepest literal ancestor -- `instructions/**/*.md`
// asks whether `instructions/` is tracked -- which is weaker than expanding it,
// and is why a glob matching nothing inside a real directory still passes.
function literalPrefix(token: string): string | undefined {
  const trimmed = token.replace(/\/+$/, "");
  if (!/[*?]/.test(trimmed)) return trimmed;
  const literal: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (/[*?]/.test(segment)) break;
    literal.push(segment);
  }
  return literal.length === 0 ? undefined : literal.join("/");
}

function existsOnDisk(repo: string, token: string): boolean {
  const probe = literalPrefix(token);
  if (probe === undefined) return true;
  const full = join(repo, probe);
  if (token.endsWith("/")) {
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  }
  return existsSync(full);
}

// Reads the exemption ledger. A missing file is an empty set -- the fail-closed
// direction, since every cited path then has to exist. A malformed row is a
// FAIL naming the line, never a silently dropped entry.
export function readPathExemptions(repo: string): {
  rows: Map<string, PathExemption>;
  findings: PathFinding[];
} {
  const rows = new Map<string, PathExemption>();
  const findings: PathFinding[] = [];
  const file = join(repo, PATH_EXEMPTIONS_FILE);
  if (!existsSync(file)) return { rows, findings };
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error) {
    findings.push({
      level: "FAIL",
      file: PATH_EXEMPTIONS_FILE,
      check: "path-exemption",
      detail: `unreadable (refusing to treat as empty): ${(error as Error).message}`,
    });
    return { rows, findings };
  }
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.startsWith("#")) continue;
    const fields = line.split("\t");
    const at = `line ${index + 1}`;
    if (fields.length !== 4 || fields.some((field) => field.trim() === "")) {
      findings.push({
        level: "FAIL",
        file: PATH_EXEMPTIONS_FILE,
        check: "path-exemption",
        detail: `${at}: expected 4 non-empty tab-separated fields (source, path, reason, note)`,
      });
      continue;
    }
    const [source, path, reason, note] = fields.map((field) => field.trim());
    if (!FIXED_REASONS.has(reason) && !PENDING_REASON.test(reason)) {
      findings.push({
        level: "FAIL",
        file: PATH_EXEMPTIONS_FILE,
        check: "path-exemption",
        detail: `${at}: unknown reason '${reason}' (allowed: ${[...FIXED_REASONS].join(", ")}, pending-<row>)`,
      });
      continue;
    }
    if (normalizePathToken(path) !== path) {
      findings.push({
        level: "FAIL",
        file: PATH_EXEMPTIONS_FILE,
        check: "path-exemption",
        detail: `${at}: '${path}' is not a path this check can ever produce (an exemption for a token the scanner never emits is dead weight)`,
      });
      continue;
    }
    const key = `${source}${KEY_SEP}${path}`;
    if (rows.has(key)) {
      findings.push({
        level: "FAIL",
        file: PATH_EXEMPTIONS_FILE,
        check: "path-exemption",
        detail: `${at}: duplicate exemption for ${source} '${path}'`,
      });
      continue;
    }
    rows.set(key, { source, path, reason, note, line: index + 1 });
  }
  return { rows, findings };
}

type Source = { file: string; tokens: string[] };

// Collects the sources whose path claims are binding on an agent: every
// `status: binding` instruction doc, the root agent contract, and the instance
// parameter file that reaches the orchestrator's context verbatim.
function collectSources(repo: string, docs: InstructionDoc[]): {
  sources: Source[];
  findings: PathFinding[];
} {
  const sources: Source[] = [];
  const findings: PathFinding[] = [];

  const claudePath = join(repo, CLAUDE_FILENAME);
  if (existsSync(claudePath)) {
    sources.push({
      file: CLAUDE_FILENAME,
      tokens: extractBacktickedPathTokens(readFileSync(claudePath, "utf8")),
    });
  } else {
    findings.push({ level: "SKIP", file: CLAUDE_FILENAME, check: "path-exists", detail: "no CLAUDE.md at repo root" });
  }

  for (const doc of docs) {
    if (!doc.valid || doc.valid.status !== "binding") continue;
    sources.push({
      file: join("instructions", doc.relative),
      tokens: extractBacktickedPathTokens(doc.contents),
    });
  }

  const paramsPath = join(repo, PARAMS_FILE);
  if (existsSync(paramsPath)) {
    sources.push({ file: PARAMS_FILE, tokens: extractPathTokens(readFileSync(paramsPath, "utf8")) });
  } else {
    findings.push({ level: "SKIP", file: PARAMS_FILE, check: "path-exists", detail: "no instance/params.yaml" });
  }

  return { sources, findings };
}

// Runs the whole check: cited paths, then the exemption ledger's own health.
export function runPathChecks(repo: string, docs: InstructionDoc[]): PathFinding[] {
  const { rows, findings: exemptionFindings } = readPathExemptions(repo);
  const { sources, findings } = collectSources(repo, docs);
  findings.push(...exemptionFindings);
  const resolver = createPathResolver(repo);
  if (resolver.mode === "filesystem") {
    findings.push({
      level: "WARN",
      file: "path-predicate",
      check: "path-exists",
      detail: "not a git repository — falling back to filesystem existence, which answers a per-host question",
    });
  }
  const consulted = new Set<string>();

  for (const source of sources) {
    let satisfied = 0;
    for (const token of source.tokens) {
      if (resolver.satisfied(token)) {
        satisfied += 1;
        continue;
      }
      const key = `${source.file}${KEY_SEP}${token}`;
      const exemption = rows.get(key);
      if (exemption) {
        consulted.add(key);
        findings.push({
          level: "WARN",
          file: source.file,
          check: "path-exists",
          detail: `exempt '${token}' (reason=${exemption.reason}) — ${exemption.note}`,
        });
        continue;
      }
      findings.push({
        level: "FAIL",
        file: source.file,
        check: "path-exists",
        detail: `missing '${token}' — the document names a path the repository does not carry`,
      });
    }
    if (satisfied > 0) {
      findings.push({
        level: "PASS",
        file: source.file,
        check: "path-exists",
        detail: satisfied === 1 ? "1 referenced path exists" : `${satisfied} referenced paths exist`,
      });
    }
  }

  for (const [key, row] of rows) {
    if (resolver.satisfied(row.path)) {
      findings.push({
        level: "FAIL",
        file: PATH_EXEMPTIONS_FILE,
        check: "path-exemption",
        detail: `line ${row.line}: '${row.path}' now exists — remove this exemption (${row.source}, reason=${row.reason})`,
      });
      continue;
    }
    // `generated` is the one reason that claims something about WHY the path is
    // absent, so it carries its own predicate: the repository must actually
    // declare the path ignored. Without this it would be the reason that admits
    // any missing file, since nothing else it asserts is checkable.
    if (row.reason === "generated") findings.push(...checkGeneratedRow(repo, row));
    if (!consulted.has(key)) {
      findings.push({
        level: "FAIL",
        file: PATH_EXEMPTIONS_FILE,
        check: "path-exemption",
        detail: `line ${row.line}: never consulted — ${row.source} does not cite '${row.path}' (or is not a checked source)`,
      });
    }
  }

  return findings;
}

// `generated` claims the repository deliberately does not track this path. That
// is checkable: `git check-ignore` answers from the committed ignore rules, so
// the reason cannot be used to wave through an ordinary missing file. Outside a
// git repository (a fixture, an exported tree) the claim is unverifiable, which
// is a WARN naming why — never a silent pass.
function checkGeneratedRow(repo: string, row: PathExemption): PathFinding[] {
  const result = spawnSync("git", ["-C", repo, "check-ignore", "-q", "--", row.path], { encoding: "utf8" });
  if (result.error || result.status === null || result.status > 1) {
    return [
      {
        level: "WARN",
        file: PATH_EXEMPTIONS_FILE,
        check: "path-exemption",
        detail: `line ${row.line}: cannot verify reason=generated for '${row.path}' — git could not answer here`,
      },
    ];
  }
  if (result.status === 0) return [];
  return [
    {
      level: "FAIL",
      file: PATH_EXEMPTIONS_FILE,
      check: "path-exemption",
      detail: `line ${row.line}: reason=generated but the repository does not ignore '${row.path}' — reclassify or ignore it deliberately`,
    },
  ];
}
