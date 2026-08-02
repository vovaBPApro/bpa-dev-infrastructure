import { readFile, rename, writeFile } from "node:fs/promises";

const intentPath=process.argv[2];
if(!intentPath)throw new Error("intent path required");
const intent=JSON.parse(await readFile(intentPath,"utf8"));
const stat=await readFile(`/proc/${process.pid}/stat`,"utf8");
const end=stat.lastIndexOf(") ");
const startTime=stat.slice(end+2).trim().split(/\s+/)[19];
if(!/^\d+$/.test(startTime))throw new Error("process start-time unavailable");
const commandIdentity=(await readFile(`/proc/${process.pid}/cmdline`)).toString().split("\0").filter(Boolean);
const identified={...intent,pid:process.pid,startTime,commandIdentity,phase:"identified"};
const temporary=`${intentPath}.${process.pid}.tmp`;
await writeFile(temporary,JSON.stringify(identified));
await rename(temporary,intentPath);

const worker=Bun.spawn(intent.worker,{stdin:"ignore",stdout:"inherit",stderr:"inherit",env:{...process.env,...intent.env}});
let stopping=false;
const stop=(signal:"SIGTERM"|"SIGINT")=>{if(stopping)return;stopping=true;worker.kill(signal);setTimeout(()=>worker.kill("SIGKILL"),500)};
process.on("SIGTERM",()=>stop("SIGTERM"));
process.on("SIGINT",()=>stop("SIGINT"));
process.exit(await worker.exited);
