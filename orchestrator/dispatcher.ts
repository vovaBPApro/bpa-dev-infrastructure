import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DurableStore, FencedTransitionError, type LaneRecord, type TerminalVerdict } from "../core/schema";

export interface DispatchOptions { storePath:string; runtimeDir:string; worker:string[]; leaseMs?:number; acknowledgementMs?:number; terminalMs?:number; afterSpawnBeforePersist?:(row:LaneRecord)=>void|Promise<void>; afterPersistBeforeRelease?:(row:LaneRecord)=>void|Promise<void>; afterLaunch?:(row:LaneRecord)=>void|Promise<void> }
type Terminal={laneId:string;attempt:number;ownerToken:string;at:string;reportPath:string;sha:string;verdict:TerminalVerdict};
type Intent={laneId:string;attempt:number;ownerToken:string;worker:string[];env:Record<string,string>;phase:"intended"|"identified";pid?:number;startTime?:string;commandIdentity?:string[]};
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
const exists=async(p:string)=>{try{await stat(p);return true}catch{return false}};
const waitFor=async(p:string,n:number)=>{const end=Date.now()+n;do{if(await exists(p))return true;await sleep(10)}while(Date.now()<end);return exists(p)};
const dirFor=(root:string,row:LaneRecord)=>resolve(root,row.id,`attempt-${row.fencingToken}`);
const intentFor=(dir:string)=>resolve(dir,"worker-intent.json");
export async function durableJson(path:string,value:unknown){
  const temporary=`${path}.${process.pid}.tmp`;
  const file=await open(temporary,"w");
  try{await file.writeFile(JSON.stringify(value));await file.sync()}finally{await file.close()}
  await rename(temporary,path);
  const directory=await open(dirname(path),"r");
  try{await directory.sync()}finally{await directory.close()}
}
async function procIdentity(pid:number){try{const raw=await readFile(`/proc/${pid}/stat`,"utf8"),end=raw.lastIndexOf(") ");if(end<0)return;const startTime=raw.slice(end+2).trim().split(/\s+/)[19],cmdline=(await readFile(`/proc/${pid}/cmdline`)).toString().split("\0").filter(Boolean);return /^\d+$/.test(startTime)?{startTime,cmdline}:undefined}catch{return}}
async function authenticIntent(path:string,row:LaneRecord){try{const i=JSON.parse(await readFile(path,"utf8")) as Intent;if(i.phase!=="identified"||i.laneId!==row.id||i.attempt!==row.fencingToken||i.ownerToken!==row.leaseOwner||!i.pid||!i.startTime||!Array.isArray(i.commandIdentity))return;const live=await procIdentity(i.pid);if(!live||live.startTime!==i.startTime||JSON.stringify(live.cmdline)!==JSON.stringify(i.commandIdentity)||!live.cmdline.some(x=>x.endsWith("dispatch-wrapper.ts"))||!live.cmdline.includes(path))return;return i}catch{return}}
async function terminateIntent(i:Intent){if(!i.pid)return;const live=await procIdentity(i.pid);if(!live||live.startTime!==i.startTime)return;try{process.kill(i.pid,"SIGTERM");for(let n=0;n<50;n++){if(!(await procIdentity(i.pid)))return;await sleep(10)}const again=await procIdentity(i.pid);if(again?.startTime===i.startTime)process.kill(i.pid,"SIGKILL")}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw e}}
async function validTerminal(path:string,row:LaneRecord):Promise<Terminal|undefined>{
  try { const t=JSON.parse(await readFile(path,"utf8")) as Terminal;
    if(typeof t!=="object"||t.laneId!==row.id||t.attempt!==row.fencingToken||t.ownerToken!==row.leaseOwner||!/^\d{4}-\d\d-\d\dT/.test(t.at)||!(["clean","NO-GO"] as unknown[]).includes(t.verdict))return;
    if(resolve(t.reportPath)!==resolve(dirname(path),"report.md")||!(await exists(t.reportPath)))return;
    const git=Bun.spawnSync(["git","cat-file","-e",`${t.sha}^{commit}`]); if(git.exitCode!==0)return;
    const report=await readFile(t.reportPath,"utf8");
    if(!report.includes(`lane: ${row.id}`)||!report.includes(`attempt: ${row.fencingToken}`)||!report.includes(`commit: ${t.sha}`)||!report.includes(`result: ${t.verdict}`))return;
    return t;
  } catch { return }
}
async function stop(child:ReturnType<typeof Bun.spawn>){child.kill("SIGTERM");await Promise.race([child.exited,sleep(500)]);if(child.exitCode===null){child.kill("SIGKILL");await child.exited}}
async function failure(store:DurableStore,row:LaneRecord,reason:string,dir:string){
  if(row.retriesUsed<row.retryBudget){store.retryLane(row.id,row.leaseOwner!,row.fencingToken);return}
  const sha=Bun.spawnSync(["git","rev-parse","HEAD"]).stdout.toString().trim(), report=resolve(dir,"report.md");
  await writeFile(report,`lane: ${row.id}\nattempt: ${row.fencingToken}\ncommit: ${sha}\nresult: NO-GO\nblocker: ${reason}\n`);
  store.completeLane(row.id,row.leaseOwner!,row.fencingToken,{sha,reportPath:report,verdict:"NO-GO"});
}
export async function dispatchOnce(o:DispatchOptions):Promise<LaneRecord|undefined>{
  const store=new DurableStore(o.storePath); try {
    const ready=store.readyLane();if(!ready)return;
    const owner=crypto.randomUUID(),claim=store.claimLane(ready.id,owner,o.leaseMs??30_000),row=store.getLane(ready.id)!;
    const dir=dirFor(o.runtimeDir,row);await mkdir(dir,{recursive:true});const release=resolve(dir,"release"),ack=resolve(dir,"ack.json"),terminal=resolve(dir,"terminal.json"),artifact=resolve(dir,"artifact.txt");
    const log=await open(resolve(dir,"worker.log"),"a"),intentPath=intentFor(dir);
    const env={DISPATCH_RELEASE_PATH:release,DISPATCH_ACK_PATH:ack,DISPATCH_TERMINAL_PATH:terminal,DISPATCH_ARTIFACT_PATH:artifact,DISPATCH_REPORT_PATH:resolve(dir,"report.md"),DISPATCH_LANE_ID:row.id,DISPATCH_ATTEMPT:String(claim.fencingToken),DISPATCH_OWNER_TOKEN:owner,...(process.env.DISPATCH_COUNTER_PATH?{DISPATCH_COUNTER_PATH:process.env.DISPATCH_COUNTER_PATH}:{}),...(process.env.DISPATCH_WORK_MS?{DISPATCH_WORK_MS:process.env.DISPATCH_WORK_MS}:{}),...(process.env.DISPATCH_CHILD_PID_PATH?{DISPATCH_CHILD_PID_PATH:process.env.DISPATCH_CHILD_PID_PATH}:{})};
    await durableJson(intentPath,{laneId:row.id,attempt:claim.fencingToken,ownerToken:owner,worker:o.worker,env,phase:"intended"} satisfies Intent);
    const child=Bun.spawn([process.execPath,resolve(import.meta.dir,"dispatch-wrapper.ts"),intentPath],{stdin:"ignore",stdout:log.fd,stderr:log.fd});child.unref();
    await o.afterSpawnBeforePersist?.(row);
    let identity:Intent|undefined;for(let n=0;n<200&&!identity;n++){identity=await authenticIntent(intentPath,row);if(!identity)await sleep(5)}
    if(!identity){child.kill("SIGKILL");throw new Error("worker wrapper identity not confirmed")}
    store.recordWorker(row.id,owner,claim.fencingToken,identity.pid!);await o.afterPersistBeforeRelease?.(store.getLane(row.id)!);await writeFile(release,"go\n");await o.afterLaunch?.(store.getLane(row.id)!);
    if(!(await waitFor(ack,o.acknowledgementMs??2_000))){await stop(child);await failure(store,store.getLane(row.id)!,"worker acknowledgement timed out",dir);return row}
    const a=JSON.parse(await readFile(ack,"utf8"));if(a.attempt!==claim.fencingToken||a.ownerToken!==owner){await stop(child);await failure(store,store.getLane(row.id)!,"worker acknowledgement identity mismatch",dir);return row}
    store.acknowledgeLane(row.id,owner,claim.fencingToken);store.recordSemanticProgress(row.id,owner,claim.fencingToken,ack);
    if(!(await waitFor(terminal,o.terminalMs??5_000))){await stop(child);await failure(store,store.getLane(row.id)!,"worker terminal evidence timed out",dir);return row}
    const t=await validTerminal(terminal,store.getLane(row.id)!);if(!t){await stop(child);await failure(store,store.getLane(row.id)!,"worker terminal evidence invalid",dir);return row}
    store.completeLane(row.id,owner,claim.fencingToken,{sha:t.sha,reportPath:t.reportPath,verdict:t.verdict});return row;
  } finally {store.close()}
}
/** Reconciles every durable intent. Claimed intents are terminated; confirmed running intents are adopted. */
export async function reconcileRunning(o:Omit<DispatchOptions,"worker">):Promise<number>{const store=new DurableStore(o.storePath);let n=0;try{for(const initial of store.lanes().filter(x=>x.state==="claimed"||x.state==="running")){let row=initial;const dir=dirFor(o.runtimeDir,row),terminal=resolve(dir,"terminal.json"),intentPath=intentFor(dir);let t=await validTerminal(terminal,row),identity=await authenticIntent(intentPath,row);if(!t&&row.state==="claimed"){if(identity)await terminateIntent(identity);await failure(store,row,"dispatcher died before worker identity confirmation",dir);n++;continue}if(!t&&row.state==="running"&&(!identity||identity.pid!==row.workerPid)){await failure(store,row,"recovered worker process identity mismatch",dir);n++;continue}if(!t&&row.state==="running"&&row.workerPid!==null&&identity?.pid===row.workerPid){const release=resolve(dir,"release");if(!(await exists(release)))await writeFile(release,"go\n");await waitFor(terminal,o.terminalMs??5_000);row=store.getLane(row.id)!;t=await validTerminal(terminal,row);if(!t){await terminateIntent(identity);await failure(store,row,"recovered worker terminal evidence timed out",dir);n++;continue}}
    if(t){try{store.completeLane(row.id,row.leaseOwner!,row.fencingToken,{sha:t.sha,reportPath:t.reportPath,verdict:t.verdict});n++}catch(e){if(!(e instanceof FencedTransitionError))throw e}}
  }return n}finally{store.close()}}
