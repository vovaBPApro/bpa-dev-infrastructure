import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LeaseHeldError, StateStore } from "./state";

const renewalTtlMs = 30_000;
const hiddenMissionStates = new Set(["succeeded"]);
const hiddenLaneStates = new Set(["succeeded"]);

function databasePath(): string {
  const configured = process.env.INFRA_STATE_DB;
  return configured || resolve(import.meta.dir, "..", "runtime", "state.db");
}

function usage(): never {
  throw new Error("usage: mission create <correlation-id> | mission transition <id> <state> | lane create <mission-id> <lane-id> | lane transition <lane-id> <state> | lease acquire <owner> <key> <ttl-ms> | lease renew <owner> <key> <token> | lease release <owner> <key> <token> | reap | status");
}

function required(value: string | undefined): string {
  if (!value) usage();
  return value;
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function status(store: StateStore): void {
  const missions = store.db.query("SELECT id, correlation_id, state, created_at, updated_at FROM missions ORDER BY id").all() as Array<{ id: string; correlation_id: string; state: string; created_at: number; updated_at: number }>;
  const lanes = store.db.query("SELECT id, mission_id, state, created_at, updated_at FROM lanes ORDER BY id").all() as Array<{ id: string; mission_id: string; state: string; created_at: number; updated_at: number }>;
  console.log(JSON.stringify({
    missions: missions.filter((mission) => !hiddenMissionStates.has(mission.state)).map((mission) => ({ id: mission.id, correlationId: mission.correlation_id, state: mission.state, createdAt: mission.created_at, updatedAt: mission.updated_at })),
    lanes: lanes.filter((lane) => !hiddenLaneStates.has(lane.state)).map((lane) => ({ id: lane.id, missionId: lane.mission_id, state: lane.state, createdAt: lane.created_at, updatedAt: lane.updated_at })),
    leases: store.listActive(),
  }));
}

function run(args: string[]): void {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true });
  const store = new StateStore(path);
  try {
    const [group, action, ...values] = args;
    if (group === "mission" && action === "create" && values.length === 1) {
      const mission = store.createMission(crypto.randomUUID(), required(values[0]));
      console.log(`MISSION id=${mission.id} state=${mission.state}`);
      return;
    }
    if (group === "mission" && action === "transition" && values.length === 2) {
      const mission = store.transitionMission(required(values[0]), required(values[1]) as never);
      console.log(`MISSION id=${mission.id} state=${mission.state}`);
      return;
    }
    if (group === "lane" && action === "create" && values.length === 2) {
      const lane = store.createLane(required(values[1]), required(values[0]));
      console.log(`LANE id=${lane.id} mission=${lane.missionId} state=${lane.state}`);
      return;
    }
    if (group === "lane" && action === "transition" && values.length === 2) {
      const lane = store.transitionLane(required(values[0]), required(values[1]) as never);
      console.log(`LANE id=${lane.id} mission=${lane.missionId} state=${lane.state}`);
      return;
    }
    if (group === "lease" && action === "acquire" && values.length === 3) {
      const owner = required(values[0]);
      const key = required(values[1]);
      const lease = store.acquireLease(owner, key, positiveInteger(values[2], "lease ttl"));
      console.log(`LEASE key=${key} owner=${owner} token=${lease.fencingToken}`);
      return;
    }
    if (group === "lease" && action === "renew" && values.length === 3) {
      const owner = required(values[0]);
      const key = required(values[1]);
      const token = positiveInteger(values[2], "fencing token");
      store.renewLease(owner, key, token, renewalTtlMs);
      console.log(`LEASE key=${key} owner=${owner} token=${token}`);
      return;
    }
    if (group === "lease" && action === "release" && values.length === 3) {
      const owner = required(values[0]);
      const key = required(values[1]);
      const token = positiveInteger(values[2], "fencing token");
      store.releaseLease(owner, key, token);
      console.log(`LEASE key=${key} owner=${owner} token=${token}`);
      return;
    }
    if (group === "reap" && action === undefined && values.length === 0) {
      for (const lease of store.reapExpiredLeases()) console.log(`REAP key=${lease.key} owner=${lease.owner} token=${lease.fencingToken}`);
      return;
    }
    if (group === "status" && action === undefined && values.length === 0) {
      status(store);
      return;
    }
    usage();
  } finally {
    store.close();
  }
}

try {
  run(Bun.argv.slice(2));
} catch (error) {
  const message = error instanceof LeaseHeldError ? "LEASE-HELD" : error instanceof Error ? error.message : String(error);
  console.error(`ERROR ${message}`);
  process.exitCode = 1;
}
