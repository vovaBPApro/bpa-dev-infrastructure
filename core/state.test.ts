import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { DurableStore, StateStore } from "./state";

const paths:string[]=[]; let serial=0;
const open=(now=1000)=>{const path=`/tmp/v3-state-seam-${process.pid}-${serial++}.sqlite`;paths.push(path);return {path,store:new StateStore(path,{now:()=>now})};};
afterEach(()=>{for(const path of paths.splice(0))for(const suffix of ["","-wal","-shm"])if(existsSync(path+suffix))rmSync(path+suffix);});
const seed=(store:DurableStore)=>{store.createMission({id:"mission-1",correlationId:"corr-1",acceptanceId:"mission-accept"});store.createManager({id:"manager-1",missionId:"mission-1",parentId:"mission-1",depth:1});store.createLane({id:"lane-1",missionId:"mission-1",managerId:"manager-1",parentId:"manager-1",depth:2,retryBudget:1,acceptanceId:"lane-accept"});};

test("state import seam is the schema store, not a parallel database",()=>{expect(StateStore).toBe(DurableStore);const {store}=open();expect(store.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{name:"lanes"},{name:"managers"},{name:"missions"},{name:"outbox"}]);store.close();});

test("OLD mailbox-replay fixture executes against restart reconstruction",()=>{const {path,store}=open();seed(store);store.enqueueOutbox({id:"message-1",channel:"mailbox",dedupeKey:"corr-1:message-1",payload:{taskId:"task-1"}});store.markOutboxAttempt("message-1","delivered");store.close();const restarted=new StateStore(path);expect(restarted.reconstruct().outbox).toEqual([expect.objectContaining({id:"message-1",dedupeKey:"corr-1:message-1",deliveryState:"delivered",attempts:1,payload:{taskId:"task-1"}})]);expect(()=>restarted.enqueueOutbox({id:"replay",channel:"mailbox",dedupeKey:"corr-1:message-1",payload:{taskId:"task-1"}})).toThrow();restarted.close();});

test("OLD handoff-record fixture executes append-only semantic and terminal evidence",()=>{const {path,store}=open();seed(store);const claim=store.claimLane("lane-1","bill",100);store.acknowledgeLane("lane-1","bill",claim.fencingToken);store.recordSemanticProgress("lane-1","bill",claim.fencingToken,"artifact://bill/report");store.completeLane("lane-1","bill",claim.fencingToken,{sha:"b".repeat(40),reportPath:"artifact://bill/terminal",verdict:"clean"});store.close();const audit=new StateStore(path).reconstruct().lanes[0]!;expect(audit).toMatchObject({acknowledgementAt:1000,generation:1,semanticEvidencePath:"artifact://bill/report",terminalSha:"b".repeat(40),terminalReportPath:"artifact://bill/terminal",terminalVerdict:"clean"});});
