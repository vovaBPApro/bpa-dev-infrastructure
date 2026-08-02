import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dirs: string[] = []; const cli = resolve(import.meta.dir, "mission-cli.ts");
async function db() { const d=await mkdtemp(join(tmpdir(),"v3-cli-")); dirs.push(d); return join(d,"nested","state.sqlite"); }
async function invoke(database:string,...args:string[]) { const p=Bun.spawn([process.execPath,cli,...args],{env:{...Bun.env,INFRA_STATE_DB:database,BPA_ALLOW_TEST_CLOCK:"1",INFRA_TEST_NOW_MS:"1000"},stdout:"pipe",stderr:"pipe"}); const [stdout,stderr,exitCode]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]); return {exitCode,stdout:stdout.trim(),stderr:stderr.trim()}; }
afterEach(async()=>Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true}))));

test("restart reconstruction exposes the full executable v3 contract", async () => {
  const database=await db();
  const created=await invoke(database,"mission","create","corr-1","mission-accept");
  const mission=/id=([^ ]+)/.exec(created.stdout)![1]!;
  expect(await invoke(database,"manager","create",mission,"manager-1")).toMatchObject({exitCode:0});
  expect(await invoke(database,"lane","create",mission,"manager-1","lane-1","lane-accept","2")).toMatchObject({exitCode:0});
  const claim=await invoke(database,"lane","claim","lane-1","owner-1","500"); const token=/token=(\d+)/.exec(claim.stdout)![1]!;
  await invoke(database,"lane","ack","lane-1","owner-1",token);
  await invoke(database,"lane","progress","lane-1","owner-1",token,"/evidence/progress.json");
  await invoke(database,"outbox","enqueue","msg-1","telegram","corr-1:terminal",'{"kind":"terminal"}');
  await invoke(database,"lane","complete","lane-1","owner-1",token,"a".repeat(40),"/reports/lane-1.md","clean");
  const restarted=await invoke(database,"status"); const snapshot=JSON.parse(restarted.stdout);
  expect(snapshot.missions[0]).toMatchObject({id:mission,correlation_id:"corr-1",acceptance_id:"mission-accept"});
  expect(snapshot.managers[0]).toMatchObject({id:"manager-1",mission_id:mission,parent_id:mission,depth:1});
  expect(snapshot.lanes[0]).toMatchObject({id:"lane-1",managerId:"manager-1",parentId:"manager-1",depth:2,generation:1,acceptanceId:"lane-accept",acknowledgementAt:1000,semanticEvidencePath:"/evidence/progress.json",terminalSha:"a".repeat(40),terminalReportPath:"/reports/lane-1.md",terminalVerdict:"clean"});
  expect(snapshot.outbox[0]).toMatchObject({id:"msg-1",dedupeKey:"corr-1:terminal",deliveryState:"pending",payload:{kind:"terminal"}});
});

test("CLI preserves fencing across restarts", async()=>{ const database=await db(); const c=await invoke(database,"mission","create","corr","accept"); const m=/id=([^ ]+)/.exec(c.stdout)![1]!; await invoke(database,"manager","create",m,"mgr"); await invoke(database,"lane","create",m,"mgr","lane","accept","1"); const first=await invoke(database,"lane","claim","lane","one","500"); expect(first.exitCode).toBe(0); expect((await invoke(database,"lane","claim","lane","two","500")).stderr).toBe("ERROR FENCED"); });
