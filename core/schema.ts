import { Database } from "bun:sqlite";

export type TerminalVerdict = "clean" | "NO-GO";
export type DeliveryState = "pending" | "failed" | "delivered";
export type LaneState = "ready" | "running" | "clean" | "NO-GO";

export type CreateLaneInput = {
  id: string; missionId: string; managerId: string; parentId: string; depth: number;
  retryBudget: number; acceptanceId: string;
};

export type LaneRecord = CreateLaneInput & {
  state: LaneState; generation: number; leaseOwner: string | null; fencingToken: number;
  leaseDeadlineAt: number | null; retriesUsed: number; acknowledgementAt: number | null;
  semanticProgressAt: number | null; semanticEvidencePath: string | null;
  terminalSha: string | null; terminalReportPath: string | null; terminalVerdict: TerminalVerdict | null;
  createdAt: number; updatedAt: number;
};

export type MissionRecord = {
  id: string; correlationId: string; acceptanceId: string; state: string; createdAt: number; updatedAt: number;
};

export type ManagerRecord = {
  id: string; missionId: string; parentId: string; depth: number; state: string; createdAt: number; updatedAt: number;
};

export type LeaseRecord = {
  key: string; owner: string; fencingToken: number; expiresAt: number;
};

/**
 * How a lease owner is judged when the reaper asks. `unverifiable` is not a
 * synonym for `dead`: it means the question could not be answered, and an
 * unanswered question must never reap a lease (Hard Floor 7).
 */
export type OwnerLiveness = "live" | "dead" | "unverifiable";

export type ReapReport = { reaped: number; live: number; expired: number; unverifiable: number };

export type OutboxRecord = {
  id: string; channel: string; dedupeKey: string; payload: unknown; deliveryState: DeliveryState;
  attempts: number; lastError: string | null; createdAt: number; deliveredAt: number | null;
};

export class SchemaError extends Error {}
export class FencedTransitionError extends SchemaError {}

type Options = { now?: () => number };

/** Public v3 durable contract shared by dispatch, recovery, status and transports. */
export class DurableStore {
  readonly db: Database;
  readonly path: string;
  private readonly now: () => number;

  constructor(path = "v3-state.sqlite", options: Options = {}) {
    if (!path) throw new SchemaError("database path must be non-empty");
    this.path = path;
    this.now = options.now ?? Date.now;
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.initialize();
  }

  close(): void { this.db.close(); }

  createMission(input: { id: string; correlationId: string; acceptanceId: string }): void {
    this.required(input.id, "mission id"); this.required(input.correlationId, "correlation id"); this.required(input.acceptanceId, "acceptance id");
    this.tx(() => this.db.query("INSERT INTO missions VALUES (?, ?, ?, 'queued', ?, ?)").run(input.id, input.correlationId, input.acceptanceId, this.now(), this.now()));
  }

  completeMission(id: string): void {
    this.required(id, "mission id");
    this.tx(() => {
      const mission = this.db.query("SELECT state FROM missions WHERE id=?").get(id) as { state: string } | null;
      if (!mission) throw new SchemaError(`unknown mission: ${id}`);
      if (mission.state === "clean") return;
      const lanes = this.db.query("SELECT id, state FROM lanes WHERE mission_id=? ORDER BY id").all(id) as { id: string; state: string }[];
      if (lanes.length === 0) throw new FencedTransitionError(`mission has no lanes: ${id}`);
      // Name the lanes that block, not just the mission: the operator's next
      // action is to go look at a specific lane, and a reason that omits it
      // sends them to debug the mission row instead.
      const blocking = lanes.filter(({ state }) => state !== "clean");
      if (blocking.length) throw new FencedTransitionError(`mission has non-clean lanes: ${id} (${blocking.map(({ id: lane, state }) => `${lane}=${state}`).join(", ")})`);
      const at = this.now();
      this.db.query("UPDATE managers SET state='clean', updated_at=? WHERE mission_id=?").run(at, id);
      this.db.query("UPDATE missions SET state='clean', updated_at=? WHERE id=?").run(at, id);
    });
  }

  createManager(input: { id: string; missionId: string; parentId: string; depth: number }): void {
    if (input.depth !== 1 || input.parentId !== input.missionId) throw new SchemaError("manager parent/depth must be mission/1");
    this.tx(() => this.db.query("INSERT INTO managers VALUES (?, ?, ?, ?, 'ready', ?, ?)").run(input.id, input.missionId, input.parentId, input.depth, this.now(), this.now()));
  }

