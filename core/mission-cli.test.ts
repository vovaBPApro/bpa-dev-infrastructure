import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = []; const cli = resolve(import.meta.dir, "mission-cli.ts");
async function db() { const d=await mkdtemp(join(tmpdir(),"v3-cli-")); dirs.push(d); return join(d,"nested","state.sqlite"); }
async function invoke(database:string,...args:string[]) { const p=Bun.spawn([process.execPath,cli,...args],{env:{...Bun.env,INFRA_STATE_DB:database,BPA_ALLOW_TEST_CLOCK:"1",INFRA_TEST_NOW_MS:"1000"},stdout:"pipe",stderr:"pipe"}); const [stdout,stderr,exitCode]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]); return {exitCode,stdout:stdout.trim(),stderr:stderr.trim()}; }
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
function validReport(sha:string,result:"clean"|"NO-GO"="clean") { return `commit: ${sha} fixture\nverify: true\nresult: ${result}\nsecret-scan: clean\nremaining: none\n`; }
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
  expect(snapshot.missions[0]).toMatchObject({id:mission,correlation_id:"corr-1",acceptance_id:"mission-accept"});
  expect(snapshot.managers[0]).toMatchObject({id:"manager-1",mission_id:mission,parent_id:mission,depth:1});
  expect(snapshot.lanes[0]).toMatchObject({id:"lane-1",managerId:"manager-1",parentId:"manager-1",depth:2,generation:1,acceptanceId:"lane-accept",acknowledgementAt:1000,semanticEvidencePath:"/evidence/progress.json",terminalSha:sha,terminalReportPath:reportPath,terminalVerdict:"clean"});
  expect(snapshot.outbox[0]).toMatchObject({id:"msg-1",dedupeKey:"corr-1:terminal",deliveryState:"pending",payload:{kind:"terminal"}});
});

test("CLI preserves fencing across restarts", async()=>{ const database=await db(); const c=await invoke(database,"mission","create","corr","accept"); const m=/id=([^ ]+)/.exec(c.stdout)![1]!; await invoke(database,"manager","create",m,"mgr"); await invoke(database,"lane","create",m,"mgr","lane","accept","1"); const first=await invoke(database,"lane","claim","lane","one","500"); expect(first.exitCode).toBe(0); expect((await invoke(database,"lane","claim","lane","two","500")).stderr).toBe("ERROR FENCED"); });

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
