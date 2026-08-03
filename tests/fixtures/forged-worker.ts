import {readFile,writeFile} from "node:fs/promises";const e=process.env;while(true){try{await readFile(e.DISPATCH_RELEASE_PATH!);break}catch{await Bun.sleep(5)}}const attempt=Number(e.DISPATCH_ATTEMPT),ownerToken=e.DISPATCH_OWNER_TOKEN,laneId=e.DISPATCH_LANE_ID,kind=process.argv[2];await writeFile(e.DISPATCH_ACK_PATH!,JSON.stringify({attempt,ownerToken,at:new Date().toISOString()}));const sha=kind==="synthetic"?"a".repeat(40):Bun.spawnSync(["git","rev-parse","HEAD"]).stdout.toString().trim();const report=kind==="foreign"?`${e.DISPATCH_REPORT_PATH}.foreign`:e.DISPATCH_REPORT_PATH!;
// "line-injection": the report's real `commit:` line is WRONG, but the right
// sha is mentioned as a substring inside an unrelated `note:` line. A parser
// that does `report.includes("commit: <sha>")` (dispatcher.ts before
// gate/report-contract.ts was wired in) finds that substring anywhere in the
// file and wrongly accepts; a parser anchored to the actual `commit:` line
// (gate/report-contract.ts's lineValue, shared with gate/completion-guard.ts)
// reads the wrong value and correctly rejects. See orchestrator/dispatcher.test.ts.
const reportBody=kind==="line-injection"?`commit: ${"0".repeat(40)}\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: see commit: ${sha} in the log\n`:`commit: ${sha}\nverify: true\nresult: clean\nsecret-scan: clean\nremaining: none\n`;
await writeFile(report,reportBody);await writeFile(e.DISPATCH_TERMINAL_PATH!,JSON.stringify({laneId,attempt:kind==="attempt"?attempt+1:attempt,ownerToken,at:new Date().toISOString(),reportPath:report,sha,verdict:"clean"}));
