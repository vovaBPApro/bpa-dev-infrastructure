import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = []; const cli = resolve(import.meta.dir, "mission-cli.ts");
async function db() { const d=await mkdtemp(join(tmpdir(),"v3-cli-")); dirs.push(d); return join(d,"nested","state.sqlite"); }
async function invokeAt(database:string,nowMs:number,...args:string[]) { const p=Bun.spawn([process.execPath,cli,...args],{env:{...Bun.env,INFRA_STATE_DB:database,BPA_ALLOW_TEST_CLOCK:"1",INFRA_TEST_NOW_MS:String(nowMs)},stdout:"pipe",stderr:"pipe"}); const [stdout,stderr,exitCode]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]); return {exitCode,stdout:stdout.trim(),stderr:stderr.trim()}; }
async function invoke(database:string,...args:string[]) { return invokeAt(database,1000,...args); }
// Same as invoke(), but also points INFRA_REPO_DIR at a real git repo so
// `lane complete`'s gate/lane-exit.sh call (instance/workboard.md V3-0.5)
// has real evidence to check the report and branch tip against.
async function invokeWithRepo(database:string,repo:string,...args:string[]) { const p=Bun.spawn([process.execPath,cli,...args],{env:{...Bun.env,INFRA_STATE_DB:database,BPA_ALLOW_TEST_CLOCK:"1",INFRA_TEST_NOW_MS:"1000",INFRA_REPO_DIR:repo},stdout:"pipe",stderr:"pipe"}); const [stdout,stderr,exitCode]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]); return {exitCode,stdout:stdout.trim(),stderr:stderr.trim()}; }
afterEach(async()=>Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true}))));

