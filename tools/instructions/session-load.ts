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
//      every HR row not provably closed (pending/owed/stateless), plus untriaged
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
import { capturedMsgIds, hrDisposition, isHrOpen, parseHrFields } from "./ledger.ts";
import { instanceInputVerdict, type CheckLevel } from "./outcome.ts";

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
  // Standing-context inputs that could not be read at all: an absent
  // params.yaml, an absent decisions ledger, an absent instruction corpus.
  // These are UNKNOWN in the checker's vocabulary (outcome.ts) and make the
  // startup verdict a NO-GO — a session that loads without its standing law
  // must say so, not print a shorter load and call itself ready.
  unknown: string[];
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

// Open HR decision files, sorted by filename for stable output.
//
// This predicate used to be `state === "pending"`, an ALLOWLIST that selected
// nothing across the entire real corpus, so no HR file had ever appeared in a
// session load. It is now a BLOCKLIST: everything that is not provably closed
// is delivered -- `pending`, `owed`, and every file whose state is missing or
// outside the vocabulary. Absence of bookkeeping surfaces the requirement
// instead of hiding it, and checkHrStates() fails loudly about it in parallel.
function collectOpenHr(decisionsDir: string): { name: string; contents: string }[] {
  if (!existsSync(decisionsDir)) return [];
  const out: { name: string; contents: string }[] = [];
  for (const entry of readdirSync(decisionsDir).sort()) {
    if (!/^HR-.+\.md$/i.test(entry)) continue;
    const contents = readFileSync(join(decisionsDir, entry), "utf8");
    if (!isHrOpen(contents)) continue;
    out.push({ name: entry, contents });
  }
  return out;
}

// Parked HR files: the `deferred` disposition, which is neither delivered nor
// discharged. Collected separately from collectOpenHr() on purpose — a lane must
// not be handed a row that was set aside deliberately, but nobody may lose count
// of how many were set aside.
function collectParkedHr(decisionsDir: string): { name: string; contents: string }[] {
  if (!existsSync(decisionsDir)) return [];
  const out: { name: string; contents: string }[] = [];
  for (const entry of readdirSync(decisionsDir).sort()) {
    if (!/^HR-.+\.md$/i.test(entry)) continue;
    const contents = readFileSync(join(decisionsDir, entry), "utf8");
    if (hrDisposition(parseHrFields(contents)) !== "deferred") continue;
    out.push({ name: entry, contents });
  }
  return out;
}

