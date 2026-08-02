import { Database } from "bun:sqlite";

export const missionStates = ["queued", "running", "recovering", "succeeded", "failed"] as const;
export type MissionState = (typeof missionStates)[number];
export type LaneState = "queued" | "running" | "succeeded" | "failed";

export type Mission = {
  id: string;
  correlationId: string;
  state: MissionState;
  createdAt: number;
  updatedAt: number;
};

export type Lane = {
  id: string;
  missionId: string;
  state: LaneState;
  createdAt: number;
  updatedAt: number;
};

export type Lease = {
  key: string;
  owner: string;
  fencingToken: number;
  expiresAt: number;
};

export type TickJournalKind = "cause" | "missed-tick";
export type TickJournalInput = { intervalId: string; causeId: string; kind: TickJournalKind; observedAt: number };
export type TickJournalRecord = TickJournalInput & { sequence: number; createdAt: number };
export type IntervalAccounting = {
  verdict: "clean" | "NO-GO";
  measurement: "MEASURED" | "UNMEASURED";
  rows: Array<{ intervalId: string; record: TickJournalRecord | null }>;
  unknownIntervalIds: string[];
};

export class StateError extends Error {}
export class LeaseHeldError extends StateError {}
export class FencedLeaseError extends StateError {}

const missionTransitions: Record<MissionState, readonly MissionState[]> = {
  queued: ["running", "failed"],
  running: ["recovering", "succeeded", "failed"],
  recovering: ["queued", "running", "failed"],
  succeeded: [],
  failed: [],
};

