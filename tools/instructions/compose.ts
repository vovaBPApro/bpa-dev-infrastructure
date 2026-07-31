#!/usr/bin/env bun
//
// Context-pack composer (§2.3 of migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md).
//
// Renders a self-contained mission preamble for a role: the role's baseline
// pack ALWAYS in full, plus any docs matched by `--tags`, plus any open interim
// directives (pending decisions). This is the compiled-delivery mechanism that
// replaces hand-pasting L1 excerpts into lane prompts.
//
// Guarantees (all fail-closed):
//   - Baseline pack is always included in full; --tags can only ADD, never
//     remove (F1).
//   - An unknown tag (not in instance/tags.conf) is a hard error, non-zero
//     exit (F4).
//   - Audience filter: a doc is included only if its audience is the role or
//     `all`.
//   - Snapshot materialization: docs are copied in FULL into the preamble (and,
//     with --out, into <dir>/context/), never left as "go read X" pointers (F7).
//   - Interim directives: instance/decisions/*.md with `state: pending` are
//     appended in full to every pack; `state: routed` files are not (§2.4).
//
// Usage: bun tools/instructions/compose.ts --role <role> [--tags a,b]
//        [--repo <path>] [--out <dir>] [--assert-budget <lines>]
// See --help for the full flag semantics.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { collectRepoDocs, type InstructionDoc } from "./docs.ts";
import { AUDIENCES, type Audience } from "./schema.ts";

export const PACK_MARKER_PREFIX = "<!-- compose.ts pack v1";

type Options = {
  role: Audience;
  tags: string[];
  repo: string;
  out: string | undefined;
  assertBudget: number | undefined;
};

const ROLES = AUDIENCES.filter((a) => a !== "all") as Exclude<Audience, "all">[];

// Whether a doc with the given audience is delivered to a role. `all` reaches
// every role; a role always gets its own audience. A manager is a dispatched
// orchestrator-agent (see instructions/roles.md) and therefore also receives
// `orchestrator`-audience docs — the one cross-role admission, kept explicit.
export function admitsAudience(role: Audience, audience: Audience): boolean {
  if (audience === "all") return true;
  if (audience === role) return true;
  if (role === "manager" && audience === "orchestrator") return true;
  return false;
}

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun tools/instructions/compose.ts --role <role> [options]",
      "",
      "Renders a self-contained mission context pack for a role.",
      "",
      "  --role <role>        One of: " + ROLES.join(" | ") + " (required)",
      "  --tags a,b,c         Comma-separated tags to ADD docs on top of the baseline.",
      "                       Each tag MUST be in instance/tags.conf or the run hard-fails.",
      "                       Tags only ADD docs; they never remove the baseline floor.",
      "  --repo <path>        Repository root (default: current directory).",
      "  --out <dir>          Also write each doc to <dir>/context/ plus manifest.json.",
      "                       Without --out the preamble is printed to stdout.",
      "  --assert-budget <n>  Exit non-zero if the total preamble exceeds <n> lines.",
      "                       Semantics: the count is the LINE COUNT of the full",
      "                       rendered preamble (marker + manifest + every included",
      "                       doc body + interim directives). It is a hard ceiling",
      "                       on delivered size, not a soft target.",
      "  -h, --help           Show this usage.",
      "",
      "Exit codes: 0 success, 1 budget exceeded, 2 usage/unknown-tag/config error.",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function fail(message: string): never {
  process.stderr.write(`compose: ${message}\n`);
  process.exit(2);
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    role: "coder",
    tags: [],
    repo: process.cwd(),
    out: undefined,
    assertBudget: undefined,
  };
  let roleSet = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--role") {
      const value = args[++index];
      if (!value || value.startsWith("--")) usage(2);
      if (!ROLES.includes(value as (typeof ROLES)[number])) {
        fail(`unknown role '${value}' (want one of ${ROLES.join(", ")})`);
      }
      options.role = value as Audience;
      roleSet = true;
      continue;
    }
    if (arg === "--tags") {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) usage(2);
      options.tags = value
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      continue;
    }
    if (arg === "--repo") {
      const value = args[++index];
      if (!value || value.startsWith("--")) usage(2);
      options.repo = value;
      continue;
    }
    if (arg === "--out") {
      const value = args[++index];
      if (!value || value.startsWith("--")) usage(2);
      options.out = value;
      continue;
    }
    if (arg === "--assert-budget") {
      const value = args[++index];
      if (!value || value.startsWith("--")) usage(2);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        fail(`--assert-budget must be a positive integer (got '${value}')`);
      }
      options.assertBudget = parsed;
      continue;
    }
    usage(2);
  }
  if (!roleSet) fail("--role is required");
  return options;
}

