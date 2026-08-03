import { appendFile, readFile, writeFile } from "node:fs/promises";
const req=(n:string)=>{const v=process.env[n];if(!v)throw new Error(`${n} required`);return v};
const release=req("DISPATCH_RELEASE_PATH");
for(let i=0;i<200;i++){try{await readFile(release);break}catch{if(i===199)process.exit(70);await Bun.sleep(10)}}
const ack=req("DISPATCH_ACK_PATH"),terminal=req("DISPATCH_TERMINAL_PATH"),artifact=req("DISPATCH_ARTIFACT_PATH"),report=req("DISPATCH_REPORT_PATH");
const attempt=Number(req("DISPATCH_ATTEMPT")),ownerToken=req("DISPATCH_OWNER_TOKEN"),laneId=req("DISPATCH_LANE_ID");
if(process.env.DISPATCH_COUNTER_PATH)await appendFile(process.env.DISPATCH_COUNTER_PATH,"launch\n");
await writeFile(ack,JSON.stringify({at:new Date().toISOString(),attempt,ownerToken}));
if(process.env.DISPATCH_WORK_MS)await Bun.sleep(Number(process.env.DISPATCH_WORK_MS));
await writeFile(artifact,"deterministic worker artifact\n");
const sha=Bun.spawnSync(["git","rev-parse","HEAD"]).stdout.toString().trim();
await writeFile(report,`commit: ${sha} synthetic worker\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n`);
await writeFile(terminal,JSON.stringify({laneId,attempt,ownerToken,at:new Date().toISOString(),reportPath:report,sha,verdict:"clean"}));