  createLane(input: CreateLaneInput): LaneRecord {
    if (input.depth !== 2) throw new SchemaError("lane depth must be 2 tonight");
    if (input.parentId !== input.managerId) throw new SchemaError("lane parent must be its manager");
    if (!Number.isInteger(input.retryBudget) || input.retryBudget < 0) throw new SchemaError("retry budget must be a non-negative integer");
    this.required(input.acceptanceId, "acceptance id");
    // The other half of acquireLease's collision guard, so the shared key space
    // cannot be broken from either side.
    if (this.readLease(input.id)) throw new SchemaError(`lane id collides with a lease key: ${input.id}`);
    this.tx(() => this.db.query(`INSERT INTO lanes
      (id, mission_id, manager_id, parent_id, depth, state, generation, fencing_token, retries_used, retry_budget, acceptance_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', 0, 0, 0, ?, ?, ?, ?)`).run(input.id, input.missionId, input.managerId, input.parentId, input.depth, input.retryBudget, input.acceptanceId, this.now(), this.now()));
    return this.mustLane(input.id);
  }

  claimLane(id: string, owner: string, leaseMs: number): { fencingToken: number; deadlineAt: number } {
    this.required(owner, "lease owner");
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new SchemaError("lease duration must be positive");
    return this.tx(() => {
      const lane = this.mustLane(id); const at = this.now();
      if (lane.terminalVerdict) throw new FencedTransitionError(`lane is terminal: ${id}`);
      if (lane.leaseOwner && lane.leaseDeadlineAt! > at) throw new FencedTransitionError(`lane has a live owner: ${id}`);
      const token = lane.fencingToken + 1;
      const retries = lane.state === "running" ? lane.retriesUsed + 1 : lane.retriesUsed;
      if (retries > lane.retryBudget) throw new FencedTransitionError(`retry budget exhausted: ${id}`);
      const deadline = at + leaseMs;
      this.db.query("UPDATE lanes SET state='running', lease_owner=?, fencing_token=?, lease_deadline_at=?, retries_used=?, updated_at=? WHERE id=?").run(owner, token, deadline, retries, at, id);
      return { fencingToken: token, deadlineAt: deadline };
    });
  }

  acknowledgeLane(id: string, owner: string, token: number): void {
    this.guardedUpdate(id, owner, token, "acknowledgement_at = ?", [this.now()]);
  }

  recordSemanticProgress(id: string, owner: string, token: number, evidencePath: string): void {
    this.required(evidencePath, "semantic evidence path");
    this.guardedUpdate(id, owner, token, "generation = generation + 1, semantic_progress_at = ?, semantic_evidence_path = ?", [this.now(), evidencePath]);
  }

  retryLane(id: string, owner: string, token: number): void {
    this.required(owner, "lease owner");
    this.tx(() => {
      const lane = this.mustLane(id);
      if (lane.retriesUsed >= lane.retryBudget) throw new FencedTransitionError(`retry budget exhausted: ${id}`);
      const at = this.now();
      const changed = this.db.query(`UPDATE lanes SET
        state='ready', generation=generation+1, retries_used=retries_used+1,
        lease_owner=NULL, lease_deadline_at=NULL, acknowledgement_at=NULL,
        semantic_progress_at=NULL, semantic_evidence_path=NULL,
        terminal_sha=NULL, terminal_report_path=NULL, terminal_verdict=NULL,
        updated_at=?
        WHERE id=? AND state='running' AND lease_owner=? AND fencing_token=?
          AND lease_deadline_at>? AND terminal_verdict IS NULL`).run(at, id, owner, token, at).changes;
      if (changed !== 1) throw new FencedTransitionError(`stale or expired lane owner: ${id}`);
    });
  }

  completeLane(id: string, owner: string, token: number, terminal: { sha: string; reportPath: string; verdict: TerminalVerdict }): void {
    if (!/^[0-9a-f]{40,64}$/i.test(terminal.sha)) throw new SchemaError("terminal SHA must be 40-64 hexadecimal characters");
    this.required(terminal.reportPath, "terminal report path");
    if (terminal.verdict !== "clean" && terminal.verdict !== "NO-GO") throw new SchemaError("invalid terminal verdict");
    this.guardedUpdate(id, owner, token, "state = ?, terminal_sha = ?, terminal_report_path = ?, terminal_verdict = ?, lease_owner = NULL, lease_deadline_at = NULL", [terminal.verdict, terminal.sha, terminal.reportPath, terminal.verdict]);
  }