function git(repo:string,args:string[]) { const r=Bun.spawnSync(["git","-C",repo,...args]); if(r.exitCode!==0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr?.toString()}`); return r; }
async function gitRepo(branch="ag-lane-1"): Promise<string> {
  const root=await mkdtemp(join(tmpdir(),"v3-cli-repo-")); dirs.push(root);
  const repo=join(root,"repo");
  Bun.spawnSync(["git","init","--initial-branch=main",repo]);
  git(repo,["config","user.email","lane@example.test"]);
  git(repo,["config","user.name","Lane"]);
  await writeFile(join(repo,"base.txt"),"base\n");
  git(repo,["add","base.txt"]);
  git(repo,["commit","-m","base"]);
  git(repo,["checkout","-b",branch]);
  await writeFile(join(repo,"work.txt"),"work\n");
  git(repo,["add","work.txt"]);
  git(repo,["commit","-m","work"]);
  return repo;
}
function tip(repo:string) { return Bun.spawnSync(["git","-C",repo,"rev-parse","HEAD"]).stdout.toString().trim(); }
// `lane complete` runs the real gate/lane-exit.sh, so a report this helper
// builds has to be contract-valid all the way through the bare-world verify
// (V3-5.42) -- which refuses every undeclared clearance on a host with no
// unprivileged mount namespace. The meteorite container is exactly that host:
// its `bun test` runs without CAP_SYS_ADMIN, `unshare --mount` returns EPERM,
// and five scenarios below went red on the masking refusal rather than on
// anything this file is about. Declaring the capability is the portability path
// a real lane running there would take (instructions/lane-capabilities.md);
// where the namespace works the declaration is unused and the run is
// full-fidelity. The rejection scenarios are unaffected either way: they are
// refused at the report contract, before the bare world is reached.
//
// The line stays INSIDE the contiguous contract-header block -- a granting
// field is read at column 0 there and nowhere else (gate/report-contract.ts,
// contractHeader) -- so it is appended with nothing interposed before it.
function validReport(sha:string,result:"clean"|"NO-GO"="clean") { return `commit: ${sha} fixture\nverify: true\nresult: ${result}\nsecret-scan: clean\nremaining: none\nbare-world: capability=mount-namespace reason=this-suite-must-also-pass-where-unprivileged-namespaces-are-unavailable\n`; }
async function readyLane(database:string,laneId:string) {
  const created=await invoke(database,"mission","create",`corr-${laneId}`,"accept");
  const mission=/id=([^ ]+)/.exec(created.stdout)![1]!;
  await invoke(database,"manager","create",mission,`mgr-${laneId}`);
  await invoke(database,"lane","create",mission,`mgr-${laneId}`,laneId,"accept","3");
  const claim=await invoke(database,"lane","claim",laneId,"owner-1","60000");
  const token=/token=(\d+)/.exec(claim.stdout)![1]!;
  return {mission,token};
}
async function laneSnapshot(database:string,laneId:string) {
  const restarted=await invoke(database,"status");
  const snapshot=JSON.parse(restarted.stdout);
  return snapshot.lanes.find((l:{id:string})=>l.id===laneId);
}

test("restart reconstruction exposes the full executable v3 contract", async () => {
  const database=await db();
  const repo=await gitRepo();
  const sha=tip(repo);
  const reportPath=join(repo,"..","report.md");
  await writeFile(reportPath,validReport(sha));
  const created=await invoke(database,"mission","create","corr-1","mission-accept");
  const mission=/id=([^ ]+)/.exec(created.stdout)![1]!;
  expect(await invoke(database,"manager","create",mission,"manager-1")).toMatchObject({exitCode:0});
  expect(await invoke(database,"lane","create",mission,"manager-1","lane-1","lane-accept","2")).toMatchObject({exitCode:0});
  const claim=await invoke(database,"lane","claim","lane-1","owner-1","500"); const token=/token=(\d+)/.exec(claim.stdout)![1]!;
  await invoke(database,"lane","ack","lane-1","owner-1",token);
  await invoke(database,"lane","progress","lane-1","owner-1",token,"/evidence/progress.json");
  await invoke(database,"outbox","enqueue","msg-1","telegram","corr-1:terminal",'{"kind":"terminal"}');
  const completed=await invokeWithRepo(database,repo,"lane","complete","lane-1","owner-1",token,sha,reportPath,"clean","ag-lane-1");
  expect(completed).toMatchObject({exitCode:0});
  expect(completed.stdout).toContain("guard=pass");
  const restarted=await invoke(database,"status"); const snapshot=JSON.parse(restarted.stdout);
  expect(snapshot.missions[0]).toMatchObject({id:mission,correlationId:"corr-1",acceptanceId:"mission-accept",createdAt:1000,updatedAt:1000});
  expect(snapshot.lanes[0]).toMatchObject({id:"lane-1",createdAt:1000,updatedAt:1000});
  expect(snapshot.leases).toEqual([]);
  expect(snapshot.managers[0]).toMatchObject({id:"manager-1",missionId:mission,parentId:mission,depth:1,createdAt:1000,updatedAt:1000});
  expect(snapshot.lanes[0]).toMatchObject({id:"lane-1",managerId:"manager-1",parentId:"manager-1",depth:2,generation:1,acceptanceId:"lane-accept",acknowledgementAt:1000,semanticEvidencePath:"/evidence/progress.json",terminalSha:sha,terminalReportPath:reportPath,terminalVerdict:"clean"});
  expect(snapshot.outbox[0]).toMatchObject({id:"msg-1",dedupeKey:"corr-1:terminal",deliveryState:"pending",payload:{kind:"terminal"}});
});

test("CLI preserves fencing across restarts", async()=>{ const database=await db(); const c=await invoke(database,"mission","create","corr","accept"); const m=/id=([^ ]+)/.exec(c.stdout)![1]!; await invoke(database,"manager","create",m,"mgr"); await invoke(database,"lane","create",m,"mgr","lane","accept","1"); const first=await invoke(database,"lane","claim","lane","one","500"); expect(first.exitCode).toBe(0); expect((await invoke(database,"lane","claim","lane","two","500")).stderr).toBe("ERROR FENCED lane has a live owner: lane"); });

test("mission complete fails closed until every lane is clean, then persists terminal state", async () => {
  const database=await db();
  const {mission,token}=await readyLane(database,"lane-mission-close");
  // The refusal must NAME the blocking lane and its state, not just fail
  // closed: exact equality, so dropping the reason or the lane name is red.
  expect(await invoke(database,"mission","complete",mission)).toMatchObject({exitCode:1,stderr:`ERROR FENCED mission has non-clean lanes: ${mission} (lane-mission-close=running)`});
  const repo=await gitRepo(); const sha=tip(repo); const reportPath=join(repo,"..","mission-close.report.md");
  await writeFile(reportPath,validReport(sha));
  expect(await invokeWithRepo(database,repo,"lane","complete","lane-mission-close","owner-1",token,sha,reportPath,"clean","ag-lane-1")).toMatchObject({exitCode:0});
  expect(await invoke(database,"mission","complete",mission)).toMatchObject({exitCode:0,stdout:`MISSION id=${mission} state=clean`});
  const snapshot=JSON.parse((await invoke(database,"status")).stdout);
  expect(snapshot.missions[0].state).toBe("clean");
  expect(snapshot.managers[0].state).toBe("clean");
  expect(await invoke(database,"mission","complete",mission)).toMatchObject({exitCode:0});
});

// instance/workboard.md V3-0.15 F8: failing closed without saying why is
// correct behaviour delivered uselessly. Each refusal shape must be
// distinguishable from the others by its message alone, and the non-clean
// case must name the lane the operator has to go and look at.
test("mission complete distinguishes its refusal shapes and names only the lanes that block", async () => {
  const database=await db();
  const created=await invoke(database,"mission","create","corr-shapes","accept");
  const mission=/id=([^ ]+)/.exec(created.stdout)![1]!;
  expect(await invoke(database,"mission","complete",mission)).toMatchObject({exitCode:1,stderr:`ERROR FENCED mission has no lanes: ${mission}`});
  await invoke(database,"manager","create",mission,"mgr-shapes");
  await invoke(database,"lane","create",mission,"mgr-shapes","lane-done","accept","3");
  await invoke(database,"lane","create",mission,"mgr-shapes","lane-blocking","accept","3");
  const claim=await invoke(database,"lane","claim","lane-done","owner-1","60000");
  const token=/token=(\d+)/.exec(claim.stdout)![1]!;
  const repo=await gitRepo(); const sha=tip(repo);
  const reportPath=join(repo,"..","shapes.report.md");
  await writeFile(reportPath,validReport(sha));
  expect(await invokeWithRepo(database,repo,"lane","complete","lane-done","owner-1",token,sha,reportPath,"clean","ag-lane-1")).toMatchObject({exitCode:0});
  const blocked=await invoke(database,"mission","complete",mission);
  expect(blocked.exitCode).toBe(1);
  expect(blocked.stderr).toContain("lane-blocking");
  expect(blocked.stderr).not.toContain("lane-done");
  expect(await invoke(database,"mission","complete","does-not-exist")).toMatchObject({exitCode:1,stderr:"ERROR unknown mission: does-not-exist"});
});

// instance/workboard.md V3-0.5: `lane complete` must not be able to record a
// lane as terminal when its report fails gate/lane-exit.sh's contract check
// -- the same three shapes gate/lane-exit.test.sh locks at the gate level,
// proven here at the CALLER that now enforces it.
test("lane complete rejects a report naming an intermediate SHA, not the branch tip", async () => {
  const database=await db();
  const {token}=await readyLane(database,"lane-stale");
  const repo=await gitRepo();
  const stale=tip(repo);
  await writeFile(join(repo,"more.txt"),"more\n");
  git(repo,["add","more.txt"]);
  git(repo,["commit","-m","more"]);
  const reportPath=join(repo,"..","stale.report.md");
  await writeFile(reportPath,validReport(stale));
  const result=await invokeWithRepo(database,repo,"lane","complete","lane-stale","owner-1",token,stale,reportPath,"clean","ag-lane-1");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ERROR GATE");
  expect(result.stderr).toContain("branch-tip");
  const lane=await laneSnapshot(database,"lane-stale");
  expect(lane.terminalVerdict).toBeNull();
  expect(lane.state).toBe("running");
});

test("lane complete rejects a lane with no report file at all", async () => {
  const database=await db();
  const {token}=await readyLane(database,"lane-missing");
  const repo=await gitRepo();
  const reportPath=join(repo,"..","does-not-exist.report.md");
  const result=await invokeWithRepo(database,repo,"lane","complete","lane-missing","owner-1",token,tip(repo),reportPath,"clean","ag-lane-1");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ERROR GATE");
  expect(result.stderr).toContain("report-file missing");
  const lane=await laneSnapshot(database,"lane-missing");
  expect(lane.terminalVerdict).toBeNull();
  expect(lane.state).toBe("running");
});

test("lane complete rejects a report committed into its own branch (the mathematically impossible case)", async () => {
  const database=await db();
  const {token}=await readyLane(database,"lane-impossible");
  const repo=await gitRepo();
  const preReportTip=tip(repo);
  const reportInTree=join(repo,"report.md");
  await writeFile(reportInTree,validReport(preReportTip));
  git(repo,["add","report.md"]);
  git(repo,["commit","-m","report (committed into the branch, the impossible convention)"]);
  const result=await invokeWithRepo(database,repo,"lane","complete","lane-impossible","owner-1",token,preReportTip,reportInTree,"clean","ag-lane-1");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ERROR GATE");
  expect(result.stderr).toContain("branch-tip");
  const lane=await laneSnapshot(database,"lane-impossible");
  expect(lane.terminalVerdict).toBeNull();
  expect(lane.state).toBe("running");
});

test("lane complete accepts a genuinely valid, externally-pinned report, and the lane can retry after a rejection", async () => {
  const database=await db();
  const {token}=await readyLane(database,"lane-retry");
  const repo=await gitRepo();
  const stale=tip(repo);
  await writeFile(join(repo,"stale-setup.txt"),"advance the tip past `stale` before the report is written\n");
  git(repo,["add","stale-setup.txt"]);
  git(repo,["commit","-m","advance past stale"]);
  const staleReport=join(repo,"..","stale.report.md");
  await writeFile(staleReport,validReport(stale));
  const rejected=await invokeWithRepo(database,repo,"lane","complete","lane-retry","owner-1",token,stale,staleReport,"clean","ag-lane-1");
  expect(rejected.exitCode).not.toBe(0);
  // Same owner+token, same still-live lease: the lane (or the orchestrator
  // right after it, per instructions/lane-lifecycle.md) can fix the report
  // and retry, instead of discovering an unlandable branch sessions later.
  await writeFile(join(repo,"more.txt"),"more\n");
  git(repo,["add","more.txt"]);
  git(repo,["commit","-m","more"]);
  const freshTip=tip(repo);
  const fixedReport=join(repo,"..","fixed.report.md");
  await writeFile(fixedReport,validReport(freshTip));
  const accepted=await invokeWithRepo(database,repo,"lane","complete","lane-retry","owner-1",token,freshTip,fixedReport,"clean","ag-lane-1");
  expect(accepted.exitCode).toBe(0);
  expect(accepted.stdout).toContain("guard=pass");
  const lane=await laneSnapshot(database,"lane-retry");
  expect(lane.terminalVerdict).toBe("clean");
  expect(lane.terminalSha).toBe(freshTip);
});

test("lane complete rejects a caller-claimed verdict that disagrees with the report's actual result", async () => {
  const database=await db();
  const {token}=await readyLane(database,"lane-mismatch");
  const repo=await gitRepo();
  const sha=tip(repo);
  const reportPath=join(repo,"..","report.md");
  await writeFile(reportPath,validReport(sha,"clean"));
  const result=await invokeWithRepo(database,repo,"lane","complete","lane-mismatch","owner-1",token,sha,reportPath,"NO-GO","ag-lane-1");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("GATE-VERDICT-MISMATCH");
  const lane=await laneSnapshot(database,"lane-mismatch");
  expect(lane.terminalVerdict).toBeNull();
});

// ── Named leases and the reaper (instance/workboard.md V3-5.37) ─────────────
// orchestrator/launch.sh and orchestrator/watchdog.sh have called these four
// verbs since they were written. The CLI implemented none of them, so every
// start after a state DB existed died on `unknown action` -- the measured
// container refusal `launch-refused:error-unknown-action`.

// The launcher does not read the CLI's output loosely: it extracts the token
// and the current holder with two anchored sed patterns. Both are lifted out of
// launch.sh HERE rather than restated, so a launcher edit that changes what it
// expects fails these tests instead of silently failing at 03:00.
function launcherPattern(marker:string):RegExp {
  const source=readFileSync(resolve(import.meta.dir,"..","orchestrator","launch.sh"),"utf8");
  const line=source.split("\n").find((text)=>text.includes(marker));
  if(!line) throw new Error(`orchestrator/launch.sh no longer contains ${marker}`);
  const extracted=/sed -nE '[a-z]*\/(.*)\/\\1\/p'/.exec(line);
  if(!extracted) throw new Error(`cannot lift a sed pattern out of: ${line}`);
  return new RegExp(extracted[1]!);
}
const ACQUIRE_LINE=launcherPattern("^LEASE key=orchestrator owner=");
const STATUS_HOLDER=launcherPattern('"key":"orchestrator","owner":');

function owner(pid:number|string) { return `${hostname()}:${pid}`; }
async function deadPid():Promise<number> {
  const spawned=Bun.spawn(["true"],{stdout:"ignore",stderr:"ignore"});
  const pid=spawned.pid;
  await spawned.exited;
  return pid;
}
async function leases(database:string,nowMs=1000) {
  return JSON.parse((await invokeAt(database,nowMs,"status")).stdout).leases as {key:string;owner:string;fencingToken:number;expiresAt:number}[];
}

test("the launcher's lease handshake works end to end, in the exact shape launch.sh parses", async () => {
  const database=await db();
  const me=owner(process.pid);
  const acquired=await invoke(database,"lease","acquire",me,"orchestrator","180000");
  expect(acquired.exitCode).toBe(0);
  // Exact equality, not `toContain`: launch.sh's pattern is anchored at both
  // ends, so an extra field appended here makes the token unextractable and the
  // launcher tears down a provider it had already started.
  expect(acquired.stdout).toBe(`LEASE key=orchestrator owner=${me} token=1`);
  expect(ACQUIRE_LINE.exec(acquired.stdout)?.[1]).toBe("1");

  const holder=await invoke(database,"status");
  expect(STATUS_HOLDER.exec(holder.stdout)?.[1]).toBe(me);
  expect(await leases(database)).toEqual([{key:"orchestrator",owner:me,fencingToken:1,expiresAt:181000}]);

  // Renewal keeps the token and moves the deadline: the launcher renews twice
  // with the token it was handed, and the watchdog renews with it every tick.
  const renewed=await invokeAt(database,5000,"lease","renew",me,"orchestrator","1","180000");
  expect(renewed).toMatchObject({exitCode:0,stdout:`RENEW key=orchestrator owner=${me} token=1 expires_at=185000`});

  const released=await invokeAt(database,6000,"lease","release",me,"orchestrator","1");
  expect(released).toMatchObject({exitCode:0,stdout:`RELEASE key=orchestrator owner=${me}`});
  expect(await leases(database,6000)).toEqual([]);
  // A released lease leaves the key free and the fencing token behind it.
  const reacquired=await invokeAt(database,6000,"lease","acquire",owner(1),"orchestrator","180000");
  expect(reacquired.stdout).toBe(`LEASE key=orchestrator owner=${owner(1)} token=2`);
});

test("a live lease is refused to every other owner, and the refusal names the holder", async () => {
  const database=await db();
  const held=owner(process.pid);
  expect(await invoke(database,"lease","acquire",held,"orchestrator","180000")).toMatchObject({exitCode:0});
  const contended=await invoke(database,"lease","acquire",owner(99999),"orchestrator","180000");
  expect(contended.exitCode).toBe(1);
  expect(contended.stderr).toBe(`ERROR FENCED lease is held: orchestrator owner=${held} token=1 expires_at=181000`);
  // The refusal must not have moved the lease. A launcher that read a refusal
  // and a changed holder in the same breath would have nothing to trust.
  expect(await leases(database)).toEqual([{key:"orchestrator",owner:held,fencingToken:1,expiresAt:181000}]);
});

test("an expired lease is re-acquired under a NEW token and can never be renewed back to life", async () => {
  const database=await db();
  const me=owner(process.pid);
  await invoke(database,"lease","acquire",me,"orchestrator","5000");
  expect(await leases(database,7000)).toEqual([]);
  // watchdog.sh classifies exactly this as uncontested self-expiry: renewal
  // must fail (so the classification is reached at all) and re-acquisition must
  // then succeed under a token that differs from the one it just lost.
  const renewed=await invokeAt(database,7000,"lease","renew",me,"orchestrator","1","180000");
  expect(renewed).toMatchObject({exitCode:1,stderr:"ERROR FENCED stale or expired lease owner: orchestrator"});
  const reacquired=await invokeAt(database,7000,"lease","acquire",me,"orchestrator","180000");
  expect(reacquired.stdout).toBe(`LEASE key=orchestrator owner=${me} token=2`);
});

test("renew and release are fenced by owner and by token", async () => {
  const database=await db();
  const me=owner(process.pid);
  await invoke(database,"lease","acquire",me,"orchestrator","180000");
  const fenced="ERROR FENCED stale or expired lease owner: orchestrator";
  expect(await invoke(database,"lease","renew",owner(99999),"orchestrator","1","180000")).toMatchObject({exitCode:1,stderr:fenced});
  expect(await invoke(database,"lease","renew",me,"orchestrator","2","180000")).toMatchObject({exitCode:1,stderr:fenced});
  expect(await invoke(database,"lease","release",owner(99999),"orchestrator","1")).toMatchObject({exitCode:1,stderr:fenced});
  expect(await invoke(database,"lease","release",me,"orchestrator","2")).toMatchObject({exitCode:1,stderr:fenced});
  expect(await leases(database)).toEqual([{key:"orchestrator",owner:me,fencingToken:1,expiresAt:181000}]);
});

test("reap releases a dead holder's unexpired lease and refuses to touch any other kind", async () => {
  const database=await db();
  const dead=owner(await deadPid());
  const live=owner(process.pid);
  const foreign="some-other-host:1234";
  const malformed="no-pid-here";
  for (const [key,holder] of [["orchestrator",dead],["daemon",live],["remote",foreign],["garbled",malformed]] as const) {
    expect(await invoke(database,"lease","acquire",holder,key,"180000")).toMatchObject({exitCode:0});
  }
  const reaped=await invoke(database,"reap");
  expect(reaped).toMatchObject({exitCode:0,stdout:"REAP leases-reaped=1 leases-live=1 leases-expired=0 leases-unverifiable=2"});
  // Only the provably-dead holder is gone. `unverifiable` is the fail-closed
  // half and it is the majority case here on purpose: a foreign host and a
  // malformed owner are questions this reaper cannot answer, and an unanswered
  // question must not release a lease that may still have a live holder.
  expect((await leases(database)).map((lease)=>lease.key)).toEqual(["daemon","garbled","remote"]);
  // This is the launcher's actual restart path: the previous orchestrator died
  // inside its TTL, so without the reaper every start refuses with
  // `orchestrator-lease-held` until the lease ages out.
  const restarted=await invoke(database,"lease","acquire",live,"orchestrator","180000");
  expect(restarted.stdout).toBe(`LEASE key=orchestrator owner=${live} token=2`);
  expect(await invoke(database,"reap")).toMatchObject({stdout:"REAP leases-reaped=0 leases-live=2 leases-expired=0 leases-unverifiable=2"});
});

test("reap is idempotent and safe on an empty store, which is what bootstrap creates", async () => {
  const database=await db();
  expect(await invoke(database,"status")).toMatchObject({exitCode:0});
  expect(await invoke(database,"reap")).toMatchObject({exitCode:0,stdout:"REAP leases-reaped=0 leases-live=0 leases-expired=0 leases-unverifiable=0"});
  expect(await invoke(database,"reap")).toMatchObject({exitCode:0,stdout:"REAP leases-reaped=0 leases-live=0 leases-expired=0 leases-unverifiable=0"});
});

test("the lease vocabulary stays fail-closed: near-misses and bad arity are refused, not guessed at", async () => {
  const database=await db();
  const me=owner(process.pid);
  expect(await invoke(database,"lease","steal",me,"orchestrator","180000")).toMatchObject({exitCode:1,stderr:"ERROR unknown action: lease steal"});
  expect(await invoke(database,"reap","everything")).toMatchObject({exitCode:1,stderr:"ERROR unknown action: reap everything"});
  expect((await invoke(database,"lease","acquire",me,"orchestrator")).exitCode).toBe(1);
  expect((await invoke(database,"lease","acquire",me,"orchestrator","0")).stderr).toBe("ERROR lease duration must be positive");
  expect((await invoke(database,"lease","acquire","","orchestrator","180000")).stderr).toBe("ERROR lease owner is required");
  expect(await leases(database)).toEqual([]);
});

test("a lease key and a lane id can never name the same row in `status`", async () => {
  const database=await db();
  const {mission}=await readyLane(database,"lane-collision");
  expect(await invoke(database,"lease","acquire",owner(process.pid),"lane-collision","180000"))
    .toMatchObject({exitCode:1,stderr:"ERROR lease key collides with a lane: lane-collision"});
  // The other direction, from the same store: a lane may not take a live
  // lease's key either. watchdog.sh resolves the orchestrator lease with a
  // `find` over this one array, and a duplicated key makes that find arbitrary.
  await invoke(database,"lease","acquire",owner(process.pid),"orchestrator","180000");
  await invoke(database,"manager","create",mission,"mgr-collide");
  expect(await invoke(database,"lane","create",mission,"mgr-collide","orchestrator","accept","1"))
    .toMatchObject({exitCode:1,stderr:"ERROR lane id collides with a lease key: orchestrator"});
});
