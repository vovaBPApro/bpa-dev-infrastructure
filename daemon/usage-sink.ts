/**
 * The accounting sink. V3-3.10, instance/specs/token-usage-accounting.md.
 *
 * Its entire contract is in the spec's rollback posture: **a failure to record
 * consumption is never allowed to fail a lane.** This module therefore throws
 * for no reason at all. A locked database, an absent state file, a schema older
 * than this code -- each is reported on stderr, where it lands in the lane log
 * and stays visible, and then the lane carries on and is judged on its own work.
 *
 * Silence is not one of the options. An accounting path that fails quietly
 * produces the same graph as one that was never called, and the operator would
 * have no way to tell the difference.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DurableStore, type UsageEventInput } from "../core/state";
import { stateDbPath } from "../core/state-path";

export type SinkResult = { recorded: number; duplicates: number; error?: string };

export function recordUsageRows(rows: UsageEventInput[], options: { dbPath?: string } = {}): SinkResult {
  if (rows.length === 0) return { recorded: 0, duplicates: 0 };
  const database = options.dbPath ?? stateDbPath(resolve(import.meta.dir, ".."));
  let store: DurableStore | undefined;
  try {
    mkdirSync(dirname(database), { recursive: true });
    store = new DurableStore(database);
    let recorded = 0; let duplicates = 0;
    for (const row of rows) {
      // Per row, so one rejected row cannot discard the others. A row that
      // breaks the never-zero constraint is the one thing worth losing.
      try { store.recordUsage(row) ? recorded++ : duplicates++; }
      catch (error) { warn(`row rejected: ${message(error)}`); }
    }
    return { recorded, duplicates };
  } catch (error) {
    warn(`sink unavailable (${database}): ${message(error)}`);
    return { recorded: 0, duplicates: 0, error: message(error) };
  } finally {
    try { store?.close(); } catch { /* a close failure has nothing left to protect */ }
  }
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const warn = (detail: string): void => { process.stderr.write(`WARN usage-accounting ${detail}\n`); };
