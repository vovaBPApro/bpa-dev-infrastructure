#!/usr/bin/env bun
/**
 * The orchestrator's own consumption. V3-3.10, instance/specs/token-usage-
 * accounting.md: "the orchestrator's own consumption counts too: it is a role
 * (`orchestrator`) and it is currently the largest single spender. A design
 * that only measures lanes would answer the wrong question."
 *
 * Lanes are measured at the point of use, because a lane is `claude --print`
 * behind a pipe this repository owns (daemon/mask-stream.ts). The orchestrator
 * is not: orchestrator/launch.sh execs an INTERACTIVE `claude` inside a tmux
 * pane, so there is no `--print`, no `--output-format`, and no result event to
 * intercept. Its consumption is nonetheless machine-readable on this host --
 * the CLI writes a session transcript per project under
 * ~/.claude/projects/<slug>/<session>.jsonl, and every assistant record in it
 * carries the model and the usage block. This reads those.
 *
 * What this source does NOT carry is cost. The transcript records tokens and no
 * `total_cost_usd`, so `cost_usd` stays NULL on these rows. Multiplying tokens
 * by a hand-kept price table would put an invented number in the same column as
 * the CLI's own figures and nothing downstream could tell the two apart; a null
 * says "not observed here", which is true and is the rule this row was built on.
 *
 * Idempotent by construction: rows are keyed by (session, message id, model)
 * and re-inserting one is a no-op, so this can be re-run over the same
 * transcripts as often as it likes without doubling the bill.
 *
 *   bun daemon/usage-ingest-transcripts.ts --cwd /root/bpa-dev-infrastructure \
 *     --role orchestrator --since 2026-08-05T00:00:00Z
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DurableStore, type UsageEventInput, type UsageRole } from "../core/state";
import { stateDbPath } from "../core/state-path";

type Options = {
  projectDirs: string[]; role: UsageRole; since?: number; until?: number;
  entrypoints: string[] | null; dbPath?: string; dryRun: boolean;
};

/** The CLI's own project-directory naming: every `/` and `.` in the absolute
 * working directory becomes `-`. Derived rather than hard-coded so this stays
 * a generic mechanism instead of a fact about one installation's paths. */
export function transcriptDirFor(cwd: string, root = join(homedir(), ".claude", "projects")): string {
  return join(root, resolve(cwd).replace(/[/.]/g, "-"));
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    projectDirs: [], role: "orchestrator", entrypoints: ["cli"], dryRun: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--cwd") { options.projectDirs.push(transcriptDirFor(required(value, flag))); index++; continue; }
    if (flag === "--project-dir") { options.projectDirs.push(required(value, flag)); index++; continue; }
    if (flag === "--role") { options.role = role(required(value, flag)); index++; continue; }
    if (flag === "--since") { options.since = instant(required(value, flag), flag); index++; continue; }
    if (flag === "--until") { options.until = instant(required(value, flag), flag); index++; continue; }
    if (flag === "--db") { options.dbPath = required(value, flag); index++; continue; }
    // The default excludes `sdk-cli`, which is what `claude --print` records
    // itself as. Lanes are already measured by the masker at the point of use,
    // and ingesting their transcripts too would count every lane twice --
    // silently, and in the direction that flatters nobody.
    if (flag === "--entrypoint") { options.entrypoints = required(value, flag).split(",").map((entry) => entry.trim()).filter(Boolean); index++; continue; }
    if (flag === "--any-entrypoint") { options.entrypoints = null; continue; }
    if (flag === "--dry-run") { options.dryRun = true; continue; }
    throw new Error(`unknown flag: ${flag}`);
  }
  if (options.projectDirs.length === 0) throw new Error("at least one --cwd or --project-dir is required");
  return options;
}