// Reads a `# comment`-tolerant, one-token-per-line config file (tags.conf).
export function readTagVocabulary(repo: string): Set<string> {
  const path = join(repo, "instance", "tags.conf");
  if (!existsSync(path)) fail(`tag vocabulary not found: ${path}`);
  const tags = new Set<string>();
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    tags.add(line);
  }
  return tags;
}

export type PackConfig = Map<string, string[]>;

// Parses packs.conf into role -> ordered list of baseline doc ids.
export function readPacks(repo: string): PackConfig {
  const path = join(repo, "instance", "packs.conf");
  if (!existsSync(path)) fail(`pack config not found: ${path}`);
  const packs: PackConfig = new Map();
  let current: string | undefined;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const header = line.match(/^\[([a-z]+)\]$/);
    if (header) {
      current = header[1];
      if (!packs.has(current)) packs.set(current, []);
      continue;
    }
    if (!current) fail(`packs.conf: entry '${line}' before any [role] header`);
    packs.get(current)!.push(line);
  }
  return packs;
}

// Resolves the L1 git SHA for the marker header. Falls back to "unknown" when
// git is unavailable (e.g. an exported tree) so the composer still runs.
function gitSha(repo: string): string {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function sha256Short(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
}

// First markdown heading line (`# ...`) in the body, or the first non-empty
// line, or a placeholder — used in the manifest and for the consumption echo.
function firstHeading(body: string): string {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line.trim())) return line.trim();
  }
  for (const line of lines) {
    if (line.trim() !== "") return line.trim();
  }
  return "(empty)";
}

type PackEntry = {
  id: string;
  relative: string;
  contents: string; // full file contents (frontmatter + body), the materialized snapshot
  hash: string; // sha256 of contents, first 12 hex
  heading: string;
  reason: "baseline" | "tag";
};

type Decision = {
  id: string;
  relative: string;
  contents: string;
  hash: string;
  heading: string;
};

export type InstanceFacts = {
  phase: string;
  active_scope: string;
  capture_mode: string;
  operator_language: string;
};

export type ComposeResult = {
  preamble: string;
  entries: PackEntry[];
  decisions: Decision[];
  instanceFacts: InstanceFacts;
  manifest: {
    role: string;
    l1: string;
    docs: { id: string; hash: string; heading: string; reason: string }[];
    interim: { id: string; hash: string; heading: string }[];
  };
};

