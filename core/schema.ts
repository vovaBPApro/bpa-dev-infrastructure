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

/** How a usage row's numbers were obtained. `unmeasured` is not a failure mode
 * to be tidied away: it is the honest record of a turn nobody could measure,
 * and it is the reason every count on this row is nullable. */
export type UsageSource = "cli-json" | "estimated" | "unmeasured";
export type UsageRole = "coder" | "reviewer" | "orchestrator" | "manager";

export type UsageEventInput = {
  model: string | null; role: UsageRole; lane?: string | null; itemId?: string | null;
  inputTokens: number | null; outputTokens: number | null;
  cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null;
  costUsd: number | null; serviceTier?: string | null;
  sessionId?: string | null; eventId?: string | null; source: UsageSource;
  observedAt?: number;
};

export type UsageEventRecord = Required<UsageEventInput> & { id: number };

/** One aggregated bucket of the usage time series. The measured/unmeasured
 * split travels WITH the sums on purpose: a bucket of three turns whose sums
 * came from one of them is a different fact from a bucket of three measured
 * turns, and a caller that only reads `costUsd` cannot tell them apart. */
export type UsageSeriesRow = {
  model: string | null; role: string | null; hour: string | null;
  events: number; measuredEvents: number; unmeasuredEvents: number;
  inputTokens: number | null; outputTokens: number | null;
  cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null;
  costUsd: number | null;
};

export type UsageGroupBy = "model" | "role" | "hour";
export const usageGroupByColumns: Record<UsageGroupBy, string> = {
  model: "model", role: "role",
  // Epoch ms -> UTC hour bucket. strftime is applied to the stored integer
  // rather than a stored text timestamp so the column stays cheap to range-scan.
  hour: "strftime('%Y-%m-%dT%H:00Z', observed_at / 1000, 'unixepoch')",
};

