#!/usr/bin/env bun
//
// Orchestrator SessionStart load (INSTRUCTIONS_CONSILIUM_FINAL.md §2.3: "a
// SessionStart hook loads instance/params.yaml + open ledger rows +
// audience: orchestrator binding docs; the checker caps that full-load set's
// total lines"). This is the harness-enforced replacement for the ritual of
// hoping the orchestrator re-reads its standing rules on restart.
//
// It prints, in a fixed order:
//   1. instance/params.yaml (every this-installation value the orchestrator
//      needs to resolve parameterized rules);
//   2. OPEN decisions-ledger rows — instance/decisions/HR-*.md with
//      `state: pending` (interim-binding directives), plus untriaged
//      inbox.jsonl rows (raw inbound with no HR file and no triage verdict), so
//      a directive captured seconds before a restart is loaded on the next boot;
//   3. every binding doc whose audience reaches the orchestrator
//      (`audience: orchestrator` or `all`) as a one-line SUMMARY (id + its
//      frontmatter `summary:` + relative path) — the standing index of the law
//      the orchestrator must always be aware of. Full bodies are NOT inlined
//      here: they are delivered on demand by the compose packs. The SessionStart
//      load is an always-on index, "small by construction", not a full corpus
//      dump.
//
// The composed output is deliberately bounded: check.ts's [session-load] check
// counts these same lines and fails when the set grows past the budget, which
// forces demotion (a doc losing orchestrator audience, or the params/ledger
// shrinking) instead of silent context bloat.
//
// This module exports collectSessionLoad() (pure, for the checker and tests) and
// renderSessionLoad() (the printed text). The CLI prints renderSessionLoad().
//
// Usage: bun tools/instructions/session-load.ts [--repo <path>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { collectDocs, type InstructionDoc } from "./docs.ts";
import { admitsAudience } from "./compose.ts";
import { latestHandoffPath } from "./handoff.ts";

// The role a SessionStart load targets. Orchestrator is the only session that
// gets a SessionStart hook (§2.3); factored out so the checker and tests share
// the exact selection the tool uses.
export const SESSION_ROLE = "orchestrator" as const;

export type SessionSection = {
  title: string;
  // Line-oriented content already stripped of trailing whitespace per line.
  lines: string[];
};

export type SessionLoad = {
  sections: SessionSection[];
  // Flat rendered text (what the CLI prints and the checker counts).
  text: string;
  // Total line count of `text`, the number the budget check caps.
  lineCount: number;
};

// Reads a file's contents, or an empty string if absent (a fixture repo without
// one of these artifacts simply contributes nothing rather than aborting).
function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function trimTrailing(text: string): string[] {
  return text.replace(/\s+$/, "").split(/\r?\n/);
}

type Probe = { lines: string[]; degradedReason?: string };

function gitProbe(root: string): Probe {
  try {
    const options = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] } as const;
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], options).trim();
    const dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], options).trim() !== "";
    return {
      lines: [
        `repo_sha: ${sha}`,
        dirty ? "WARNING: working tree dirty at session load" : "working_tree: clean",
      ],
      degradedReason: dirty ? "working tree dirty" : undefined,
    };
  } catch {
    return {
      lines: ["repo_sha: unknown", "working_tree: unknown (git probe failed)"],
      degradedReason: "git state unknown",
    };
  }
}

function durableStateProbe(root: string): Probe {
  const path = process.env.INFRA_STATE_DB ?? process.env.ORCH_STATE_DB ?? join(root, "runtime", "state.db");
  if (!existsSync(path)) {
    return {
      lines: ["missions: unknown", "lanes: unknown", "leases: unknown"],
      degradedReason: "durable state unknown (state DB absent)",
    };
  }

  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, strict: true });
    const now = Date.now();
    const missions = db.query(
      "SELECT id, correlation_id AS correlationId, state FROM missions WHERE state != 'succeeded' ORDER BY id",
    ).all();
    const lanes = db.query(
      "SELECT id, mission_id AS missionId, state FROM lanes WHERE state != 'succeeded' ORDER BY id",
    ).all();
    const leases = db.query(
      "SELECT lease_key AS key, owner, fencing_token AS fencingToken, expires_at AS expiresAt FROM leases WHERE released_at IS NULL AND expires_at > ? ORDER BY lease_key, fencing_token",
    ).all(now);
    return [
      ["missions", missions],
      ["lanes", lanes],
      ["leases", leases],
    ].reduce<Probe>(
      (probe, [label, rows]) => {
        probe.lines.push(`${label}: ${JSON.stringify(rows)}`);
        return probe;
      },
      { lines: [] },
    );
  } catch {
    return {
      lines: ["missions: unknown", "lanes: unknown", "leases: unknown"],
      degradedReason: "durable state unknown (state DB unreadable)",
    };
  } finally {
    db?.close();
  }
}

// Minimal flat frontmatter scalar lookup (same subset the rest of this tooling
// uses). Adequate for `state:` / `id:` on decision files.
function frontmatterValue(contents: string, key: string): string | undefined {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(new RegExp(`^${key}\\s*:\\s*(.+)$`));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return undefined;
}

