#!/usr/bin/env bun
//
// New-repo scaffolder (§4.3 item 7 of
// migration-prep/INSTRUCTIONS_CONSILIUM_FINAL.md). Materializes a born-clean L2
// (framework) or L3 (agent) repo from templates/agent-repo/: the same skeleton
// every repo starts from (§2.1). "Born-clean" means the new repo passes
// `check.ts --strict` with zero FAIL on its very first commit — the checker
// predates the structure, and L2/L3 are born already conforming to it.
//
// What it does, fail-closed:
//   - Refuses to scaffold into a non-empty directory (never clobbers).
//   - Copies the template, substitutes {{REPO_NAME}}/{{LAYER}}/{{MISSION}}.
//   - Creates AGENTS.md as a symlink to CLAUDE.md (no vendor rule forks).
//   - Runs index + floor generation so the index and the CLAUDE.md Hard Floor
//     are generated (not hand-written) for the new empty instruction set.
//   - Runs check.ts --strict against the new repo and prints its summary.
//   - For --layer L2: prints the L1 instance/parked.md rows as a promotion TODO
//     (L2's creation is the trigger to promote parked content, §2.1/§4.3).
//
// Usage: bun tools/instructions/scaffold.ts --name <repo> --layer L2|L3
//        --mission "<text>" --out <dir> [--l1 <path>]
// See --help for the full flag semantics.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { resolve, join, relative, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { collectDocs } from "./docs.ts";
import { renderIndex } from "./index.ts";
import { renderFloor, replaceFloorSection, CLAUDE_FILENAME } from "./floor.ts";
import { INDEX_FILENAME } from "./docs.ts";

const TEMPLATE_RELATIVE = join("templates", "agent-repo");
const L1_PIN_FILENAME = "L1_PIN.json";
const L1_PIN_SCHEMA = "bpa.l1-bootstrap/v1";
const L1_BOOTSTRAP_PATH = "instructions/instruction-layers.md";
// Template scaffolding files that are NOT part of the generated output.
const TEMPLATE_ONLY = new Set(["TEMPLATE.md"]);
// Files copied only for a given layer.
const L2_ONLY = new Set(["L2_PARKED_PROMOTION.md"]);
const LAYERS = ["L2", "L3"] as const;
type ScaffoldLayer = (typeof LAYERS)[number];

type Options = {
  name: string;
  layer: ScaffoldLayer;
  mission: string;
  out: string;
  // L1 repo root, source of the template and the parked manifest. Defaults to
  // this tool's own repo (two levels up from tools/instructions/).
  l1: string;
};

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun tools/instructions/scaffold.ts --name <repo> --layer L2|L3 \\",
      "         --mission \"<text>\" --out <dir> [--l1 <path>]",
      "",
      "Scaffolds a born-clean L2/L3 repo from templates/agent-repo/.",
      "",
      "  --name <repo>     New repository name (fills {{REPO_NAME}}). Required.",
      "  --layer L2|L3     Layer of the new repo (fills {{LAYER}}). Required.",
      "  --mission <text>  Mission statement, <=5 lines (fills {{MISSION}}). Required.",
      "  --out <dir>       Target directory. MUST be empty or not yet exist. Required.",
      "  --l1 <path>       L1 repo root (template + parked manifest source).",
      "                    Default: this tool's own repo root.",
      "  -h, --help        Show this usage.",
      "",
      "Exit codes: 0 born clean, 1 born repo failed check.ts --strict,",
      "            2 usage / non-empty target / missing template.",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function fail(message: string): never {
  process.stderr.write(`scaffold: ${message}\n`);
  process.exit(2);
}

function parseArgs(args: string[]): Options {
  const defaultL1 = resolve(import.meta.dir, "..", "..");
  const options: Partial<Options> = { l1: defaultL1 };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") usage(0);
    const takeValue = (): string => {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) usage(2);
      return value;
    };
    if (arg === "--name") {
      options.name = takeValue();
      continue;
    }
    if (arg === "--layer") {
      const value = takeValue();
      if (!LAYERS.includes(value as ScaffoldLayer)) {
        fail(`--layer must be one of ${LAYERS.join(" | ")} (got '${value}')`);
      }
      options.layer = value as ScaffoldLayer;
      continue;
    }
    if (arg === "--mission") {
      options.mission = takeValue();
      continue;
    }
    if (arg === "--out") {
      options.out = takeValue();
      continue;
    }
    if (arg === "--l1") {
      options.l1 = takeValue();
      continue;
    }
    usage(2);
  }
  if (!options.name) fail("--name is required");
  if (!options.layer) fail("--layer is required");
  if (options.mission === undefined || options.mission.trim() === "") {
    fail("--mission is required and must be non-empty");
  }
  if (!options.out) fail("--out is required");
  return options as Options;
}

// A target is scaffoldable when it does not exist, or exists as an empty
// directory. Anything else (a file, or a non-empty dir) is refused so we never
// clobber existing content.
function assertScaffoldable(dir: string): void {
  if (!existsSync(dir)) return;
  const stats = statSync(dir);
  if (!stats.isDirectory()) fail(`target '${dir}' exists and is not a directory`);
  const entries = readdirSync(dir);
  if (entries.length > 0) {
    fail(`target directory '${dir}' is not empty (${entries.length} entries); refusing to scaffold`);
  }
}

// Recursively lists template files (relative paths) that apply to the target
// layer, excluding template-only scaffolding and layer-mismatched files.
function templateFiles(templateRoot: string, layer: ScaffoldLayer): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(templateRoot, full);
      if (TEMPLATE_ONLY.has(rel)) continue;
      if (L2_ONLY.has(rel) && layer !== "L2") continue;
      out.push(rel);
    }
  };
  walk(templateRoot);
  return out;
}