const laneTransitions: Record<LaneState, readonly LaneState[]> = {
  queued: ["running", "failed"],
  running: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

type Options = { now?: () => number };

/**
 * Durable SQLite state. Every multi-statement mutation runs under BEGIN
 * IMMEDIATE, so a fencing token is allocated by the same writer that owns it.
 */
export class StateStore {
  readonly db: Database;
  private readonly now: () => number;

  constructor(path = process.env.BPA_STATE_DB_PATH ?? process.env.STATE_DB_PATH ?? "state.sqlite", options: Options = {}) {
    if (!path) throw new StateError("BPA_STATE_DB_PATH must name a SQLite file");
    this.db = new Database(path, { create: true, strict: true });
    this.now = options.now ?? Date.now;
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  createMission(id: string, correlationId: string): Mission {
    this.nonEmpty(id, "mission id");
    this.nonEmpty(correlationId, "correlation id");
    const at = this.now();
    return this.transaction(() => {
      try {
        this.db.query("INSERT INTO missions (id, correlation_id, state, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)").run(id, correlationId, at, at);
      } catch (error) {
        throw new StateError(`mission already exists: ${id}`, { cause: error });
      }
      const mission = { id, correlationId, state: "queued" as const, createdAt: at, updatedAt: at };
      this.audit("mission.created", "mission", id, mission, at);
      return mission;
    });
  }

  transitionMission(id: string, state: MissionState): Mission {
    this.nonEmpty(id, "mission id");
    if (!missionStates.includes(state)) throw new StateError(`unknown mission state: ${state}`);
    return this.transaction(() => {
      const previous = this.mission(id);
      if (!previous) throw new StateError(`unknown mission: ${id}`);
      if (!missionTransitions[previous.state].includes(state)) {
        throw new StateError(`invalid mission transition: ${previous.state} -> ${state}`);
      }
      if (state === "succeeded") {
        const incomplete = this.db.query("SELECT COUNT(*) AS count FROM lanes WHERE mission_id = ? AND state != 'succeeded'").get(id) as { count: number };
        if (incomplete.count > 0) {
          throw new StateError(`mission has running or failed child lanes: ${id}`);
        }
      }
      const at = this.now();
      this.db.query("UPDATE missions SET state = ?, updated_at = ? WHERE id = ?").run(state, at, id);
      const mission = { ...previous, state, updatedAt: at };
      this.audit("mission.transitioned", "mission", id, { from: previous.state, to: state }, at);
      return mission;
    });
  }

  createLane(id: string, missionId: string): Lane {
    this.nonEmpty(id, "lane id");
    this.nonEmpty(missionId, "mission id");
    const at = this.now();
    return this.transaction(() => {
      const mission = this.mission(missionId);
      if (!mission) throw new StateError(`unknown mission: ${missionId}`);
      if (mission.state === "succeeded" || mission.state === "failed") {
        throw new StateError(`cannot create lane for terminal mission: ${missionId}`);
      }
      try {
        this.db.query("INSERT INTO lanes (id, mission_id, state, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)").run(id, missionId, at, at);
      } catch (error) {
        throw new StateError(`lane already exists: ${id}`, { cause: error });
      }
      const lane = { id, missionId, state: "queued" as const, createdAt: at, updatedAt: at };
      this.audit("lane.created", "lane", id, lane, at);
      return lane;
    });
  }

  transitionLane(id: string, state: LaneState): Lane {
    return this.transaction(() => {
      const lane = this.lane(id);
      if (!lane) throw new StateError(`unknown lane: ${id}`);
      if (!laneTransitions[lane.state].includes(state)) throw new StateError(`invalid lane transition: ${lane.state} -> ${state}`);
      const at = this.now();
      this.db.query("UPDATE lanes SET state = ?, updated_at = ? WHERE id = ?").run(state, at, id);
      const next = { ...lane, state, updatedAt: at };
      this.audit("lane.transitioned", "lane", id, { from: lane.state, to: state }, at);
      return next;
    });
  }

  acquireLease(owner: string, key: string, ttlMs: number): { fencingToken: number } {
    this.nonEmpty(owner, "lease owner");
    this.nonEmpty(key, "lease key");
    this.positive(ttlMs, "lease ttl");
    return this.transaction(() => {
      const at = this.now();
      const current = this.lease(key);
      if (current && current.expiresAt > at) throw new LeaseHeldError(`lease is live for key: ${key}`);
      const fencingToken = (this.db.query("SELECT COALESCE(MAX(fencing_token), 0) AS token FROM leases WHERE lease_key = ?").get(key) as { token: number }).token + 1;
      this.db.query("INSERT INTO leases (lease_key, owner, fencing_token, expires_at, released_at) VALUES (?, ?, ?, ?, NULL)").run(key, owner, fencingToken, at + ttlMs);
      this.audit("lease.acquired", "lease", key, { owner, fencingToken, expiresAt: at + ttlMs }, at);
      return { fencingToken };
    });
  }

  renewLease(owner: string, key: string, fencingToken: number, ttlMs: number): void {
    this.nonEmpty(owner, "lease owner"); this.nonEmpty(key, "lease key"); this.positive(fencingToken, "fencing token"); this.positive(ttlMs, "lease ttl");
    this.transaction(() => {
      const at = this.now();
      const changed = this.db.query("UPDATE leases SET expires_at = ? WHERE lease_key = ? AND owner = ? AND fencing_token = ? AND released_at IS NULL AND expires_at > ?").run(at + ttlMs, key, owner, fencingToken, at).changes;
      if (changed !== 1) throw new FencedLeaseError(`lease is stale or not owned: ${key}`);
      this.audit("lease.renewed", "lease", key, { owner, fencingToken, expiresAt: at + ttlMs }, at);
    });
  }

  releaseLease(owner: string, key: string, fencingToken: number): void {
    this.nonEmpty(owner, "lease owner"); this.nonEmpty(key, "lease key"); this.positive(fencingToken, "fencing token");
    this.transaction(() => {
      const at = this.now();
      const changed = this.db.query("UPDATE leases SET released_at = ? WHERE lease_key = ? AND owner = ? AND fencing_token = ? AND released_at IS NULL").run(at, key, owner, fencingToken).changes;
      if (changed !== 1) throw new FencedLeaseError(`lease is stale or not owned: ${key}`);
      this.audit("lease.released", "lease", key, { owner, fencingToken }, at);
    });
  }

  reapExpiredLeases(): Lease[] {
    return this.transaction(() => {
      const at = this.now();
      const expired = this.db.query("SELECT lease_key, owner, fencing_token, expires_at FROM leases WHERE released_at IS NULL AND expires_at <= ? ORDER BY id").all(at) as Array<{ lease_key: string; owner: string; fencing_token: number; expires_at: number }>;
      for (const lease of expired) {
        this.db.query("UPDATE leases SET released_at = ? WHERE lease_key = ? AND fencing_token = ? AND released_at IS NULL").run(at, lease.lease_key, lease.fencing_token);
        this.audit("lease.reaped", "lease", lease.lease_key, { owner: lease.owner, fencingToken: lease.fencing_token }, at);
      }
      return expired.map((lease) => ({ key: lease.lease_key, owner: lease.owner, fencingToken: lease.fencing_token, expiresAt: lease.expires_at }));
    });
  }

  listActive(): Lease[] {
    const at = this.now();
    return (this.db.query("SELECT lease_key, owner, fencing_token, expires_at FROM leases WHERE released_at IS NULL AND expires_at > ? ORDER BY lease_key, fencing_token").all(at) as Array<{ lease_key: string; owner: string; fencing_token: number; expires_at: number }>).map((lease) => ({ key: lease.lease_key, owner: lease.owner, fencingToken: lease.fencing_token, expiresAt: lease.expires_at }));
  }

  listEvents(): Array<{ id: number; kind: string; entityType: string; entityId: string; data: unknown; createdAt: number }> {
    return (this.db.query("SELECT id, kind, entity_type, entity_id, data_json, created_at FROM events ORDER BY id").all() as Array<{ id: number; kind: string; entity_type: string; entity_id: string; data_json: string; created_at: number }>).map((row) => ({ id: row.id, kind: row.kind, entityType: row.entity_type, entityId: row.entity_id, data: JSON.parse(row.data_json), createdAt: row.created_at }));
  }

  appendTickJournal(input: TickJournalInput): TickJournalRecord {
    this.nonEmpty(input.intervalId, "interval id");
    this.nonEmpty(input.causeId, "cause id");
    if (input.kind !== "cause" && input.kind !== "missed-tick") throw new StateError("invalid tick journal kind");
    if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) throw new StateError("observed at must be a non-negative integer");
    return this.transaction(() => {
      this.db.query(`INSERT INTO tick_journal (interval_id, cause_id, kind, observed_at, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(interval_id, cause_id, kind) DO NOTHING`).run(
          input.intervalId, input.causeId, input.kind, input.observedAt, this.now(),
        );
      return this.tickJournal().find((row) => row.intervalId === input.intervalId && row.causeId === input.causeId && row.kind === input.kind)!;
    });
  }

  tickJournal(): TickJournalRecord[] {
    return (this.db.query("SELECT sequence, interval_id, cause_id, kind, observed_at, created_at FROM tick_journal ORDER BY sequence").all() as Array<{
      sequence: number; interval_id: string; cause_id: string; kind: TickJournalKind; observed_at: number; created_at: number;
    }>).map((row) => ({
      sequence: row.sequence, intervalId: row.interval_id, causeId: row.cause_id,
      kind: row.kind, observedAt: row.observed_at, createdAt: row.created_at,
    }));
  }

  accountMissedTicks(expectedIntervalIds: string[]): IntervalAccounting {
    if (new Set(expectedIntervalIds).size !== expectedIntervalIds.length || expectedIntervalIds.some((id) => !id)) {
      throw new StateError("expected interval ids must be non-empty and unique");
    }
    const missed = this.tickJournal().filter((row) => row.kind === "missed-tick");
    const expected = new Set(expectedIntervalIds);
    const unknownIntervalIds = [...new Set(missed.filter((row) => !expected.has(row.intervalId)).map((row) => row.intervalId))].sort();
    const rows = expectedIntervalIds.map((intervalId) => {
      const matches = missed.filter((row) => row.intervalId === intervalId);
      return { intervalId, record: matches.length === 1 ? matches[0] : null };
    });
    const measured = unknownIntervalIds.length === 0 && rows.every((row) => row.record !== null);
    return { verdict: measured ? "clean" : "NO-GO", measurement: measured ? "MEASURED" : "UNMEASURED", rows, unknownIntervalIds };
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id INTEGER PRIMARY KEY, lease_key TEXT NOT NULL, owner TEXT NOT NULL, fencing_token INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER, UNIQUE(lease_key, fencing_token));
      CREATE INDEX IF NOT EXISTS leases_current_idx ON leases(lease_key, released_at, expires_at);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tick_journal (sequence INTEGER PRIMARY KEY, interval_id TEXT NOT NULL, cause_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('cause','missed-tick')), observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(interval_id, cause_id, kind));
      CREATE TRIGGER IF NOT EXISTS tick_journal_no_update BEFORE UPDATE ON tick_journal BEGIN SELECT RAISE(ABORT, 'tick journal is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS tick_journal_no_delete BEFORE DELETE ON tick_journal BEGIN SELECT RAISE(ABORT, 'tick journal is append-only'); END;
    `);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private audit(kind: string, entityType: string, entityId: string, data: unknown, at: number): void {
    this.db.query("INSERT INTO events (kind, entity_type, entity_id, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(kind, entityType, entityId, JSON.stringify(data), at);
  }
  private mission(id: string): Mission | undefined {
    const row = this.db.query("SELECT id, correlation_id, state, created_at, updated_at FROM missions WHERE id = ?").get(id) as { id: string; correlation_id: string; state: MissionState; created_at: number; updated_at: number } | null;
    return row ? { id: row.id, correlationId: row.correlation_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }
  private lane(id: string): Lane | undefined {
    const row = this.db.query("SELECT id, mission_id, state, created_at, updated_at FROM lanes WHERE id = ?").get(id) as { id: string; mission_id: string; state: LaneState; created_at: number; updated_at: number } | null;
    return row ? { id: row.id, missionId: row.mission_id, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }
  private lease(key: string): Lease | undefined {
    const row = this.db.query("SELECT lease_key, owner, fencing_token, expires_at FROM leases WHERE lease_key = ? AND released_at IS NULL ORDER BY fencing_token DESC LIMIT 1").get(key) as { lease_key: string; owner: string; fencing_token: number; expires_at: number } | null;
    return row ? { key: row.lease_key, owner: row.owner, fencingToken: row.fencing_token, expiresAt: row.expires_at } : undefined;
  }
  private nonEmpty(value: string, label: string): void { if (!value) throw new StateError(`${label} must be non-empty`); }
  private positive(value: number, label: string): void { if (!Number.isFinite(value) || value <= 0) throw new StateError(`${label} must be positive`); }
}