  // ── Named leases ──────────────────────────────────────────────────────────
  // Lane ownership is a COLUMN on the lane it fences. A named lease fences
  // something that is not a lane -- today, the single live orchestrator, keyed
  // `orchestrator` -- so it needs a row of its own. orchestrator/launch.sh and
  // orchestrator/watchdog.sh have called `lease acquire|renew|release` and
  // `reap` since they were written; nothing implemented them, and the launcher
  // died on `unknown action` the moment ordinary lane work created a state DB
  // (instance/incidents/2026-08-04-orchestrator-launcher-unstartable-from-git.md).
  //
  // A lease row is never deleted, only marked released or allowed to expire.
  // That is what makes `fencing_token` a per-key high-water mark: a deleted row
  // would restart tokens at 1, and the same owner re-acquiring after a reap
  // would get its OWN stale token back -- exactly the fence the token exists to
  // provide, silently disarmed. watchdog.sh's reacquire path documents that the
  // token "necessarily changes"; keeping the row is what makes that true.
  //
  // The liveness predicate is `released_at IS NULL AND expires_at > now`, and it
  // is the same one tools/instructions/session-load.ts already queried against
  // this table's column names before the table existed.

  acquireLease(key: string, owner: string, ttlMs: number): LeaseRecord {
    this.required(key, "lease key"); this.required(owner, "lease owner");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new SchemaError("lease duration must be positive");
    return this.tx(() => {
      const at = this.now();
      // Lane ids and lease keys share one namespace in `reconstruct().leases`,
      // and watchdog.sh resolves the orchestrator lease with a `find` on that
      // array. Two rows answering to one key would make that find arbitrary.
      if (this.readLane(key)) throw new SchemaError(`lease key collides with a lane: ${key}`);
      const held = this.readLease(key);
      if (held && held.releasedAt === null && held.expiresAt > at) {
        throw new FencedTransitionError(`lease is held: ${key} owner=${held.owner} token=${held.fencingToken} expires_at=${held.expiresAt}`);
      }
      const token = (held?.fencingToken ?? 0) + 1;
      const expiresAt = at + ttlMs;
      this.db.query(`INSERT INTO leases (lease_key, owner, fencing_token, expires_at, released_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(lease_key) DO UPDATE SET owner=excluded.owner, fencing_token=excluded.fencing_token,
          expires_at=excluded.expires_at, released_at=NULL, updated_at=excluded.updated_at`)
        .run(key, owner, token, expiresAt, at, at);
      return { key, owner, fencingToken: token, expiresAt };
    });
  }

  // An EXPIRED lease cannot be renewed, only re-acquired. watchdog.sh depends on
  // that distinction: a renewal that fails because the lease merely aged out is
  // the common case (the watchdog is its own renewer, so any missed tick expires
  // it), and it classifies that as uncontested self-expiry rather than a hostile
  // takeover. Letting renew resurrect an expired row would erase the difference.
  renewLease(key: string, owner: string, token: number, ttlMs: number): LeaseRecord {
    this.required(key, "lease key"); this.required(owner, "lease owner");
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new SchemaError("lease duration must be positive");
    return this.tx(() => {
      const at = this.now();
      const expiresAt = at + ttlMs;
      const changed = this.db.query(`UPDATE leases SET expires_at=?, updated_at=?
        WHERE lease_key=? AND owner=? AND fencing_token=? AND released_at IS NULL AND expires_at>?`)
        .run(expiresAt, at, key, owner, token, at).changes;
      if (changed !== 1) throw new FencedTransitionError(`stale or expired lease owner: ${key}`);
      return { key, owner, fencingToken: token, expiresAt };
    });
  }

  releaseLease(key: string, owner: string, token: number): void {
    this.required(key, "lease key"); this.required(owner, "lease owner");
    this.tx(() => {
      const at = this.now();
      const changed = this.db.query(`UPDATE leases SET released_at=?, updated_at=?
        WHERE lease_key=? AND owner=? AND fencing_token=? AND released_at IS NULL AND expires_at>?`)
        .run(at, at, key, owner, token, at).changes;
      if (changed !== 1) throw new FencedTransitionError(`stale or expired lease owner: ${key}`);
    });
  }