// Extracts the four pack-binding installation facts from the deliberately
// simple params.yaml shape. Inline comments are discarded. Missing facts are a
// config error: a pack must never claim self-containment while silently
// omitting scope or capture state.
export function readInstanceFacts(repo: string): InstanceFacts {
  const path = join(repo, "instance", "params.yaml");
  if (!existsSync(path)) fail(`instance facts not found: ${path}`);
  const values = new Map<string, string>();
  let section = "";
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const top = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*$/);
    if (top) {
      section = top[1];
      continue;
    }
    // This intentionally narrow parser accepts only 2-space YAML nesting; arbitrary
    // indentation and tabs are outside the supported instance/params.yaml shape.
    const nested = line.match(/^\s{2}([A-Za-z][A-Za-z0-9_-]*):\s*(.+?)\s*$/);
    if (nested && section) values.set(`${section}.${nested[1]}`, nested[2].replace(/^["']|["']$/g, ""));
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (!value) fail(`instance/params.yaml missing required pack fact '${key}'`);
    return value;
  };
  return {
    phase: required("phase.current"),
    active_scope: required("phase.active_scope"),
    capture_mode: required("capture.mode"),
    operator_language: required("operator.language"),
  };
}

// Selects docs for a role: baseline pack (in order) always in full, then any
// doc matching a requested tag whose audience admits the role — appended in a
// stable order and de-duplicated against the baseline (a tag never re-adds or
// reorders a baseline doc). Throws (via fail) on an unknown tag or a baseline
// id that does not resolve.
export function selectDocs(
  role: Audience,
  requestedTags: string[],
  docs: InstructionDoc[],
  vocabulary: Set<string>,
  baseline: string[],
): PackEntry[] {
  for (const tag of requestedTags) {
    if (!vocabulary.has(tag)) {
      fail(`unknown tag '${tag}' (not in instance/tags.conf)`);
    }
  }

  const byId = new Map<string, InstructionDoc>();
  for (const doc of docs) {
    if (doc.valid) byId.set(doc.valid.id, doc);
  }

  const admits = (doc: InstructionDoc): boolean => admitsAudience(role, doc.valid!.audience);

  const entries: PackEntry[] = [];
  const seen = new Set<string>();

  const push = (doc: InstructionDoc, reason: PackEntry["reason"]): void => {
    if (seen.has(doc.valid!.id)) return;
    seen.add(doc.valid!.id);
    const parsed = parseBody(doc.contents);
    entries.push({
      id: doc.valid!.id,
      relative: doc.relative,
      contents: doc.contents,
      hash: sha256Short(doc.contents),
      heading: firstHeading(parsed),
      reason,
    });
  };

  // Baseline first, in configured order. A baseline id that does not resolve or
  // whose audience excludes the role is a config error, not a silent skip.
  for (const id of baseline) {
    const doc = byId.get(id);
    if (!doc) fail(`packs.conf: baseline id '${id}' for role '${role}' resolves to no doc`);
    if (!admits(doc)) {
      fail(
        `packs.conf: baseline id '${id}' has audience '${doc.valid!.audience}', ` +
          `not deliverable to role '${role}'`,
      );
    }
    push(doc, "baseline");
  }

  // Tag additions, in stable id order for determinism.
  const requested = new Set(requestedTags);
  const tagged = docs
    .filter((doc) => doc.valid && admits(doc) && doc.valid.tags.some((t) => requested.has(t)))
    .sort((a, b) => a.valid!.id.localeCompare(b.valid!.id));
  for (const doc of tagged) push(doc, "tag");

  return entries;
}

// Strips the leading frontmatter fence for heading extraction only. The full
// contents (with frontmatter) are what gets materialized into the pack.
function parseBody(contents: string): string {
  const match = contents.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? contents.slice(match[0].length) : contents;
}

// Collects interim directives: instance/decisions/*.md whose `state: pending`.
// routed / parked / superseded rows are not delivered.
export function collectPendingDecisions(repo: string): Decision[] {
  const dir = join(repo, "instance", "decisions");
  if (!existsSync(dir)) return [];
  const out: Decision[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const full = join(dir, entry);
    const contents = readFileSync(full, "utf8");
    const state = frontmatterValue(contents, "state");
    if (state !== "pending") continue;
    const id = frontmatterValue(contents, "id") ?? entry.replace(/\.md$/, "");
    const body = parseBody(contents);
    out.push({
      id,
      relative: join("instance", "decisions", entry),
      contents,
      hash: sha256Short(contents),
      heading: firstHeading(body),
    });
  }
  return out;
}

// Minimal single-key scalar lookup from a leading frontmatter block. Adequate
// for the flat `state:`/`id:` fields on decision files.
function frontmatterValue(contents: string, key: string): string | undefined {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(new RegExp(`^${key}\\s*:\\s*(.+)$`));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

// Renders the full preamble text from selected entries and pending decisions.
export function renderPreamble(
  role: string,
  l1: string,
  entries: PackEntry[],
  decisions: Decision[],
  facts: InstanceFacts,
): string {
  const lines: string[] = [];
  lines.push(`${PACK_MARKER_PREFIX} role=${role} l1=${l1} -->`);
  lines.push("");
  lines.push("# Mission Context Pack");
  lines.push("");
  lines.push(
    "This preamble is self-contained: every referenced instruction is included " +
      "in full below. Do not go read other files for these rules — this snapshot " +
      "IS the binding text at the stamped L1 SHA.",
  );
  lines.push("");

  // MANIFEST section.
  lines.push("## MANIFEST");
  lines.push("");
  lines.push("Echo each id + hash + heading in your terminal report (consumption check).");
  lines.push("");
  for (const entry of entries) {
    lines.push(`- ${entry.id}  sha256:${entry.hash}  (${entry.reason})  ${entry.heading}`);
  }
  if (decisions.length > 0) {
    for (const decision of decisions) {
      lines.push(`- ${decision.id}  sha256:${decision.hash}  (interim)  ${decision.heading}`);
    }
  }
  lines.push("");

  lines.push("## INSTANCE FACTS");
  lines.push("");
  lines.push(`phase=${facts.phase} active_scope=${facts.active_scope} capture.mode=${facts.capture_mode} operator.language=${facts.operator_language}`);
  lines.push("");

  // Doc bodies, in order.
  lines.push("## DOCUMENTS");
  lines.push("");
  for (const entry of entries) {
    lines.push(`<!-- doc id=${entry.id} sha256:${entry.hash} source=${entry.relative} -->`);
    lines.push(entry.contents.replace(/\s+$/, ""));
    lines.push("");
  }

  // Interim directives, if any.
  if (decisions.length > 0) {
    lines.push("## INTERIM DIRECTIVES");
    lines.push("");
    lines.push(
      "Open (pending) Human directives, provisionally binding until routed into a " +
        "doc. They override nothing yet but must be honored now (§2.4).",
    );
    lines.push("");
    for (const decision of decisions) {
      lines.push(`<!-- interim id=${decision.id} sha256:${decision.hash} source=${decision.relative} -->`);
      lines.push(decision.contents.replace(/\s+$/, ""));
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

export function compose(options: Options): ComposeResult {
  const instructionsRoot = resolve(options.repo, "instructions");
  if (!existsSync(instructionsRoot)) fail(`instructions/ not found under ${options.repo}`);

  const vocabulary = readTagVocabulary(options.repo);
  const packs = readPacks(options.repo);
  const baseline = packs.get(options.role) ?? [];
  if (baseline.length === 0) {
    fail(`no baseline pack defined for role '${options.role}' in instance/packs.conf`);
  }

  const docs = collectRepoDocs(options.repo);
  const entries = selectDocs(options.role, options.tags, docs, vocabulary, baseline);
  const decisions = collectPendingDecisions(options.repo);
  const instanceFacts = readInstanceFacts(options.repo);
  const l1 = gitSha(options.repo);
  const preamble = renderPreamble(options.role, l1, entries, decisions, instanceFacts);

  return {
    preamble,
    entries,
    decisions,
    instanceFacts,
    manifest: {
      role: options.role,
      l1,
      docs: entries.map((e) => ({ id: e.id, hash: e.hash, heading: e.heading, reason: e.reason })),
      interim: decisions.map((d) => ({ id: d.id, hash: d.hash, heading: d.heading })),
    },
  };
}

// Writes the pack to <dir>: preamble.md, context/<id>.md per doc, and
// manifest.json. The context/ dir is cleaned first so a re-run is reproducible.
function writeOut(dir: string, result: ComposeResult): void {
  const contextDir = join(dir, "context");
  if (existsSync(contextDir)) rmSync(contextDir, { recursive: true, force: true });
  mkdirSync(contextDir, { recursive: true });
  writeFileSync(join(dir, "preamble.md"), result.preamble);
  for (const entry of result.entries) {
    writeFileSync(join(contextDir, `${entry.id}.md`), entry.contents);
  }
  for (const decision of result.decisions) {
    writeFileSync(join(contextDir, `${decision.id}.md`), decision.contents);
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(result.manifest, null, 2) + "\n");
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const result = compose(options);

  if (options.assertBudget !== undefined) {
    const count = result.preamble.split("\n").length;
    if (count > options.assertBudget) {
      process.stderr.write(
        `compose: preamble is ${count} lines, exceeds --assert-budget ${options.assertBudget}\n`,
      );
      process.exit(1);
    }
  }

  if (options.out !== undefined) {
    mkdirSync(options.out, { recursive: true });
    writeOut(options.out, result);
    process.stderr.write(
      `compose: wrote ${result.entries.length} docs + ${result.decisions.length} interim to ${options.out}\n`,
    );
  } else {
    process.stdout.write(result.preamble);
  }
}