// Open (pending) HR decision files, sorted by filename for stable output.
function collectPendingHr(decisionsDir: string): { name: string; contents: string }[] {
  if (!existsSync(decisionsDir)) return [];
  const out: { name: string; contents: string }[] = [];
  for (const entry of readdirSync(decisionsDir).sort()) {
    if (!/^HR-.+\.md$/i.test(entry)) continue;
    const contents = readFileSync(join(decisionsDir, entry), "utf8");
    if (frontmatterValue(contents, "state") !== "pending") continue;
    out.push({ name: entry, contents });
  }
  return out;
}

// Untriaged inbox rows: inbound msg-ids with no HR-<id>.md and no triage verdict.
// Mirrors the aging check's routed/triaged resolution so the two never disagree.
function collectUntriagedInbox(decisionsDir: string): string[] {
  const inboxPath = join(decisionsDir, "inbox.jsonl");
  if (!existsSync(inboxPath)) return [];

  const routed = new Set<string>();
  if (existsSync(decisionsDir)) {
    for (const entry of readdirSync(decisionsDir)) {
      const m = entry.match(/^HR-(.+)\.md$/i);
      if (m) routed.add(m[1]);
    }
  }

  const triaged = new Set<string>();
  const triagePath = join(decisionsDir, "triage.jsonl");
  if (existsSync(triagePath)) {
    for (const line of readFileSync(triagePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const row = JSON.parse(trimmed) as { msg_id?: number | string };
        if (row && row.msg_id !== undefined) triaged.add(String(row.msg_id));
      } catch {
        /* torn line — skip */
      }
    }
  }

  const lines: string[] = [];
  for (const line of readFileSync(inboxPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: { msg_id?: number | string; ts?: string; text?: string };
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // torn line — skip
    }
    if (row.msg_id === undefined) continue;
    const id = String(row.msg_id);
    if (routed.has(id) || triaged.has(id)) continue;
    const ts = row.ts ?? "";
    const text = (row.text ?? "").replace(/\s+/g, " ").trim();
    lines.push(`- msg ${id} (${ts}): ${text}`);
  }
  return lines;
}

// Binding docs whose audience reaches the orchestrator, in stable id order.
function collectOrchestratorBindingDocs(docs: InstructionDoc[]): InstructionDoc[] {
  return docs
    .filter(
      (doc) =>
        doc.valid &&
        doc.valid.status === "binding" &&
        admitsAudience(SESSION_ROLE, doc.valid.audience),
    )
    .sort((a, b) => a.valid!.id.localeCompare(b.valid!.id));
}

// Assembles the SessionStart load for a repo. Pure over the filesystem; no
// git, no clock. `repo` is the repository root.
export function collectSessionLoad(repo: string): SessionLoad {
  const root = resolve(repo);
  const decisionsDir = join(root, "instance", "decisions");
  const instructionsRoot = join(root, "instructions");

  const sections: SessionSection[] = [];
  const degradedReasons: string[] = [];

  // Repository identity is observed at load time. A failed probe or dirty tree
  // is explicit and degrades the startup verdict.
  const repository = gitProbe(root);
  sections.push({ title: "Repository state", lines: repository.lines });
  if (repository.degradedReason) degradedReasons.push(repository.degradedReason);

  // 1. params.yaml
  const params = readIfExists(join(root, "instance", "params.yaml"));
  sections.push({
    title: "instance/params.yaml",
    lines: params !== undefined ? trimTrailing(params) : ["(absent)"],
  });

  // 2. Open ledger rows: pending HR files + untriaged inbox rows.
  const pending = collectPendingHr(decisionsDir);
  const ledgerLines: string[] = [];
  if (pending.length === 0) {
    ledgerLines.push("(no pending HR rows)");
  } else {
    for (const hr of pending) {
      ledgerLines.push(`<!-- ${hr.name} -->`);
      ledgerLines.push(...trimTrailing(hr.contents));
      ledgerLines.push("");
    }
  }
  const untriaged = collectUntriagedInbox(decisionsDir);
  ledgerLines.push("### Untriaged inbound (inbox.jsonl)");
  if (untriaged.length === 0) {
    ledgerLines.push("(none)");
  } else {
    ledgerLines.push(...untriaged);
  }
  sections.push({ title: "Open decisions-ledger rows", lines: ledgerLines });

  // 3. Latest durable vendor/session handoff. Absence is an explicit degraded
  // start warning, never silent optimism.
  const handoffPath = latestHandoffPath(root);
  sections.push({
    title: "Latest orchestrator handoff",
    lines: handoffPath
      ? [`<!-- ${handoffPath.slice(root.length + 1)} -->`, ...trimTrailing(readFileSync(handoffPath, "utf8"))]
      : ["WARNING: no handoff found — degraded start"],
  });
  if (!handoffPath) degradedReasons.push("no handoff found");

  // 4. Durable mission/lane/lease truth, projected from the same SQLite source
  // as `core/mission-cli.ts status`. Missing or unreadable state is unknown,
  // never an invented empty set.
  const durableState = durableStateProbe(root);
  sections.push({ title: "Durable mission / lane / lease state", lines: durableState.lines });
  if (durableState.degradedReason) degradedReasons.push(durableState.degradedReason);

  // 5. Orchestrator-audience binding docs, as one-line summaries (id + summary
  // + path). Full bodies are delivered on demand by compose; this is the
  // always-on standing index, kept small by construction.
  const docs = existsSync(instructionsRoot) ? collectDocs(instructionsRoot) : [];
  const bindingDocs = collectOrchestratorBindingDocs(docs);
  const docLines: string[] = [];
  if (bindingDocs.length === 0) {
    docLines.push("(no orchestrator binding docs)");
  } else {
    for (const doc of bindingDocs) {
      docLines.push(`- ${doc.valid!.id}: ${doc.valid!.summary}  (${doc.relative})`);
    }
  }
  sections.push({ title: "Orchestrator binding instructions (index)", lines: docLines });
  sections.push({
    title: "Startup verdict",
    lines: [
      degradedReasons.length === 0
        ? "startup: ready"
        : `startup: degraded (${degradedReasons.join("; ")})`,
    ],
  });

  const text = renderText(sections);
  return { sections, text, lineCount: text.split("\n").length };
}

