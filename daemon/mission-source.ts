// Mission input for the liveness watchdog and /status.
//
// History (the defect this file repairs): the daemon used to read the active
// mission from `~/.claude/orchestrator-missions.json`. That reader migrated to
// this repository intact; its WRITER never did — it lived on the old host. So
// `loadMissionRecord` always returned null, `evaluateStall` always returned
// `idle`, and the operator's dead-orchestrator alarm could not fire. Two halves
// of a contract, each fine in isolation, with nothing checking the seam.
//
// The only mission writer that exists in THIS repository is
// `core/mission-cli.ts` (`mission create` / `mission transition`), which writes
// the `missions` table of the durable SQLite state DB. That is therefore the
// single source of truth, and this module projects it into the `MissionRecord`
// shape `daemon/reliability.ts` already defines. No second copy of mission
// state is created; there is nothing to desynchronise.
//
// The DB is opened READ-ONLY. The daemon is a consumer of mission state and
// must never create, migrate, or mutate the operator's live state DB.
//
// The path resolution order is copied from `tools/instructions/session-load.ts`
// (`durableStateProbe`), which is the established in-repo pattern for reading
// this DB from outside `core/`.

import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MissionRecord } from './reliability';

// `core/state.ts` mission states. `succeeded` and `failed` are terminal, so a
// mission in either state is not work the orchestrator can still be alive for.
// Selecting on these states in SQL (rather than laundering the state string
// through `missionIsActive`) keeps the real state visible in the alert text.
export const ACTIVE_MISSION_STATES = [
  'queued',
  'running',
  'recovering',
] as const;

export type MissionSourceResult =
  | { present: false; path: string; reason: string }
  | {
      present: true;
      path: string;
      mission: MissionRecord | null;
      updatedAt: number | null;
    };

export function resolveStateDbPath(installRoot: string): string {
  return (
    process.env.INFRA_STATE_DB ||
    process.env.ORCH_STATE_DB ||
    join(installRoot, 'runtime', 'state.db')
  );
}

type MissionRow = {
  correlation_id: string;
  state: string;
  created_at: number;
  updated_at: number;
};

function toIso(epochMs: number): string {
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? String(epochMs) : d.toISOString();
}

/**
 * Read the newest non-terminal mission from the durable state DB.
 *
 * Never throws: an absent or unreadable DB is reported as `present: false`
 * with a reason that /status shows verbatim, so a broken mission input is
 * visible instead of silently indistinguishable from "no mission".
 */
export function readActiveMission(path: string): MissionSourceResult {
  if (!path) return { present: false, path, reason: 'no state DB configured' };
  if (!existsSync(path)) {
    return { present: false, path, reason: `no state DB at ${path}` };
  }
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true, strict: true });
    const placeholders = ACTIVE_MISSION_STATES.map(() => '?').join(', ');
    const row = db
      .query(
        `SELECT correlation_id, state, created_at, updated_at
           FROM missions
          WHERE state IN (${placeholders})
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(...ACTIVE_MISSION_STATES) as MissionRow | null;
    if (!row) {
      return { present: true, path, mission: null, updatedAt: null };
    }
    return {
      present: true,
      path,
      mission: {
        desc: row.correlation_id,
        created_at: toIso(row.created_at),
        status: row.state,
      },
      updatedAt: row.updated_at,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { present: false, path, reason: `state DB unreadable: ${message}` };
  } finally {
    db?.close();
  }
}
