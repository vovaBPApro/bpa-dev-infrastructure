import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DurableStore, FencedTransitionError, type LaneRecord, type TerminalVerdict } from "../core/schema";

export interface DispatchOptions { storePath:string; runtimeDir:string; worker:string[]; leaseMs?:number; acknowledgementMs?:number; terminalMs?:number; afterSpawnBeforePersist?:(row:LaneRecord)=>void|Promise<void>; afterLaunch?:(row:LaneRecord)=>void|Promise<void> }
type Terminal={laneId:string;attempt:number;ownerToken:string;at:string;reportPath:string;sha:string;verdict:TerminalVerdict};
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n));
const exists=async(p:string)=>{try{await stat(p);return true}catch{return false}};
const waitFor=async(p:string,n:number)=>{const end=Date.now()+n;do{if(await exists(p))return true;await sleep(10)}while(Date.now()<end);return exists(p)};
const dirFor=(root:string,row:LaneRecord)=>resolve(root,row.id,`attempt-${row.fencingToken}`);
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
    const log=await open(resolve(dir,"worker.log"),"a");
    const child=Bun.spawn(o.worker,{stdin:"ignore",stdout:log.fd,stderr:log.fd,env:{...process.env,DISPATCH_RELEASE_PATH:release,DISPATCH_ACK_PATH:ack,DISPATCH_TERMINAL_PATH:terminal,DISPATCH_ARTIFACT_PATH:artifact,DISPATCH_REPORT_PATH:resolve(dir,"report.md"),DISPATCH_LANE_ID:row.id,DISPATCH_ATTEMPT:String(claim.fencingToken),DISPATCH_OWNER_TOKEN:owner}});child.unref();
    await o.afterSpawnBeforePersist?.(row); // adversarial crash hook: worker remains gated
    store.recordWorker(row.id,owner,claim.fencingToken,child.pid);await writeFile(release,"go\n");await o.afterLaunch?.(store.getLane(row.id)!);
    if(!(await waitFor(ack,o.acknowledgementMs??2_000))){await stop(child);await failure(store,store.getLane(row.id)!,"worker acknowledgement timed out",dir);return row}
    const a=JSON.parse(await readFile(ack,"utf8"));if(a.attempt!==claim.fencingToken||a.ownerToken!==owner){await stop(child);await failure(store,store.getLane(row.id)!,"worker acknowledgement identity mismatch",dir);return row}
    store.acknowledgeLane(row.id,owner,claim.fencingToken);store.recordSemanticProgress(row.id,owner,claim.fencingToken,ack);
    if(!(await waitFor(terminal,o.terminalMs??5_000))){await stop(child);await failure(store,store.getLane(row.id)!,"worker terminal evidence timed out",dir);return row}
    const t=await validTerminal(terminal,store.getLane(row.id)!);if(!t){await stop(child);await failure(store,store.getLane(row.id)!,"worker terminal evidence invalid",dir);return row}
    store.completeLane(row.id,owner,claim.fencingToken,{sha:t.sha,reportPath:t.reportPath,verdict:t.verdict});return row;
  } finally {store.close()}
}
/** Reconciles both pre-PID claimed rows and running rows without duplicate launch. */
export async function reconcileRunning(o:Omit<DispatchOptions,"worker">):Promise<number>{const store=new DurableStore(o.storePath);let n=0;try{for(const row of store.lanes().filter(x=>x.state==="claimed"||x.state==="running")){const t=await validTerminal(resolve(dirFor(o.runtimeDir,row),"terminal.json"),row);if(t){try{store.completeLane(row.id,row.leaseOwner!,row.fencingToken,{sha:t.sha,reportPath:t.reportPath,verdict:t.verdict});n++}catch(e){if(!(e instanceof FencedTransitionError))throw e}}}return n}finally{store.close()}}