// V3-3.10 (instance/specs/token-usage-accounting.md, HR-2377). Additive: the
// existing tables are untouched, and `CREATE TABLE IF NOT EXISTS` on every open
// IS the migration, so an already-populated state DB gains the table without a
// separate step.
//
// Every count is NULLABLE, and that is the whole design rather than laziness
// about defaults. This data is destined for a graph, and on a graph a zero
// reads as "we spent nothing" while the truth may be "we did not look". The
// three CHECK constraints below make that rule structural instead of a
// convention some future writer can forget:
//
//   - `unmeasured` forces EVERY observed field null, so no code path can file a
//     zero as an observation. A writer that computes 0 for an unobserved value
//     does not get a lenient row, it gets a constraint failure.
//   - a measured row must carry a model and both token counts, so the opposite
//     mistake -- claiming `cli-json` while having observed nothing -- is equally
//     rejected.
//   - `source` is closed to the three known values.
//
// Each CHECK is written from `IS NULL` / `IS NOT NULL` operands only. SQLite
// accepts a CHECK whose expression evaluates to NULL, so a constraint built out
// of ordinary comparisons against a nullable column would silently pass on
// exactly the rows it exists to catch.
//
// `cost_usd` is nullable independently of the counts: the interactive CLI
// records tokens in its session transcript but no cost (daemon/usage-ingest-
// transcripts.ts), and guessing that cost from a hand-kept price table would
// put an invented number next to observed ones.
const usageEventsDdl = `
    CREATE TABLE IF NOT EXISTS usage_events (
      -- Plain rowid alias, deliberately not AUTOINCREMENT: nothing references a
      -- usage id, so guaranteeing ids are never reused would buy nothing and
      -- cost a second internal table (sqlite_sequence) plus a write per insert.
      id INTEGER PRIMARY KEY,
      observed_at INTEGER NOT NULL,
      model TEXT,
      role TEXT NOT NULL,
      lane TEXT,
      item_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cost_usd REAL,
      service_tier TEXT,
      session_id TEXT,
      event_id TEXT,
      source TEXT NOT NULL,
      CHECK (source IN ('cli-json', 'estimated', 'unmeasured')),
      CHECK (source <> 'unmeasured' OR (
        model IS NULL AND input_tokens IS NULL AND output_tokens IS NULL
        AND cache_creation_input_tokens IS NULL AND cache_read_input_tokens IS NULL
        AND cost_usd IS NULL AND service_tier IS NULL)),
      CHECK (source = 'unmeasured' OR (
        model IS NOT NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL))
    );
    -- Ingest idempotency. The transcript reader (orchestrator role) re-reads
    -- files it has already seen on every run, so re-recording the same provider
    -- message must be a no-op rather than a doubled bill. SQLite treats NULLs
    -- as distinct in a UNIQUE index, so rows carrying no provider identity --
    -- an unmeasured turn, for instance -- are never collapsed into each other.
    CREATE UNIQUE INDEX IF NOT EXISTS usage_events_identity
      ON usage_events (session_id, event_id, model);
    CREATE INDEX IF NOT EXISTS usage_events_observed_at ON usage_events (observed_at);
`;

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

  /** Record one model invocation's consumption. Returns false when the row was
   * already present under the same provider identity, so a re-run of an ingest
   * is a no-op rather than a duplicated bill.
   *
   * This runs inside the shared store's own transaction discipline (V3-0.20 and
   * V3-0.7 are the two-writers hazard it inherits) rather than opening a second
   * connection with rules of its own. */
  recordUsage(input: UsageEventInput): boolean {
    if (!["coder", "reviewer", "orchestrator", "manager"].includes(input.role)) throw new SchemaError(`unknown usage role: ${input.role}`);
    if (!["cli-json", "estimated", "unmeasured"].includes(input.source)) throw new SchemaError(`unknown usage source: ${input.source}`);
    const counts = {
      input_tokens: input.inputTokens, output_tokens: input.outputTokens,
      cache_creation_input_tokens: input.cacheCreationInputTokens, cache_read_input_tokens: input.cacheReadInputTokens,
    };
    for (const [name, value] of Object.entries(counts)) {
      if (value === null) continue;
      if (!Number.isSafeInteger(value) || value < 0) throw new SchemaError(`${name} must be null or a non-negative integer`);
    }
    if (input.costUsd !== null && (!Number.isFinite(input.costUsd) || input.costUsd < 0)) throw new SchemaError("cost must be null or a non-negative number");
    // Refuse the mistake in the caller's own vocabulary. The table's CHECK
    // catches it too, but an SQLITE_CONSTRAINT on a five-column predicate does
    // not tell the author WHICH rule they broke, and this one is the rule the
    // whole row exists to enforce.
    if (input.source === "unmeasured" && (input.model !== null || Object.values(counts).some((value) => value !== null) || input.costUsd !== null)) {
      throw new SchemaError("an unmeasured usage row carries no model, counts or cost -- record null, never zero");
    }
    if (input.source !== "unmeasured" && (input.model === null || input.inputTokens === null || input.outputTokens === null)) {
      throw new SchemaError(`a ${input.source} usage row must carry the reported model and both token counts`);
    }
    return this.tx(() => this.db.query(`INSERT OR IGNORE INTO usage_events
      (observed_at, model, role, lane, item_id, input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, cost_usd, service_tier, session_id, event_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.observedAt ?? this.now(), input.model, input.role, input.lane ?? null, input.itemId ?? null,
      input.inputTokens, input.outputTokens, input.cacheCreationInputTokens, input.cacheReadInputTokens,
      input.costUsd, input.serviceTier ?? null, input.sessionId ?? null, input.eventId ?? null, input.source,
    ).changes === 1);
  }

  /** The time series. `groupBy` may be empty for one whole-window total. */
  queryUsage(options: { since?: number; until?: number; groupBy?: UsageGroupBy[] } = {}): UsageSeriesRow[] {
    const groupBy = options.groupBy ?? [];
    for (const key of groupBy) if (!(key in usageGroupByColumns)) throw new SchemaError(`unknown usage grouping: ${key}`);
    const where: string[] = []; const values: number[] = [];
    if (options.since !== undefined) { where.push("observed_at >= ?"); values.push(options.since); }
    if (options.until !== undefined) { where.push("observed_at < ?"); values.push(options.until); }
    const selected = (["model", "role", "hour"] as UsageGroupBy[]).map((key) =>
      `${groupBy.includes(key) ? usageGroupByColumns[key] : "NULL"} AS ${key}`);
    const grouping = groupBy.map((key) => usageGroupByColumns[key]);
    const rows = this.db.query(`SELECT ${selected.join(", ")},
        COUNT(*) AS events,
        SUM(CASE WHEN source <> 'unmeasured' THEN 1 ELSE 0 END) AS measured_events,
        SUM(CASE WHEN source = 'unmeasured' THEN 1 ELSE 0 END) AS unmeasured_events,
        SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
        SUM(cache_read_input_tokens) AS cache_read_input_tokens,
        SUM(cost_usd) AS cost_usd
      FROM usage_events
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ${grouping.length ? `GROUP BY ${grouping.join(", ")}` : ""}
      ORDER BY ${[...grouping, "1"].join(", ")}`).all(...values) as any[];
    // SUM() over an all-null group is NULL, and it stays NULL here. Coercing it
    // to 0 would manufacture the exact reading -- "this hour cost nothing" --
    // that the unmeasured rule exists to prevent.
    return rows.map((r) => ({
      model: r.model ?? null, role: r.role ?? null, hour: r.hour ?? null,
      events: r.events, measuredEvents: r.measured_events, unmeasuredEvents: r.unmeasured_events,
      inputTokens: r.input_tokens ?? null, outputTokens: r.output_tokens ?? null,
      cacheCreationInputTokens: r.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: r.cache_read_input_tokens ?? null, costUsd: r.cost_usd ?? null,
    }));
  }

  /** Raw rows, newest first. The query path above answers the operator's
   * question; this one answers "show me the actual records". */
  usageEvents(options: { since?: number; until?: number; limit?: number } = {}): UsageEventRecord[] {
    const where: string[] = []; const values: number[] = [];
    if (options.since !== undefined) { where.push("observed_at >= ?"); values.push(options.since); }
    if (options.until !== undefined) { where.push("observed_at < ?"); values.push(options.until); }
    const rows = this.db.query(`SELECT * FROM usage_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY observed_at DESC, id DESC ${options.limit !== undefined ? "LIMIT ?" : ""}`)
      .all(...values, ...(options.limit !== undefined ? [options.limit] : [])) as any[];
    return rows.map((r) => ({
      id: r.id, observedAt: r.observed_at, model: r.model, role: r.role, lane: r.lane, itemId: r.item_id,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      cacheCreationInputTokens: r.cache_creation_input_tokens, cacheReadInputTokens: r.cache_read_input_tokens,
      costUsd: r.cost_usd, serviceTier: r.service_tier, sessionId: r.session_id, eventId: r.event_id, source: r.source,
    }));
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
    ${usageEventsDdl}
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
