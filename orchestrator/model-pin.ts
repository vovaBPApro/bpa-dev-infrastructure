#!/usr/bin/env bun
import { readFileSync, statSync } from "node:fs";

const [paramsPath, provider, requested = ""] = process.argv.slice(2);

function refuse(cause: string): never {
  console.error(`ERROR orchestrator-model-pin ${cause}`);
  process.exit(78);
}

if (!paramsPath) refuse("cause=missing path=unset");

let text: string;
try {
  const stat = statSync(paramsPath);
  if (!stat.isFile()) refuse(`cause=malformed path=${paramsPath} detail=not-a-file`);
  // Root can read a mode-000 file, but the installed launcher must still treat
  // an operator-unreadable pin as unreadable rather than silently accepting it.
  if ((stat.mode & 0o444) === 0) refuse(`cause=unreadable path=${paramsPath}`);
  text = readFileSync(paramsPath, "utf8");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  refuse(`cause=${code === "ENOENT" ? "missing" : "unreadable"} path=${paramsPath}`);
}

const values = new Map<string, string>();
let inOrchestrator = false;
for (const raw of text.split(/\r?\n/)) {
  const line = raw.replace(/\s+#.*$/, "");
  if (/^orchestrator:\s*$/.test(line)) {
    if (inOrchestrator) refuse(`cause=malformed path=${paramsPath} detail=duplicate-section`);
    inOrchestrator = true;
    continue;
  }
  if (inOrchestrator && /^\S/.test(line) && line.trim()) break;
  if (!inOrchestrator || !line.trim()) continue;
  const match = line.match(/^  (top_provider|top_model|fallback_provider|fallback_model):\s*(\S+)\s*$/);
  if (!match) continue;
  if (values.has(match[1])) refuse(`cause=malformed path=${paramsPath} detail=duplicate-${match[1]}`);
  values.set(match[1], match[2]);
}

const providerKey = provider === "claude" ? "top_provider" : provider === "codex" ? "fallback_provider" : "";
const modelKey = provider === "claude" ? "top_model" : provider === "codex" ? "fallback_model" : "";
if (!providerKey || !modelKey) refuse(`cause=malformed path=${paramsPath} detail=provider value=${provider || "empty"}`);
const pinnedProvider = values.get(providerKey);
const pinnedModel = values.get(modelKey);
if (!pinnedProvider || !pinnedModel || pinnedProvider !== provider || !/^[a-z0-9][a-z0-9._-]*$/.test(pinnedModel)) {
  refuse(`cause=malformed path=${paramsPath} detail=${modelKey}`);
}
if (!requested) refuse(`cause=empty provider=${provider} pinned=${pinnedModel}`);
if (requested !== pinnedModel) {
  refuse(`cause=mismatch provider=${provider} pinned=${pinnedModel} live-request=${requested}`);
}

console.log(pinnedModel);
