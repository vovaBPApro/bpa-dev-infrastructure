import { appendFile, writeFile } from "node:fs/promises";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const ackPath = required("DISPATCH_ACK_PATH");
const terminalPath = required("DISPATCH_TERMINAL_PATH");
const artifactPath = required("DISPATCH_ARTIFACT_PATH");
const attempt = Number(required("DISPATCH_ATTEMPT"));
const counterPath = process.env.DISPATCH_COUNTER_PATH;
if (counterPath) await appendFile(counterPath, "launch\n");
await writeFile(ackPath, JSON.stringify({ at: new Date().toISOString(), attempt }));
if (process.env.DISPATCH_WORK_MS) await Bun.sleep(Number(process.env.DISPATCH_WORK_MS));
await writeFile(artifactPath, "deterministic worker artifact\n");
const reportPath = `${terminalPath}.report.md`;
await writeFile(reportPath, `worker attempt: ${attempt}\nresult: clean\n`);
await writeFile(terminalPath, JSON.stringify({
  at: new Date().toISOString(), reportPath, sha: `synthetic-${attempt}`, verdict: "clean",
}));
