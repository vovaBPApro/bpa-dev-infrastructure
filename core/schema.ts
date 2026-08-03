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

  createManager(input: { id: string; missionId: string; parentId: string; depth: number }): void {
    if (input.depth !== 1 || input.parentId !== input.missionId) throw new SchemaError("manager parent/depth must be mission/1");
    this.tx(() => this.db.query("INSERT INTO managers VALUES (?, ?, ?, ?, 'ready', ?, ?)").run(input.id, input.missionId, input.parentId, input.depth, this.now(), this.now()));
  }

  createLane(input: CreateLaneInput): LaneRecord {
    if (input.depth !== 2) throw new SchemaError("lane depth must be 2 tonight");
    if (input.parentId !== input.managerId) throw new SchemaError("lane parent must be its manager");
    if (!Number.isInteger(input.retryBudget) || input.retryBudget < 0) throw new SchemaError("retry budget must be a non-negative integer");
    this.required(input.acceptanceId, "acceptance id");
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
    return {
      missions,
      managers,
      lanes,
      leases: lanes.filter(lane => lane.terminalVerdict === null && lane.leaseOwner !== null && lane.leaseDeadlineAt !== null && lane.leaseDeadlineAt > this.now()).map(lane => ({
        key:lane.id, owner:lane.leaseOwner!, fencingToken:lane.fencingToken, expiresAt:lane.leaseDeadlineAt!,
      })),
      outbox: this.outbox(),
    };
  }

  private initialize(): void { this.db.exec(`
    CREATE TABLE IF NOT EXISTS missions (id TEXT PRIMARY KEY, correlation_id TEXT UNIQUE NOT NULL, acceptance_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS managers (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), parent_id TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth=1), state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL REFERENCES missions(id), manager_id TEXT NOT NULL REFERENCES managers(id), parent_id TEXT NOT NULL, depth INTEGER NOT NULL CHECK(depth=2), state TEXT NOT NULL, generation INTEGER NOT NULL, lease_owner TEXT, fencing_token INTEGER NOT NULL, lease_deadline_at INTEGER, retries_used INTEGER NOT NULL, retry_budget INTEGER NOT NULL, acceptance_id TEXT NOT NULL, acknowledgement_at INTEGER, semantic_progress_at INTEGER, semantic_evidence_path TEXT, terminal_sha TEXT, terminal_report_path TEXT, terminal_verdict TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, channel TEXT NOT NULL, dedupe_key TEXT UNIQUE NOT NULL, payload_json TEXT NOT NULL, delivery_state TEXT NOT NULL, attempts INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER);
  `); }

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