function renderText(sections: SessionSection[]): string {
  const out: string[] = [];
  out.push("# SessionStart Load (orchestrator)");
  out.push("");
  out.push(
    "Standing context loaded on session start: instance parameters, open " +
      "directives (interim-binding), and orchestrator-audience binding law. " +
      "This set is line-capped by tools/instructions/check.ts.",
  );
  out.push("");
  for (const section of sections) {
    out.push(`## ${section.title}`);
    out.push("");
    out.push(...section.lines);
    out.push("");
  }
  return out.join("\n") + "\n";
}

export function renderSessionLoad(repo: string): string {
  return collectSessionLoad(repo).text;
}

// Line-count budget for the SessionStart load (§2.3 "small by construction").
// FAIL above the hard cap; WARN in the head-room band below it, so growth is
// visible one landing before it becomes a failure. Overridable via env for
// tests only (SESSION_LOAD_FAIL_LINES / SESSION_LOAD_WARN_LINES).
export const SESSION_LOAD_FAIL_LINES = 600;
export const SESSION_LOAD_WARN_LINES = 500;

export type SessionLoadLevel = "PASS" | "WARN" | "FAIL" | "SKIP";
export type SessionLoadFinding = { level: SessionLoadLevel; file: string; detail: string };

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return fallback;
}

// The [session-load] checker: caps the total line count of the orchestrator
// SessionStart load. Returns a single finding. A repo without instance/ or
// instructions/ still produces a load (mostly "(absent)"/"(no ...)" lines) and
// is well under budget, so this never spuriously SKIPs — it always reports the
// measured size, which is the point (the cap must bite as the corpus grows).
export function runSessionLoadCheck(repo: string): SessionLoadFinding {
  const failAt = envInt("SESSION_LOAD_FAIL_LINES", SESSION_LOAD_FAIL_LINES);
  const warnAt = envInt("SESSION_LOAD_WARN_LINES", SESSION_LOAD_WARN_LINES);
  const { lineCount } = collectSessionLoad(repo);
  const where = "repo + instance/params.yaml + ledger + latest handoff + durable state + orchestrator binding docs + verdict";
  if (lineCount > failAt) {
    return {
      level: "FAIL",
      file: "session-load",
      detail: `SessionStart load is ${lineCount} lines, over the ${failAt}-line cap (${where}) — demote a doc to a summary`,
    };
  }
  if (lineCount > warnAt) {
    return {
      level: "WARN",
      file: "session-load",
      detail: `SessionStart load is ${lineCount} lines, over the ${warnAt}-line head-room band (cap ${failAt}) — plan a demotion`,
    };
  }
  return {
    level: "PASS",
    file: "session-load",
    detail: `SessionStart load is ${lineCount} lines (cap ${failAt}, warn ${warnAt})`,
  };
}

type Options = { repo: string };

function usage(exitCode: number): never {
  const output = exitCode === 0 ? process.stdout : process.stderr;
  output.write(
    [
      "Usage: bun tools/instructions/session-load.ts [--repo <path>]",
      "",
      "Prints the orchestrator SessionStart load: instance/params.yaml, open",
      "decisions-ledger rows (pending HR + untriaged inbox), and every",
      "orchestrator-audience binding instruction, in full.",
      "",
      "  --repo <path>   Repository root (default: current directory).",
      "  -h, --help      Show this usage.",
      "",
    ].join("\n"),
  );
  process.exit(exitCode);
}

function parseArgs(args: string[]): Options {
  const options: Options = { repo: process.cwd() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") usage(0);
    if (arg === "--repo") {
      const value = args[++index];
      if (!value || value.startsWith("--")) usage(2);
      options.repo = value;
      continue;
    }
    usage(2);
  }
  return options;
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  process.stdout.write(renderSessionLoad(options.repo));
}
