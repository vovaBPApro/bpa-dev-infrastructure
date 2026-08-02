import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DurableStore, FencedTransitionError } from "./state";

const path = () => process.env.INFRA_STATE_DB || resolve(import.meta.dir, "..", "runtime", "state.db");
const required = (value: string | undefined, name: string): string => { if (!value) throw new Error(`${name} is required`); return value; };
const integer = (value: string | undefined, name: string): number => {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`); return parsed;
};

function run(args: string[]): void {
  const database = path();
  mkdirSync(dirname(database), { recursive: true });
  const injected = process.env.BPA_ALLOW_TEST_CLOCK === "1" ? Number(process.env.INFRA_TEST_NOW_MS) : Number.NaN;
  const store = new DurableStore(database, Number.isSafeInteger(injected) ? { now: () => injected } : {});
  try {
    const [group, action, ...v] = args;
    if (group === "mission" && action === "create" && v.length === 2) {
      const id = crypto.randomUUID(); store.createMission({ id, correlationId: required(v[0], "correlation id"), acceptanceId: required(v[1], "acceptance id") });
      console.log(`MISSION id=${id} state=queued`); return;
    }
    if (group === "manager" && action === "create" && v.length === 2) {
      store.createManager({ id: required(v[1], "manager id"), missionId: required(v[0], "mission id"), parentId: v[0]!, depth: 1 });
      console.log(`MANAGER id=${v[1]} mission=${v[0]} state=ready`); return;
    }
    if (group === "lane" && action === "create" && v.length === 5) {
      const lane = store.createLane({ id: required(v[2], "lane id"), missionId: required(v[0], "mission id"), managerId: required(v[1], "manager id"), parentId: v[1]!, depth: 2, acceptanceId: required(v[3], "acceptance id"), retryBudget: integer(v[4], "retry budget") });
      console.log(`LANE id=${lane.id} manager=${lane.managerId} state=${lane.state}`); return;
    }
    if (group === "lane" && action === "claim" && v.length === 3) {
      const claim = store.claimLane(required(v[0], "lane id"), required(v[1], "owner"), integer(v[2], "lease duration"));
      console.log(`CLAIM lane=${v[0]} owner=${v[1]} token=${claim.fencingToken} deadline=${claim.deadlineAt}`); return;
    }
    if (group === "lane" && action === "ack" && v.length === 3) { store.acknowledgeLane(v[0]!, v[1]!, integer(v[2], "token")); console.log("ACK"); return; }
    if (group === "lane" && action === "progress" && v.length === 4) { store.recordSemanticProgress(v[0]!, v[1]!, integer(v[2], "token"), required(v[3], "evidence path")); console.log("PROGRESS"); return; }
    if (group === "lane" && action === "complete" && v.length === 6) { store.completeLane(v[0]!, v[1]!, integer(v[2], "token"), { sha:v[3]!, reportPath:v[4]!, verdict:v[5] as "clean"|"NO-GO" }); console.log("TERMINAL"); return; }
    if (group === "outbox" && action === "enqueue" && v.length === 4) { store.enqueueOutbox({ id:v[0]!, channel:v[1]!, dedupeKey:v[2]!, payload:JSON.parse(v[3]!) }); console.log("OUTBOX"); return; }
    if (group === "status" && action === undefined) { console.log(JSON.stringify(store.reconstruct())); return; }
    throw new Error("usage: mission create <correlation> <acceptance> | manager create <mission> <manager> | lane create <mission> <manager> <lane> <acceptance> <retries> | lane claim/ack/progress/complete ... | outbox enqueue ... | status");
  } finally { store.close(); }
}

try { run(Bun.argv.slice(2)); }
catch (error) { console.error(`ERROR ${error instanceof FencedTransitionError ? "FENCED" : error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
