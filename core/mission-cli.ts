import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DurableStore, FencedTransitionError } from "./state";
import { lineValue } from "../gate/report-contract";
import { isMissionCliAction } from "./mission-cli-actions";

const path = () => process.env.INFRA_STATE_DB || resolve(import.meta.dir, "..", "runtime", "state.db");
// The repository this lane's evidence lives in. Defaults to mission-cli.ts's
// own repo (core/mission-cli.ts -> ..), matching how gate/lane-exit.sh is
// invoked elsewhere (instructions/orchestrator-cold-start.md's `--repo "$REPO"`).
const repoDir = () => process.env.INFRA_REPO_DIR || resolve(import.meta.dir, "..");
const required = (value: string | undefined, name: string): string => { if (!value) throw new Error(`${name} is required`); return value; };
const integer = (value: string | undefined, name: string): number => {
  const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`); return parsed;
};

// instance/workboard.md V3-0.5: make gate/lane-exit.sh a REAL caller, not
// only instruction prose. `lane complete` is the one command in this repo
// whose entire job is "record a lane as terminal in the durable store" --
// core/schema.ts's DurableStore.completeLane() is deliberately storage-only
// (core/schema.test.ts and core/state.test.ts exercise it with symbolic,
// non-filesystem evidence paths on purpose, to keep the fencing algebra
// testable without git/filesystem dependencies) so the gate cannot live
// there. It lives here, the one real caller with actual repo/report/branch
// context. gate/lane-exit.sh already resolves its own trusted `bun` via
// land-lib.sh's land_resolve_bun, which REFUSES when BUN_BIN is already set
// in its environment (instance/workboard.md "Nested gate invocations") --
// BUN_BIN is stripped from the spawned environment here so an inherited
// BUN_BIN (e.g. this CLI invoked from inside gate/land.sh's own run) cannot
// make the gate refuse to run at all, which would fail OPEN, not closed.
function laneExitVerdict(reportPath: string, repo: string, branch: string): { status: number; output: string } {
  const script = resolve(import.meta.dir, "..", "gate", "lane-exit.sh");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== "BUN_BIN") env[key] = value;
  const result = Bun.spawnSync(["bash", script, "--report", reportPath, "--repo", repo, "--branch", branch], { env, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`.trim();
  return { status: result.exitCode ?? 1, output };
}

function run(args: string[]): void {
  const database = path();
  mkdirSync(dirname(database), { recursive: true });
  const injected = process.env.BPA_ALLOW_TEST_CLOCK === "1" ? Number(process.env.INFRA_TEST_NOW_MS) : Number.NaN;
  const store = new DurableStore(database, Number.isSafeInteger(injected) ? { now: () => injected } : {});
  try {
    const [group, action, ...v] = args;
    if (!isMissionCliAction(group ?? "", action)) throw new Error(`unknown action: ${[group, action].filter(Boolean).join(" ") || "missing"}`);
    if (group === "mission" && action === "create" && v.length === 2) {
      const id = crypto.randomUUID(); store.createMission({ id, correlationId: required(v[0], "correlation id"), acceptanceId: required(v[1], "acceptance id") });
      console.log(`MISSION id=${id} state=queued`); return;
    }
    if (group === "mission" && action === "complete" && v.length === 1) {
      store.completeMission(required(v[0], "mission id"));
      console.log(`MISSION id=${v[0]} state=clean`); return;
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
    if (group === "lane" && action === "complete" && v.length === 7) {
      const [laneId, owner, tokenRaw, claimedSha, reportPath, claimedVerdict, branch] = v;
      required(laneId, "lane id"); required(owner, "owner"); required(claimedSha, "sha"); required(reportPath, "report path"); required(branch, "branch");
      const token = integer(tokenRaw, "token");
      if (claimedVerdict !== "clean" && claimedVerdict !== "NO-GO") throw new Error("verdict must be clean or NO-GO");
      const guard = laneExitVerdict(reportPath!, repoDir(), branch!);
      // gate/lane-exit.sh forwards gate/completion-guard.ts's exit codes
      // unchanged: 0 = contract-valid and clean, 3 = contract-valid and an
      // honest NO-GO (both mean the lane may be treated as finished), 2 = a
      // contract violation (missing report, wrong shape, commit: not equal
      // to branch's tip, ...). Only 0/3 may reach store.completeLane below --
      // this is the fail-closed boundary the row exists to add.
      if (guard.status !== 0 && guard.status !== 3) {
        console.error(`ERROR GATE lane=${laneId} branch=${branch} exit=${guard.status} ${guard.output}`);
        process.exitCode = 1;
        return;
      }
      const derivedVerdict: "clean" | "NO-GO" = guard.status === 3 ? "NO-GO" : "clean";
      if (derivedVerdict !== claimedVerdict) {
        console.error(`ERROR GATE-VERDICT-MISMATCH lane=${laneId} claimed=${claimedVerdict} guard-derived=${derivedVerdict}`);
        process.exitCode = 1;
        return;
      }
      // The sha recorded as terminal is read back out of the report the gate
      // just verified against the branch tip (gate/report-contract.ts's
      // lineValue, the same anchored parser completion-guard.ts uses) rather
      // than trusted from the caller's own claimedSha argument, so a caller
      // cannot pass an unrelated-but-well-formed sha alongside a report that
      // actually pins a different, guard-checked one.
      const reportSha = lineValue(readFileSync(reportPath!, "utf8"), "commit")?.split(/\s+/, 1)[0];
      if (!reportSha || reportSha.toLowerCase() !== claimedSha!.toLowerCase()) {
        console.error(`ERROR GATE-SHA-MISMATCH lane=${laneId} claimed=${claimedSha} report=${reportSha ?? "missing"}`);
        process.exitCode = 1;
        return;
      }
      store.completeLane(laneId!, owner!, token, { sha: reportSha, reportPath: reportPath!, verdict: derivedVerdict });
      console.log(`TERMINAL lane=${laneId} guard=${derivedVerdict === "NO-GO" ? "no-go" : "pass"}`);
      return;
    }
    if (group === "outbox" && action === "enqueue" && v.length === 4) { store.enqueueOutbox({ id:v[0]!, channel:v[1]!, dedupeKey:v[2]!, payload:JSON.parse(v[3]!) }); console.log("OUTBOX"); return; }
    if (group === "status" && action === undefined) { console.log(JSON.stringify(store.reconstruct())); return; }
    throw new Error("usage: mission create <correlation> <acceptance> | mission complete <mission> | manager create <mission> <manager> | lane create <mission> <manager> <lane> <acceptance> <retries> | lane claim <lane> <owner> <lease-ms> | lane ack <lane> <owner> <token> | lane progress <lane> <owner> <token> <evidence> | lane complete <lane> <owner> <token> <sha> <report-path> <clean|NO-GO> <branch> | outbox enqueue ... | status");
  } finally { store.close(); }
}

try { run(Bun.argv.slice(2)); }
// A fenced refusal keeps its stable `FENCED` class token AND carries the
// reason the store constructed. Failing closed without saying why is correct
// behaviour delivered uselessly: the operator debugs the wrong thing.
catch (error) { console.error(`ERROR ${error instanceof FencedTransitionError ? `FENCED ${error.message}` : error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