  /**
   * Release the leases of holders that are provably gone.
   *
   * The only rows this touches are LIVE ones whose owner the caller's probe
   * reports `dead`. An already-expired lease needs no reaper -- every predicate
   * in this store already treats it as gone -- and a `live` or `unverifiable`
   * owner is never reaped, which is the fail-closed half: reaping a lease whose
   * holder is actually running is how two orchestrators end up believing they
   * are the singleton.
   *
   * Lane leases are deliberately out of scope. A lane's ownership is fenced by
   * `lease_deadline_at` at every guarded transition and filtered out of
   * `reconstruct()` once past, so there is nothing for a reaper to clear; the
   * only effect of clearing it early would be to spend a retry from the lane's
   * budget on the reaper's initiative.
   */
  reapLeases(liveness: (owner: string) => OwnerLiveness): ReapReport {
    return this.tx(() => {
      const at = this.now();
      const report: ReapReport = { reaped: 0, live: 0, expired: 0, unverifiable: 0 };
      const rows = this.db.query("SELECT lease_key, owner, expires_at, released_at FROM leases ORDER BY lease_key").all() as any[];
      for (const row of rows) {
        if (row.released_at !== null || row.expires_at <= at) { report.expired++; continue; }
        const verdict = liveness(row.owner);
        if (verdict === "live") { report.live++; continue; }
        if (verdict === "unverifiable") { report.unverifiable++; continue; }
        this.db.query("UPDATE leases SET released_at=?, updated_at=? WHERE lease_key=?").run(at, at, row.lease_key);
        report.reaped++;
      }
      return report;
    });
  }

  getLease(key: string): LeaseRecord | undefined {
    const row = this.readLease(key);
    return row ? { key: row.key, owner: row.owner, fencingToken: row.fencingToken, expiresAt: row.expiresAt } : undefined;
  }

  enqueueOutbox(input: { id: string; channel: string; dedupeKey: string; payload: unknown }): OutboxRecord {
    this.required(input.id, "outbox id"); this.required(input.channel, "outbox channel"); this.required(input.dedupeKey, "outbox dedupe key");
    this.tx(() => this.db.query("INSERT INTO outbox (id, channel, dedupe_key, payload_json, delivery_state, attempts, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)").run(input.id, input.channel, input.dedupeKey, JSON.stringify(input.payload), this.now()));
    return this.outbox().find((row) => row.id === input.id)!;
  }

  markOutboxAttempt(id: string, state: "failed" | "delivered", error?: string): void {
    if (state === "failed" && !error) throw new SchemaError("failed delivery requires an error");
    const at = this.now();
    const changed = this.db.query("UPDATE outbox SET delivery_state=?, attempts=attempts+1, last_error=?, delivered_at=? WHERE id=? AND delivery_state != 'delivered'").run(state, error ?? null, state === "delivered" ? at : null, id).changes;
    if (changed !== 1) throw new SchemaError(`unknown or already delivered outbox row: ${id}`);
  }

  getLane(id: string): LaneRecord | undefined { return this.readLane(id); }
  reconstruct(): { missions: MissionRecord[]; managers: ManagerRecord[]; lanes: LaneRecord[]; leases: LeaseRecord[]; outbox: OutboxRecord[] } {
    const missions = (this.db.query("SELECT * FROM missions ORDER BY id").all() as any[]).map(r => ({
      id:r.id, correlationId:r.correlation_id, acceptanceId:r.acceptance_id, state:r.state, createdAt:r.created_at, updatedAt:r.updated_at,
    }));
    const managers = (this.db.query("SELECT * FROM managers ORDER BY id").all() as any[]).map(r => ({
      id:r.id, missionId:r.mission_id, parentId:r.parent_id, depth:r.depth, state:r.state, createdAt:r.created_at, updatedAt:r.updated_at,
    }));
    const lanes = (this.db.query("SELECT id FROM lanes ORDER BY id").all() as { id: string }[]).map(({ id }) => this.mustLane(id));
    // Named leases first, then lane-derived ones. Both are "who owns what right
    // now", both are filtered to the live ones, and acquireLease refuses a key
    // that names a lane, so the merged array still answers one key once.
    const named = (this.db.query("SELECT lease_key, owner, fencing_token, expires_at FROM leases WHERE released_at IS NULL AND expires_at > ? ORDER BY lease_key").all(this.now()) as any[])
      .map(r => ({ key:r.lease_key, owner:r.owner, fencingToken:r.fencing_token, expiresAt:r.expires_at }));
    return {
      missions,
      managers,
      lanes,
      leases: [...named, ...lanes.filter(lane => lane.terminalVerdict === null && lane.leaseOwner !== null && lane.leaseDeadlineAt !== null && lane.leaseDeadlineAt > this.now()).map(lane => ({
        key:lane.id, owner:lane.leaseOwner!, fencingToken:lane.fencingToken, expiresAt:lane.leaseDeadlineAt!,
      }))],
      outbox: this.outbox(),
    };
  }

