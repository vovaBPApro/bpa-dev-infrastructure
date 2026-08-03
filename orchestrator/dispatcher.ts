import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DurableStore, FencedTransitionError, type LaneRecord, type TerminalVerdict } from "../core/schema";
import { completionReportVerdict } from "../gate/report-contract";

export interface DispatchOptions { storePath:string; runtimeDir:string; worker:string[]; repoDir?:string; branch?:string; leaseMs?:number; acknowledgementMs?:number; terminalMs?:number; afterSpawnBeforePersist?:(row:LaneRecord)=>void|Promise<void>; afterPersistBeforeRelease?:(row:LaneRecord)=>void|Promise<void>; afterLaunch?:(row:LaneRecord)=>void|Promise<void> }
type Terminal={laneId:string;attempt:number;ownerToken:string;at:string;reportPath:string;sha:string;verdict:TerminalVerdict};
type Intent={laneId:string;attempt:number;ownerToken:string;worker:string[];env:Record<string,string>;phase:"intended"|"identified"|"persisted";pid?:number;startTime?:string;commandIdentity?:string[]};
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
async function authenticIntent(path:string,row:LaneRecord){try{const i=JSON.parse(await readFile(path,"utf8")) as Intent;if(!(["identified","persisted"] as unknown[]).includes(i.phase)||i.laneId!==row.id||i.attempt!==row.fencingToken||i.ownerToken!==row.leaseOwner||!i.pid||!i.startTime||!Array.isArray(i.commandIdentity))return;const live=await procIdentity(i.pid);if(!live||live.startTime!==i.startTime||JSON.stringify(live.cmdline)!==JSON.stringify(i.commandIdentity)||!live.cmdline.some(x=>x.endsWith("dispatch-wrapper.ts"))||!live.cmdline.includes(path))return;return i}catch{return}}
async function terminateIntent(i:Intent){if(!i.pid)return;const live=await procIdentity(i.pid);if(!live||live.startTime!==i.startTime)return;try{process.kill(i.pid,"SIGTERM");for(let n=0;n<50;n++){if(!(await procIdentity(i.pid)))return;await sleep(10)}const again=await procIdentity(i.pid);if(again?.startTime===i.startTime)process.kill(i.pid,"SIGKILL")}catch(e){if((e as NodeJS.ErrnoException).code!=="ESRCH")throw e}}
/* RECONCILED by V3-0.16. The JSON envelope authenticates the dispatch
 * attempt; the referenced report delegates to the real completion guard. */
