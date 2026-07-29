#!/usr/bin/env bun
//
// Instruction-doc checker (Phase 0, §2.5: the checker exists BEFORE the
// structure relies on it). Checks, over instructions/**/*.md:
//   (a) frontmatter present and schema-valid;
//   (b) id uniqueness;
//   (c) generated-index freshness — only when the index carries the generator
//       marker (otherwise SKIP, so the current hand-written README is not failed
//       red on day one);
//   (d) dangling references: decision:/overrides:/moved-to: pointing at an id
//       that exists in no local doc is reported (FAIL locally; cross-tree ids
//       are a WARN since a stranger's fork cannot be resolved here).
//
// Transition mode: without --strict, a missing frontmatter block is a WARN so
// the current un-migrated corpus does not fail. With --strict it is a FAIL.
// Exit non-zero on any FAIL.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { validateFrontmatter } from "./schema.ts";
import { collectDocs, INDEX_FILENAME, INDEX_MARKER, type InstructionDoc } from "./docs.ts";
import { renderIndex } from "./index.ts";
import { readTagVocabulary, readPacks } from "./compose.ts";
import {
  renderFloor,
  extractFloorSection,
  collectFloorLines,
  FloorError,
  CLAUDE_FILENAME,
} from "./floor.ts";
import { runLedgerChecks } from "./ledger.ts";
import { runSessionLoadCheck } from "./session-load.ts";

type Options = { repo: string; strict: boolean };
type Level = "PASS" | "WARN" | "FAIL" | "SKIP";

type Finding = { level: Level; file: string; check: string; detail: string };

const findings: Finding[] = [];

