import { writeFile } from "node:fs/promises";

const pidPath=process.env.DISPATCH_CHILD_PID_PATH;
if(!pidPath)throw new Error("DISPATCH_CHILD_PID_PATH required");
await writeFile(pidPath,String(process.pid));
await new Promise(()=>{});