function substitute(contents: string, options: Options): string {
  return contents
    .replaceAll("{{REPO_NAME}}", options.name)
    .replaceAll("{{LAYER}}", options.layer)
    .replaceAll("{{MISSION}}", options.mission);
}

// Extracts the parked-manifest table rows from L1's instance/parked.md, as a
// promotion TODO for a new L2 repo. Returns the raw markdown table rows (data
// rows only, header/separator stripped). Empty when the manifest is absent.
function parkedRows(l1: string): string[] {
  const path = join(l1, "instance", "parked.md");
  if (!existsSync(path)) return [];
  const rows: string[] = [];
  let inTable = false;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      inTable = false;
      continue;
    }
    // Header separator row (|---|---|...) toggles table body on.
    if (/^\|[\s|:-]+\|$/.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (inTable) rows.push(trimmed);
  }
  return rows;
}

function gitOutput(l1: string, args: string[], purpose: string): string {
  const result = spawnSync("git", ["-C", l1, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`cannot ${purpose} from L1 at '${l1}': ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

// Pin the routing/bootstrap document as a Git object reference, not copied rule
// text. A consumer can resolve <revision>:<path> from an L1 checkout and verify
// the bytes against sha256 even when that checkout's working tree has moved on.
function l1Pin(l1: string): string {
  const revision = gitOutput(l1, ["rev-parse", "HEAD"], "resolve HEAD");
  if (!/^[0-9a-f]{40}$/.test(revision)) fail(`L1 HEAD is not a full commit SHA: '${revision}'`);
  const bootstrap = spawnSync("git", ["-C", l1, "show", `${revision}:${L1_BOOTSTRAP_PATH}`]);
  if (bootstrap.status !== 0) {
    fail(`cannot resolve L1 bootstrap '${revision}:${L1_BOOTSTRAP_PATH}'`);
  }
  return `${JSON.stringify(
    {
      schema: L1_PIN_SCHEMA,
      source: {
        repository: "bpa-dev-infrastructure",
        revision,
        path: L1_BOOTSTRAP_PATH,
        sha256: createHash("sha256").update(bootstrap.stdout).digest("hex"),
      },
    },
    null,
    2,
  )}\n`;
}

function scaffold(options: Options): number {
  const templateRoot = join(resolve(options.l1), TEMPLATE_RELATIVE);
  if (!existsSync(templateRoot)) {
    fail(`template not found at ${templateRoot} (is --l1 the infra repo root?)`);
  }

  const outDir = resolve(options.out);
  assertScaffoldable(outDir);
  mkdirSync(outDir, { recursive: true });

  // 1. Copy + substitute every applicable template file.
  for (const rel of templateFiles(templateRoot, options.layer)) {
    const source = readFileSync(join(templateRoot, rel), "utf8");
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, substitute(source, options));
  }

  // 2. AGENTS.md symlink -> CLAUDE.md (relative link so the repo is portable).
  const agentsPath = join(outDir, "AGENTS.md");
  if (existsSync(agentsPath)) fail("template unexpectedly shipped a literal AGENTS.md");
  symlinkSync(CLAUDE_FILENAME, agentsPath);

  // 3. Generate the index + Hard Floor from the (empty) instruction set so both
  // generated surfaces are born fresh — never hand-written.
  const instructionsRoot = join(outDir, "instructions");
  const docs = collectDocs(instructionsRoot);
  writeFileSync(join(instructionsRoot, INDEX_FILENAME), renderIndex(docs));
  const claudePath = join(outDir, CLAUDE_FILENAME);
  const claudeText = readFileSync(claudePath, "utf8");
  writeFileSync(claudePath, replaceFloorSection(claudeText, renderFloor(docs)));

  // 4. Write the versioned L1 bootstrap pin after index generation so the
  // generated README remains an index of binding Markdown docs only.
  writeFileSync(join(instructionsRoot, L1_PIN_FILENAME), l1Pin(resolve(options.l1)));

  process.stdout.write(`scaffold: created ${options.layer} repo '${options.name}' at ${outDir}\n`);
  process.stdout.write(`scaffold: AGENTS.md -> ${CLAUDE_FILENAME} (symlink)\n`);
  process.stdout.write(`scaffold: L1 bootstrap pin -> instructions/${L1_PIN_FILENAME}\n`);

  // 5. L2 promotion TODO: print the parked-manifest rows.
  if (options.layer === "L2") {
    const rows = parkedRows(options.l1);
    process.stdout.write("\nscaffold: L2 created — parked content is now flagged for promotion (§2.1/§4.3).\n");
    process.stdout.write("Promotion TODO (from L1 instance/parked.md):\n");
    if (rows.length === 0) {
      process.stdout.write("  (no parked rows found)\n");
    } else {
      for (const row of rows) process.stdout.write(`  ${row}\n`);
    }
    process.stdout.write("See L2_PARKED_PROMOTION.md for the move-and-delete procedure.\n");
  }

  // 6. Run the checker against the new repo and surface its summary. A born repo
  // that fails --strict is a scaffold bug: exit 1 so callers (and tests) catch it.
  const checker = join(import.meta.dir, "check.ts");
  const check = spawnSync("bun", [checker, "--repo", outDir, "--strict"], { encoding: "utf8" });
  process.stdout.write("\nscaffold: born-repo check (check.ts --strict):\n");
  process.stdout.write(check.stdout ?? "");
  if (check.stderr) process.stderr.write(check.stderr);
  if (check.status !== 0) {
    process.stderr.write("scaffold: born repo is NOT checker-clean — this is a scaffold bug.\n");
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  process.exit(scaffold(options));
}

export { scaffold, parkedRows, templateFiles, substitute, assertScaffoldable, l1Pin };
export type { Options as ScaffoldOptions };