  private initialize(): void { this.db.exec(`
    CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, correlation_id TEXT UNIQUE NOT NULL, acceptance_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS managers (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), parent_id TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth=1), state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), manager_id TEXT NOT NULL REFERENCES managers(id), parent_id TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth=2), state TEXT NOT NULL, generation INTEGER NOT NULL, lease_owner TEXT, fencing_token INTEGER NOT NULL, lease_deadline_at INTEGER, retries_used INTEGER NOT NULL, retry_budget INTEGER NOT NULL, acceptance_id TEXT NOT NULL, acknowledgement_at INTEGER, semantic_progress_at INTEGER, semantic_evidence_path TEXT, terminal_sha TEXT, terminal_report_path TEXT, terminal_verdict TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, channel TEXT NOT NULL, dedupe_key TEXT UNIQUE NOT NULL, payload_json TEXT NOT NULL, delivery_state TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER);
    CREATE TABLE IF NOT EXISTS leases (lease_key TEXT PRIMARY KEY, owner TEXT NOT NULL, fencing_token INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `); }

  private readLease(key: string): { key: string; owner: string; fencingToken: number; expiresAt: number; releasedAt: number | null } | undefined {
    const r = this.db.query("SELECT * FROM leases WHERE lease_key=?").get(key) as any;
    return r ? { key: r.lease_key, owner: r.owner, fencingToken: r.fencing_token, expiresAt: r.expires_at, releasedAt: r.released_at } : undefined;
  }

  private guardedUpdate(id: string, owner: string, token: number, setSql: string, values: unknown[]): void {
    this.tx(() => {
      const at = this.now();
      const changed = this.db.query(`UPDATE lanes SET ${setSql}, updated_at=? WHERE id=? AND lease_owner=? AND fencing_token=? AND lease_deadline_at>? AND terminal_verdict IS NULL`).run(...values as any[], at, id, owner, token, at).changes;
      if (changed !== 1) throw new FencedTransitionError(`stale or expired lane owner: ${id}`);
    });
  }
  private readLane(id: string): LaneRecord | undefined {
    const r = this.db.query("SELECT * FROM lanes WHERE id=?").get(id) as any;
    return r ? { id:r.id, missionId:r.mission_id, managerId:r.manager_id, parentId:r.parent_id, depth:r.depth, state:r.state, generation:r.generation, leaseOwner:r.lease_owner, fencingToken:r.fencing_token, leaseDeadlineAt:r.lease_deadline_at, retriesUsed:r.retries_used, retryBudget:r.retry_budget, acceptanceId:r.acceptance_id, acknowledgementAt:r.acknowledgement_at, semanticProgressAt:r.semantic_progress_at, semanticEvidencePath:r.semantic_evidence_path, terminalSha:r.terminal_sha, terminalReportPath:r.terminal_report_path, terminalVerdict:r.terminal_verdict, createdAt:r.created_at, updatedAt:r.updated_at } : undefined;
  }
  private mustLane(id: string): LaneRecord { const lane = this.readLane(id); if (!lane) throw new SchemaError(`unknown lane: ${id}`); return lane; }
  private outbox(): OutboxRecord[] { return (this.db.query("SELECT * FROM outbox ORDER BY created_at, id").all() as any[]).map(r => ({ id:r.id, channel:r.channel, dedupeKey:r.dedupe_key, payload:JSON.parse(r.payload_json), deliveryState:r.delivery_state, attempts:r.attempts, lastError:r.last_error, createdAt:r.created_at, deliveredAt:r.delivered_at })); }
  private required(value: string, name: string): void { if (!value) throw new SchemaError(`${name} must be non-empty`); }
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const value=fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
}