export function dispatcherReportVerdict(path:string,repoDir:string,branch:string){
  return completionReportVerdict({report:path,repo:repoDir,branch});
}
async function validTerminal(path:string,row:LaneRecord,repoDir:string,branch:string):Promise<Terminal|undefined>{
  try { const t=JSON.parse(await readFile(path,"utf8")) as Terminal;
    if(typeof t!=="object"||t.laneId!==row.id||t.attempt!==row.fencingToken||t.ownerToken!==row.leaseOwner||!/^\d{4}-\d\d-\d\dT/.test(t.at)||!(["clean","NO-GO"] as unknown[]).includes(t.verdict))return;
    if(resolve(t.reportPath)!==resolve(dirname(path),"report.md")||!(await exists(t.reportPath)))return;
    const report=await readFile(t.reportPath,"utf8");
    // Deliberately uses gate/report-contract.ts's lineValue -- the same
    // anchored, single-match parser gate/completion-guard.ts uses -- instead
    // of a raw substring test. A plain `report.includes("commit: <sha>")|
    // accepted the right text ANYWHERE in the file (e.g. inside a `blocker:`
    // sentence), not only as the report's actual, singular `commit:` line.
    // This does not make the two report contracts (lane:/attempt:/commit:/
    // result: here vs commit:/verify:/result:/secret-scan:/remaining: in
    // completion-guard.ts) the same shape -- see the KNOWN DIVERGENCE note
    // below -- it only guarantees both parse whichever fields they do share
    // the same strict way.
    const reportedSha=report.match(/^commit:\s*([0-9a-f]{40})(?:\s|$)/m)?.[1];
    if(reportedSha!==t.sha||dispatcherReportVerdict(t.reportPath,repoDir,branch)!==t.verdict)return;
    return t;
  } catch { return }
}
async function stop(child:ReturnType<typeof Bun.spawn>){child.kill("SIGTERM");await Promise.race([child.exited,sleep(500)]);if(child.exitCode===null){child.kill("SIGKILL");await child.exited}}
async function failure(store:DurableStore,row:LaneRecord,reason:string,dir:string){
  if(row.retriesUsed<row.retryBudget){store.retryLane(row.id,row.leaseOwner!,row.fencingToken);return}
  const sha=Bun.spawnSync(["git","rev-parse","HEAD"]).stdout.toString().trim(), report=resolve(dir,"report.md");
  await writeFile(report,`commit: ${sha} dispatcher failure\nverify: false\nresult: NO-GO\nsecret-scan: clean\nremaining: ${reason}\n`);
  store.completeLane(row.id,row.leaseOwner!,row.fencingToken,{sha,reportPath:report,verdict:"NO-GO"});
}
export async function dispatchOnce(o:DispatchOptions):Promise<LaneRecord|undefined>{
  const store=new DurableStore(o.storePath); try {
    const ready=store.reconstruct().lanes.find(x=>x.state==="ready");if(!ready)return;
    const owner=crypto.randomUUID(),claim=store.claimLane(ready.id,owner,o.leaseMs??30_000),row=store.getLane(ready.id)!;
    const dir=dirFor(o.runtimeDir,row);await mkdir(dir,{recursive:true});const release=resolve(dir,"release"),ack=resolve(dir,"ack.json"),terminal=resolve(dir,"terminal.json"),artifact=resolve(dir,"artifact.txt");
    const log=await open(resolve(dir,"worker.log"),"a"),intentPath=intentFor(dir);
    const env={DISPATCH_RELEASE_PATH:release,DISPATCH_ACK_PATH:ack,DISPATCH_TERMINAL_PATH:terminal,DISPATCH_ARTIFACT_PATH:artifact,DISPATCH_REPORT_PATH:resolve(dir,"report.md"),DISPATCH_LANE_ID:row.id,DISPATCH_ATTEMPT:String(claim.fencingToken),DISPATCH_OWNER_TOKEN:owner,...(process.env.DISPATCH_COUNTER_PATH?{DISPATCH_COUNTER_PATH:process.env.DISPATCH_COUNTER_PATH}:{}),...(process.env.DISPATCH_WORK_MS?{DISPATCH_WORK_MS:process.env.DISPATCH_WORK_MS}:{}),...(process.env.DISPATCH_CHILD_PID_PATH?{DISPATCH_CHILD_PID_PATH:process.env.DISPATCH_CHILD_PID_PATH}:{})};
    await durableJson(intentPath,{laneId:row.id,attempt:claim.fencingToken,ownerToken:owner,worker:o.worker,env,phase:"intended"} satisfies Intent);
    const child=Bun.spawn([process.execPath,resolve(import.meta.dir,"dispatch-wrapper.ts"),intentPath],{stdin:"ignore",stdout:log.fd,stderr:log.fd});child.unref();
    await o.afterSpawnBeforePersist?.(row);
    let identity:Intent|undefined;for(let n=0;n<200&&!identity;n++){identity=await authenticIntent(intentPath,row);if(!identity)await sleep(5)}
    if(!identity){child.kill("SIGKILL");throw new Error("worker wrapper identity not confirmed")}
    await durableJson(intentPath,{...identity,phase:"persisted"} satisfies Intent);await o.afterPersistBeforeRelease?.(store.getLane(row.id)!);await writeFile(release,"go\n");await o.afterLaunch?.(store.getLane(row.id)!);
    if(!(await waitFor(ack,o.acknowledgementMs??2_000))){await stop(child);await failure(store,store.getLane(row.id)!,"worker acknowledgement timed out",dir);return row}
    const a=JSON.parse(await readFile(ack,"utf8"));if(a.attempt!==claim.fencingToken||a.ownerToken!==owner){await stop(child);await failure(store,store.getLane(row.id)!,"worker acknowledgement identity mismatch",dir);return row}
    store.acknowledgeLane(row.id,owner,claim.fencingToken);store.recordSemanticProgress(row.id,owner,claim.fencingToken,ack);
    if(!(await waitFor(terminal,o.terminalMs??5_000))){await stop(child);await failure(store,store.getLane(row.id)!,"worker terminal evidence timed out",dir);return row}
    const t=await validTerminal(terminal,store.getLane(row.id)!,o.repoDir??process.cwd(),o.branch??"HEAD");if(!t){await stop(child);await failure(store,store.getLane(row.id)!,"worker terminal evidence invalid",dir);return row}
    store.completeLane(row.id,owner,claim.fencingToken,{sha:t.sha,reportPath:t.reportPath,verdict:t.verdict});return row;
  } finally {store.close()}
}
/** Reconciles every durable intent. Pre-persist intents are terminated; persisted intents are adopted. */
export async function reconcileRunning(o:Omit<DispatchOptions,"worker">):Promise<number>{const store=new DurableStore(o.storePath);let n=0;try{for(const initial of store.reconstruct().lanes.filter(x=>x.state==="running")){let row=initial;const dir=dirFor(o.runtimeDir,row),terminal=resolve(dir,"terminal.json"),intentPath=intentFor(dir);let t=await validTerminal(terminal,row,o.repoDir??process.cwd(),o.branch??"HEAD"),identity=await authenticIntent(intentPath,row);if(!t&&identity?.phase==="identified"){await terminateIntent(identity);await failure(store,row,"dispatcher died before worker identity persistence",dir);n++;continue}if(!t&&!identity){await failure(store,row,"recovered worker process identity mismatch",dir);n++;continue}if(!t&&identity?.phase==="persisted"){const release=resolve(dir,"release");if(!(await exists(release)))await writeFile(release,"go\n");await waitFor(terminal,o.terminalMs??5_000);row=store.getLane(row.id)!;t=await validTerminal(terminal,row,o.repoDir??process.cwd(),o.branch??"HEAD");if(!t){await terminateIntent(identity);await failure(store,row,"recovered worker terminal evidence timed out",dir);n++;continue}}
    if(t){try{store.completeLane(row.id,row.leaseOwner!,row.fencingToken,{sha:t.sha,reportPath:t.reportPath,verdict:t.verdict});n++}catch(e){if(!(e instanceof FencedTransitionError))throw e}}
  }return n}finally{store.close()}}