function record(level: Level, file: string, check: string, detail = ""): void {
  findings.push({ level, file, check, detail });
}

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun tools/instructions/check.ts [--repo <path>] [--strict]",
      "",
      "  --repo <path>   Repository root to check (default: current directory)",
      "  --strict        Treat missing frontmatter as FAIL (default: WARN)",
      "  -h, --help      Show this usage",
      "",
      "Exit codes: 0 no failures, 1 one or more FAIL findings, 2 usage error.",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function parseArgs(args: string[]): Options {
  const options: Options = { repo: process.cwd(), strict: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--strict") {
      options.strict = true;
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

const options = parseArgs(process.argv.slice(2));
const instructionsRoot = resolve(options.repo, "instructions");

if (!existsSync(instructionsRoot)) {
  record("FAIL", "instructions/", "root", "directory not found");
  report();
}

const docs = collectDocs(instructionsRoot);

// (a) frontmatter present + schema-valid; collect ids for later checks.
type IdEntry = { id: string; file: string };
const idEntries: IdEntry[] = [];

for (const doc of docs) {
  if (doc.frontmatter === undefined) {
    if (options.strict) {
      record("FAIL", doc.relative, "frontmatter", "missing frontmatter block");
    } else {
      record("WARN", doc.relative, "frontmatter", "missing frontmatter block (transition mode)");
    }
    continue;
  }
  const validation = validateFrontmatter(doc.frontmatter);
  if (!validation.valid) {
    record("FAIL", doc.relative, "schema", validation.errors.join("; "));
    // Still index its id (if any) so a bad-schema dup is not double-hidden.
    if (typeof doc.frontmatter.id === "string") {
      idEntries.push({ id: doc.frontmatter.id, file: doc.relative });
    }
    continue;
  }
  record("PASS", doc.relative, "schema", `id=${validation.frontmatter!.id} layer=${validation.frontmatter!.layer}`);
  idEntries.push({ id: validation.frontmatter!.id, file: doc.relative });
}

// (b) id uniqueness.
const byId = new Map<string, string[]>();
for (const entry of idEntries) {
  const files = byId.get(entry.id) ?? [];
  files.push(entry.file);
  byId.set(entry.id, files);
}
for (const [id, files] of byId) {
  if (files.length > 1) {
    record("FAIL", files.join(", "), "id-uniqueness", `id '${id}' declared in ${files.length} files`);
  }
}
const localIds = new Set(byId.keys());

// Decision-ledger ids (instance/decisions/*.md `id:`). A `decision:` reference
// implements an HR directive (§2.1), which lives in the ledger, not in
// instructions/. Collect those ids so `decision:` refs resolve against them.
// overrides:/moved-to: still resolve against instructions/ ids only.
const decisionIds = collectDecisionIds(options.repo);

// (c) generated-index freshness — only when the index carries the marker.
const indexPath = join(instructionsRoot, INDEX_FILENAME);
if (!existsSync(indexPath)) {
  record("SKIP", INDEX_FILENAME, "index-freshness", "no index file");
} else {
  const current = readFileSync(indexPath, "utf8");
  if (!current.includes(INDEX_MARKER)) {
    record(
      "SKIP",
      INDEX_FILENAME,
      "index-freshness",
      "hand-written index (no generator marker) — run tools/instructions/index.ts to adopt",
    );
  } else {
    const expected = renderIndex(docs);
    if (normalize(current) === normalize(expected)) {
      record("PASS", INDEX_FILENAME, "index-freshness", "up to date");
    } else {
      record("FAIL", INDEX_FILENAME, "index-freshness", "stale — regenerate with tools/instructions/index.ts");
    }
  }
}

// (d) dangling references: decision:/overrides:/moved-to: → unknown id.
// `decision:` resolves against instructions/ ids OR the decision ledger; the
// other two resolve against instructions/ ids only.
const decisionResolvable = new Set([...localIds, ...decisionIds]);
for (const doc of docs) {
  if (!doc.valid) continue;
  checkReferences(doc, "decision", doc.valid.decision, decisionResolvable);
  checkReferences(doc, "overrides", doc.valid.overrides, localIds);
  const movedTo = doc.valid["moved-to"];
  if (typeof movedTo === "string") checkReferences(doc, "moved-to", [movedTo], localIds);
}

// (e) pack coverage: every `status: binding` doc must be reachable via some
// role's baseline pack OR ≥1 tag in tags.conf admitted for its audience, OR
// carry `pack: none`. Runs only when both config files exist (a fixture repo
// without instance/ SKIPs rather than aborting). FAIL under --strict, WARN
// otherwise, matching the frontmatter transition-mode policy.
const tagsPath = join(options.repo, "instance", "tags.conf");
const packsPath = join(options.repo, "instance", "packs.conf");
if (!existsSync(tagsPath) || !existsSync(packsPath)) {
  record("SKIP", "instance/", "pack-coverage", "no instance/tags.conf + packs.conf");
} else {
  const vocabulary = readTagVocabulary(options.repo);
  const packs = readPacks(options.repo);
  // A doc's id is baseline-reachable if it appears in ANY role's baseline.
  const baselineIds = new Set<string>();
  for (const ids of packs.values()) for (const id of ids) baselineIds.add(id);

  for (const doc of docs) {
    if (!doc.valid) continue;
    if (doc.valid.status !== "binding") continue;
    if (doc.valid.pack === "none") {
      record("PASS", doc.relative, "pack-coverage", "opted out via pack: none");
      continue;
    }
    if (baselineIds.has(doc.valid.id)) {
      record("PASS", doc.relative, "pack-coverage", "in a role baseline");
      continue;
    }
    // Tag-reachable: at least one of its tags is a real (vocabulary) tag. Any
    // requester whose audience the doc admits could then pull it via --tags.
    const hasRealTag = doc.valid.tags.some((tag) => vocabulary.has(tag));
    if (hasRealTag) {
      record("PASS", doc.relative, "pack-coverage", "reachable via a known tag");
      continue;
    }
    const detail = "binding doc unreachable: no baseline, no known tag, no pack: none";
    if (options.strict) record("FAIL", doc.relative, "pack-coverage", detail);
    else record("WARN", doc.relative, "pack-coverage", detail);
  }
}

// (f) Hard Floor drift: the section between the markers in CLAUDE.md must be
// byte-identical to what floor.ts generates from `floor: true` docs. A hand-edit
// (drift), a missing marker, or a floor doc without its floor-line all FAIL —
// this is what makes the generated section un-forgeable by hand. Runs only when
// CLAUDE.md exists (a fixture repo without it SKIPs rather than aborting).
const claudePath = join(options.repo, CLAUDE_FILENAME);
if (!existsSync(claudePath)) {
  record("SKIP", CLAUDE_FILENAME, "hard-floor", "no CLAUDE.md at repo root");
} else {
  const claudeText = readFileSync(claudePath, "utf8");
  try {
    const expected = renderFloor(docs);
    const actual = extractFloorSection(claudeText);
    if (actual === undefined) {
      record("FAIL", CLAUDE_FILENAME, "hard-floor", "hard-floor markers missing or out of order");
    } else if (actual === expected) {
      const count = collectFloorLines(docs).length;
      record("PASS", CLAUDE_FILENAME, "hard-floor", `up to date (${count} floor lines)`);
    } else {
      record("FAIL", CLAUDE_FILENAME, "hard-floor", "section drifted — regenerate with tools/instructions/floor.ts");
    }
  } catch (error) {
    if (error instanceof FloorError) {
      record("FAIL", CLAUDE_FILENAME, "hard-floor", error.message);
    } else {
      throw error;
    }
  }
}

// (g) ledger aging (§2.4): untriaged inbox.jsonl rows >24h and pending HR files
// >72h. The inbox check honours --strict (FAIL vs WARN) like the other
// transition-mode checks; HR pending aging is always a FAIL (the SLA is
// absolute — a pending row past its window is a defect regardless of mode).
for (const finding of runLedgerChecks(options.repo, options.strict)) {
  record(finding.level, finding.file, "ledger", finding.detail);
}

// (h) session-load budget (§2.3): the orchestrator SessionStart load (params +
// open ledger + orchestrator binding docs) is line-capped so growth forces
// demotion to summaries. Always reports the measured size (never SKIPs) so the
// cap bites as the corpus grows.
{
  const finding = runSessionLoadCheck(options.repo);
  record(finding.level, finding.file, "session-load", finding.detail);
}

function checkReferences(
  doc: InstructionDoc,
  field: string,
  refs: string[] | undefined,
  resolvable: Set<string>,
): void {
  if (!refs || refs.length === 0) return;
  for (const ref of refs) {
    if (ref.trim() === "" || ref.toLowerCase() === "none") continue;
    if (resolvable.has(ref)) continue;
    // Cross-tree ids (an id that names another repo's doc) cannot be resolved
    // here; report as WARN so a stranger's fork does not go red. A locally
    // dangling id is a FAIL.
    if (isCrossTree(ref)) {
      record("WARN", doc.relative, `${field}-reference`, `cross-tree id '${ref}' not resolved locally`);
    } else {
      record("FAIL", doc.relative, `${field}-reference`, `dangling id '${ref}' exists in no local doc`);
    }
  }
}

// Collects `id:` values from instance/decisions/*.md so `decision:` references
// resolve against the ledger. Missing dir yields an empty set (a fixture repo
// without a ledger simply has no ledger ids to resolve against).
function collectDecisionIds(repo: string): Set<string> {
  const ids = new Set<string>();
  const dir = join(repo, "instance", "decisions");
  if (!existsSync(dir)) return ids;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const contents = readFileSync(join(dir, entry), "utf8");
    const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) continue;
    const idLine = match[1].split(/\r?\n/).find((line) => /^id\s*:/.test(line));
    if (idLine) ids.add(idLine.replace(/^id\s*:\s*/, "").trim().replace(/^["']|["']$/g, ""));
  }
  return ids;
}

// A cross-tree id is one prefixed with a known non-local layer namespace, e.g.
// `l2:...` or `l3:...`. Bare ids are treated as local-and-must-resolve.
function isCrossTree(ref: string): boolean {
  return /^(l2|l3):/i.test(ref);
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n+$/g, "\n");
}

report();

function report(): never {
  const order: Record<Level, number> = { FAIL: 0, WARN: 1, SKIP: 2, PASS: 3 };
  const sorted = [...findings].sort(
    (a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file),
  );
  for (const finding of sorted) {
    const detail = finding.detail ? `  ${finding.detail}` : "";
    console.log(`${finding.level.padEnd(4)} ${finding.file} [${finding.check}]${detail}`);
  }
  const counts: Record<Level, number> = { PASS: 0, WARN: 0, SKIP: 0, FAIL: 0 };
  for (const finding of findings) counts[finding.level] += 1;
  console.log(
    `\nsummary: ${counts.FAIL} FAIL, ${counts.WARN} WARN, ${counts.SKIP} SKIP, ${counts.PASS} PASS` +
      ` (${docs.length} docs)`,
  );
  process.exit(counts.FAIL > 0 ? 1 : 0);
}