// Untriaged inbox rows: inbound msg-ids with no HR-<id>.md and no triage verdict.
// Mirrors the aging check's captured/triaged resolution so the two never disagree
// -- it now calls the shared ledger predicate rather than keeping an inline twin
// of it, which is how the two copies were able to drift into the same trap.
//
// CAPTURED suppresses this list, not DISCHARGED: an HR file proves the message
// was read and recorded, so it is not untriaged. Whether the obligation inside
// was ever discharged is answered by collectOpenHr() above, which now delivers
// it. Previously both questions were answered from the filename, so writing the
// capture file removed the requirement from every list at once.
function collectUntriagedInbox(decisionsDir: string): string[] {
  const inboxPath = join(decisionsDir, "inbox.jsonl");
  if (!existsSync(inboxPath)) return [];

  const captured = capturedMsgIds(decisionsDir);

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
    if (captured.has(id) || triaged.has(id)) continue;
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
  // Absent standing context, kept apart from the degraded probes: a dirty tree
  // or a missing handoff degrades a load that still happened, whereas an absent
  // params.yaml or ledger means part of the standing law was never loaded.
  const unknown: string[] = [];

  // Repository identity is observed at load time. A failed probe or dirty tree
  // is explicit and degrades the startup verdict.
  const repository = gitProbe(root);
  sections.push({ title: "Repository state", lines: repository.lines });
  if (repository.degradedReason) degradedReasons.push(repository.degradedReason);

  // 1. params.yaml. Absence used to render as a bare "(absent)" placeholder and
  // change nothing else, so a session with no installation parameters at all
  // still reported `startup: ready` — the exact silent load this section now
  // refuses to perform.
  const params = readIfExists(join(root, "instance", "params.yaml"));
  let paramLines: string[];
  if (params !== undefined) {
    paramLines = trimTrailing(params);
  } else {
    const verdict = instanceInputVerdict(root, "instance/params.yaml", "this installation's parameters");
    paramLines = [`${verdict.level}: ${verdict.detail}`];
    if (verdict.level === "UNKNOWN") unknown.push("instance/params.yaml absent");
  }
  sections.push({ title: "instance/params.yaml", lines: paramLines });

  // 2. Open ledger rows: open HR files + untriaged inbox rows.
  //
  // Two tiers, because the inversion made this set large and a full dump would
  // blow the line budget this module exists to respect (33 open rows render as
  // ~2600 lines against a 600-line cap). Raising the cap to fit them would
  // weaken the check instead of the content, so the split is by binding force:
  //
  //   `pending` -- interim-binding, overriding nothing yet but binding NOW.
  //                Delivered VERBATIM in full; its exact words are the rule.
  //   every other open row (`owed`, stateless, out-of-vocabulary) -- indexed
  //                one line each: name, state, date and first heading, with the
  //                path to read. Visible and countable, which is the property
  //                that was missing; not inlined, which is what keeps the load
  //                bounded as the backlog drains.
  //
  // The failure being fixed is invisibility, not brevity. An indexed row is on
  // the list; the pre-inversion behaviour put it nowhere at all.
  const open = collectOpenHr(decisionsDir);
  const interim = open.filter((hr) => frontmatterValue(hr.contents, "state") === "pending");
  const indexed = open.filter((hr) => frontmatterValue(hr.contents, "state") !== "pending");
  const ledgerLines: string[] = [];
  // "no open rows" and "no ledger to read" are different claims. The first is a
  // measured empty set; the second is an unread input, and rendering it as the
  // first would tell a starting orchestrator it owes the operator nothing.
  if (!existsSync(decisionsDir)) {
    const verdict = instanceInputVerdict(root, "instance/decisions/", "open Human directives");
    ledgerLines.push(`${verdict.level}: ${verdict.detail}`);
    if (verdict.level === "UNKNOWN") unknown.push("instance/decisions/ absent");
  } else if (open.length === 0) {
    ledgerLines.push("(no open HR rows)");
  }
  for (const hr of interim) {
    ledgerLines.push(`<!-- ${hr.name} -->`);
    ledgerLines.push(...trimTrailing(hr.contents));
    ledgerLines.push("");
  }
  if (indexed.length > 0) {
    ledgerLines.push(`### Open, not provably closed (${indexed.length}) — read the file before acting`);
    for (const hr of indexed) {
      const state = frontmatterValue(hr.contents, "state") ?? "NO-STATE";
      const date = frontmatterValue(hr.contents, "date") ?? "no-date";
      const heading = trimTrailing(hr.contents)
        .find((line) => line.startsWith("# "))
        ?.replace(/^#\s*/, "") ?? "(no heading)";
      ledgerLines.push(`- ${hr.name} [state: ${state}] (${date}) ${heading}`);
    }
    ledgerLines.push("");
  }
  // Parked rows, indexed one line each. They are `deferred`: deliberately not
  // delivered, which is why the count and the review-by date have to be here.
  // Round-2 review finding 5 — `parked` was a quiet hiding place with the lock
  // left open: absent from this load, absent from the pack preamble, and bounded
  // only by a self-chosen date with no ceiling. The horizon is now bounded by
  // the checker (instance/params.yaml: ledger.parked_horizon_days); this is the
  // other half, making the bucket visible rather than merely bounded.
  const parked = collectParkedHr(decisionsDir);
  ledgerLines.push(`### Parked (${parked.length}) — deferred on purpose, not delivered, each bounded by review-by`);
  if (parked.length === 0) {
    ledgerLines.push("(none)");
  } else {
    for (const hr of parked) {
      const reviewBy = frontmatterValue(hr.contents, "review-by") ?? "NO-REVIEW-BY";
      const heading = trimTrailing(hr.contents)
        .find((line) => line.startsWith("# "))
        ?.replace(/^#\s*/, "") ?? "(no heading)";
      ledgerLines.push(`- ${hr.name} [review-by: ${reviewBy}] ${heading}`);
    }
  }
  ledgerLines.push("");

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
  const instructionsPresent = existsSync(instructionsRoot);
  const docs = instructionsPresent ? collectDocs(instructionsRoot) : [];
  const bindingDocs = collectOrchestratorBindingDocs(docs);
  const docLines: string[] = [];
  if (!instructionsPresent) {
    // The corpus is the standing law itself. Its absence is UNKNOWN in every
    // layer — no repo declares that it has no instructions/ directory.
    docLines.push("UNKNOWN: no instructions/ directory — the standing law was not read");
    unknown.push("instructions/ absent");
  } else if (bindingDocs.length === 0) {
    docLines.push("(no orchestrator binding docs)");
  } else {
    for (const doc of bindingDocs) {
      docLines.push(`- ${doc.valid!.id}: ${doc.valid!.summary}  (${doc.relative})`);
    }
  }
  sections.push({ title: "Orchestrator binding instructions (index)", lines: docLines });
  sections.push({ title: "Startup verdict", lines: [startupVerdict(unknown, degradedReasons)] });

  const text = renderText(sections);
  return { sections, text, lineCount: text.split("\n").length, unknown };
}

// The load's own NO-GO decision. UNKNOWN standing context is treated like a
// failure, not like a degradation: a degraded start is a load that happened
// with a flaw (dirty tree, no handoff, unreadable state DB), while an unknown
// one is a load that did not read part of the law it exists to deliver. The two
// are reported in one line so neither can hide behind the other.
function startupVerdict(unknown: string[], degraded: string[]): string {
  if (unknown.length === 0) {
    return degraded.length === 0 ? "startup: ready" : `startup: degraded (${degraded.join("; ")})`;
  }
  const parts = [`unknown: ${unknown.join("; ")}`];
  if (degraded.length > 0) parts.push(`degraded: ${degraded.join("; ")}`);
  return `startup: NO-GO (${parts.join(" | ")})`;
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

// Shared with check.ts, ledger.ts and paths.ts; UNKNOWN included (outcome.ts).
export type SessionLoadLevel = CheckLevel;
export type SessionLoadFinding = { level: SessionLoadLevel; file: string; detail: string };

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return fallback;
}

// The [session-load] checker: caps the total line count of the orchestrator
// SessionStart load. Returns a single finding. In a complete installation it
// always reports the measured size — never SKIPs — which is the point (the cap
// must bite as the corpus grows).
//
// When part of the standing context could not be read, the measurement is
// UNKNOWN rather than PASS. A line count taken over a load that is missing its
// params, its ledger or its corpus measures the wrong thing and always comes in
// comfortably under budget: absence would buy head-room and read as green.
export function runSessionLoadCheck(repo: string): SessionLoadFinding {
  const failAt = envInt("SESSION_LOAD_FAIL_LINES", SESSION_LOAD_FAIL_LINES);
  const warnAt = envInt("SESSION_LOAD_WARN_LINES", SESSION_LOAD_WARN_LINES);
  const { lineCount, unknown } = collectSessionLoad(repo);
  const where = "repo + instance/params.yaml + ledger + latest handoff + durable state + orchestrator binding docs + verdict";
  if (unknown.length > 0) {
    return {
      level: "UNKNOWN",
      file: "session-load",
      detail:
        `SessionStart load is incomplete (${unknown.join("; ")}) — its ${lineCount} lines measure a load that ` +
        "never read part of its standing context, so the budget verdict is not a verdict",
    };
  }
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
      "decisions-ledger rows (open HR + untriaged inbox), and every",
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
  // Exits 0 even on a NO-GO verdict, deliberately. orchestrator/hooks/
  // session-start.sh delivers this text as standing context only when the
  // loader exits 0, and replaces it with a banner otherwise — so exiting
  // non-zero here would WITHHOLD the partial load from the very session that
  // needs to read which part of its context is missing. The NO-GO travels in
  // the verdict line where the orchestrator reads it, and the blocking half is
  // carried by check.ts's [session-load] UNKNOWN finding, which the same hook
  // (and gate/lane-exit.sh, and gate/land.sh) runs with --strict.
  process.stdout.write(renderSessionLoad(options.repo));
}