const required = (value: string | undefined, flag: string): string => {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
};
const role = (value: string): UsageRole => {
  if (!["coder", "reviewer", "orchestrator", "manager"].includes(value)) throw new Error(`--role must be coder, reviewer, orchestrator or manager; got ${value}`);
  return value as UsageRole;
};
const instant = (value: string, flag: string): number => {
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be an ISO-8601 instant or epoch milliseconds`);
  return parsed;
};

function count(usage: Record<string, unknown> | undefined, key: string): number | null {
  const value = usage?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Usage rows for one transcript file.
 *
 * A single API response appears in the transcript as SEVERAL assistant records
 * when it carries more than one content block -- 335 of 633 message ids in the
 * orchestrator's own transcript on 2026-08-05 -- and each of those records
 * repeats the same usage block. Summing the records would therefore multiply
 * the orchestrator's spend by the number of blocks it happened to emit, so they
 * are collapsed to one row per message id here. The database's unique index
 * enforces the same thing across runs; this makes it true within a run too.
 */
export function rowsFromTranscript(contents: string, options: Pick<Options, "role" | "since" | "until" | "entrypoints">): { rows: UsageEventInput[]; skipped: number } {
  const byMessage = new Map<string, UsageEventInput>();
  let skipped = 0;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { skipped++; continue; }
    if (record?.type !== "assistant" || typeof record.message !== "object" || record.message === null) continue;
    if (options.entrypoints && !options.entrypoints.includes(record.entrypoint)) continue;
    // `<synthetic>` is the CLI's own marker for a message it produced locally --
    // an interrupt notice, a harness error -- with no API call behind it. Six of
    // them appear in the orchestrator's transcripts, all with zero counts.
    // Recording them would invent a model on the graph that nobody can buy, and
    // it is the one case where a zero here is real rather than unobserved.
    if (record.message.model === "<synthetic>") { skipped++; continue; }
    const model = typeof record.message.model === "string" ? record.message.model : null;
    const messageId = typeof record.message.id === "string" ? record.message.id : null;
    const usage = typeof record.message.usage === "object" && record.message.usage !== null ? record.message.usage : undefined;
    const inputTokens = count(usage, "input_tokens");
    const outputTokens = count(usage, "output_tokens");
    if (model === null || messageId === null || inputTokens === null || outputTokens === null) { skipped++; continue; }
    const observedAt = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(observedAt)) { skipped++; continue; }
    if (options.since !== undefined && observedAt < options.since) continue;
    if (options.until !== undefined && observedAt >= options.until) continue;

    const row: UsageEventInput = {
      model, role: options.role, lane: null, itemId: null,
      inputTokens, outputTokens,
      cacheCreationInputTokens: count(usage, "cache_creation_input_tokens"),
      cacheReadInputTokens: count(usage, "cache_read_input_tokens"),
      // Not in this source. Never guessed.
      costUsd: null,
      serviceTier: typeof usage?.service_tier === "string" ? usage.service_tier : null,
      sessionId: record.sessionId ?? record.session_id ?? null,
      eventId: messageId, source: "cli-json", observedAt,
    };
    const seen = byMessage.get(messageId);
    // Keep the fullest report of the same response: a record written mid-stream
    // can carry a partial output count, and the largest is the completed one.
    if (!seen || (seen.outputTokens ?? 0) < outputTokens) byMessage.set(messageId, row);
  }
  return { rows: [...byMessage.values()], skipped };
}

function transcripts(dir: string): string[] {
  try { if (!statSync(dir).isDirectory()) return []; } catch { return []; }
  return readdirSync(dir).filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(dir, entry)).sort();
}

if (import.meta.main) {
  const options = parseArgs(Bun.argv.slice(2));
  const database = options.dbPath ?? stateDbPath(resolve(import.meta.dir, ".."));
  const store = options.dryRun ? null : new DurableStore(database);
  let files = 0; let recorded = 0; let duplicates = 0; let skipped = 0; let candidates = 0;
  try {
    for (const dir of options.projectDirs) {
      for (const file of transcripts(dir)) {
        files++;
        const parsed = rowsFromTranscript(readFileSync(file, "utf8"), options);
        skipped += parsed.skipped;
        candidates += parsed.rows.length;
        for (const row of parsed.rows) {
          if (!store) continue;
          try { store.recordUsage(row) ? recorded++ : duplicates++; }
          catch (error) { skipped++; process.stderr.write(`WARN usage-ingest row rejected: ${error instanceof Error ? error.message : String(error)}\n`); }
        }
      }
    }
  } finally { store?.close(); }
  console.log(`USAGE-INGEST files=${files} candidates=${candidates} recorded=${recorded} duplicates=${duplicates} skipped=${skipped} role=${options.role} db=${options.dryRun ? "(dry-run)" : database}`);
}
