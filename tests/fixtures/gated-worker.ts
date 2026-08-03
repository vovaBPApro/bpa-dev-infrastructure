import { readFile, writeFile } from "node:fs/promises";
const env=process.env;
const required=(key:string)=>{const value=env[key];if(!value)throw new Error(`missing ${key}`);return value};
const release=required("DISPATCH_RELEASE_PATH");
for(;;){try{await readFile(release);break}catch{await Bun.sleep(10)}}
const counter=required("DISPATCH_COUNTER_PATH");await writeFile(counter,"launch\n",{flag:"a"});
const attempt=Number(required("DISPATCH_ATTEMPT")),ownerToken=required("DISPATCH_OWNER_TOKEN"),laneId=required("DISPATCH_LANE_ID");
await writeFile(required("DISPATCH_ACK_PATH"),JSON.stringify({attempt,ownerToken,at:new Date().toISOString()}));
const sha=Bun.spawnSync(["git","rev-parse","HEAD"]).stdout.toString().trim(),report=required("DISPATCH_REPORT_PATH");
await writeFile(report,`commit: ${sha} synthetic worker\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n`);
await writeFile(required("DISPATCH_TERMINAL_PATH"),JSON.stringify({laneId,attempt,ownerToken,at:new Date().toISOString(),reportPath:report,sha,verdict:"clean"}));
