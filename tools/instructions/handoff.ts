#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export const HANDOFF_SCHEMA_VERSION = 1;
export const HANDOFF_MAX_AGE_MS = 30 * 60 * 1000;
export const HANDOFF_RELATIVE_DIR = join("orchestrator", "runtime", "handoffs");

export type Worktree = { path: string; head: string; branch: string | null };
export type OpenDecision = { id: string; path: string };
export type Handoff = {
  schema_version: 1;
  source_sha: string;
  timestamp: string;
  from: string;
  to: string;
  from_vendor: string;
  from_session: string;
  to_vendor: string;
  to_session: string;
  worktrees: Worktree[];
  unlanded_reports: string[];
  open_decisions: OpenDecision[];
};

export type Validation = { valid: boolean; errors: string[]; ageMs?: number };

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

export function collectWorktrees(repo: string): Worktree[] {
  const records = git(repo, ["worktree", "list", "--porcelain"]).split(/\n\n+/);
  return records.filter(Boolean).map((record) => {
    let path = "";
    let head = "";
    let branch: string | null = null;
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    return { path, head, branch };
  });
}

function frontmatterValue(contents: string, key: string): string | undefined {
  const block = contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const line = block?.[1].split(/\r?\n/).find((candidate) => new RegExp(`^${key}\\s*:`).test(candidate));
  return line?.replace(new RegExp(`^${key}\\s*:\\s*`), "").trim().replace(/^["']|["']$/g, "");
}

export function collectOpenDecisions(repo: string): OpenDecision[] {
  const dir = join(repo, "instance", "decisions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().filter((name) => /^HR-.+\.md$/i.test(name)).flatMap((name) => {
    const contents = readFileSync(join(dir, name), "utf8");
    if (frontmatterValue(contents, "state") !== "pending") return [];
    return [{ id: frontmatterValue(contents, "id") ?? name.replace(/\.md$/, ""), path: `instance/decisions/${name}` }];
  });
}

export function collectReports(reportsDir: string): string[] {
  if (!existsSync(reportsDir)) return [];
  return readdirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(resolve(reportsDir), entry.name))
    .sort();
}

export function buildHandoff(repo: string, reportsDir: string, values: {
  ts: string; from: string; to: string;
  fromVendor: string; fromSession: string; toVendor: string; toSession: string;
}): Handoff {
  return {
    schema_version: HANDOFF_SCHEMA_VERSION,
    source_sha: git(repo, ["rev-parse", "HEAD"]),
    timestamp: values.ts,
    from: values.from,
    to: values.to,
    from_vendor: values.fromVendor,
    from_session: values.fromSession,
    to_vendor: values.toVendor,
    to_session: values.toSession,
    worktrees: collectWorktrees(repo),
    unlanded_reports: collectReports(reportsDir),
    open_decisions: collectOpenDecisions(repo),
  };
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) throw new Error("handoff endpoint produces an empty filename component");
  return cleaned;
}

export function handoffFilename(handoff: Handoff): string {
  return `${handoff.timestamp.replace(/:/g, "-")}-${safeName(handoff.from)}-to-${safeName(handoff.to)}.json`;
}

export function writeHandoff(repo: string, handoff: Handoff): string {
  const validation = validateHandoff(handoff, Date.parse(handoff.timestamp));
  if (!validation.valid) throw new Error(validation.errors.join("; "));
  const dir = join(repo, HANDOFF_RELATIVE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, handoffFilename(handoff));
  writeFileSync(path, JSON.stringify(handoff, null, 2) + "\n", { flag: "wx" });
  return path;
}

export function validateHandoff(value: unknown, nowMs: number, maxAgeMs = HANDOFF_MAX_AGE_MS): Validation {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["handoff must be an object"] };
  const row = value as Record<string, unknown>;
  const keys = ["source_sha", "timestamp", "from", "to", "from_vendor", "from_session", "to_vendor", "to_session"];
  if (row.schema_version !== 1) errors.push("schema_version must equal 1");
  for (const key of keys) if (typeof row[key] !== "string" || row[key] === "") errors.push(`${key} must be a non-empty string`);
  if (typeof row.source_sha === "string" && !/^[0-9a-f]{40}$/.test(row.source_sha)) errors.push("source_sha must be a full 40-character lowercase SHA");
  for (const key of ["worktrees", "unlanded_reports", "open_decisions"]) if (!Array.isArray(row[key])) errors.push(`${key} must be an array`);
  if (Array.isArray(row.worktrees)) row.worktrees.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) errors.push(`worktrees[${index}] must be an object`);
    else {
      const wt = item as Record<string, unknown>;
      if (typeof wt.path !== "string" || !wt.path) errors.push(`worktrees[${index}].path must be non-empty`);
      if (typeof wt.head !== "string" || !/^[0-9a-f]{40}$/.test(wt.head)) errors.push(`worktrees[${index}].head must be a full SHA`);
      if (!(typeof wt.branch === "string" || wt.branch === null)) errors.push(`worktrees[${index}].branch must be string or null`);
    }
  });
  if (Array.isArray(row.unlanded_reports) && !row.unlanded_reports.every((item) => typeof item === "string" && item.length > 0)) errors.push("unlanded_reports entries must be non-empty strings");
  if (Array.isArray(row.open_decisions)) row.open_decisions.forEach((item, index) => {
    const decision = item as Record<string, unknown> | null;
    if (!decision || typeof decision.id !== "string" || !decision.id || typeof decision.path !== "string" || !decision.path) errors.push(`open_decisions[${index}] must contain non-empty id and path`);
  });
  const timestampMs = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
  let ageMs: number | undefined;
  if (!Number.isFinite(timestampMs)) errors.push("timestamp must be a valid ISO date-time");
  else {
    ageMs = nowMs - timestampMs;
    if (ageMs < 0) errors.push(`handoff timestamp is ${-ageMs}ms in the future`);
    else if (ageMs > maxAgeMs) errors.push(`handoff is stale: age ${ageMs}ms exceeds ${maxAgeMs}ms`);
  }
  return { valid: errors.length === 0, errors, ageMs };
}

export function latestHandoffPath(repo: string): string | undefined {
  const dir = join(repo, HANDOFF_RELATIVE_DIR);
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return names.length ? join(dir, names[names.length - 1]) : undefined;
}

function usage(code: number): never {
  const out = code ? process.stderr : process.stdout;
  out.write("Usage:\n  bun tools/instructions/handoff.ts write --ts <ISO> --from <name> --to <name> --from-vendor <v> --from-session <id> --to-vendor <v> --to-session <id> --reports-dir <path> [--repo <path>]\n  bun tools/instructions/handoff.ts validate --file <json> --now-ms <epoch-ms> [--max-age-ms <ms>]\n");
  process.exit(code);
}

function argsMap(args: string[]): { command: string; values: Map<string, string> } {
  const command = args.shift();
  if (command !== "write" && command !== "validate") usage(2);
  const values = new Map<string, string>();
  while (args.length) {
    const key = args.shift()!;
    if (!key.startsWith("--") || !args[0] || args[0].startsWith("--")) usage(2);
    values.set(key, args.shift()!);
  }
  return { command, values };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`missing ${key}`);
  return value;
}

if (import.meta.main) {
  try {
    const { command, values } = argsMap(process.argv.slice(2));
    if (command === "write") {
      const repo = resolve(values.get("--repo") ?? process.cwd());
      const handoff = buildHandoff(repo, required(values, "--reports-dir"), {
        ts: required(values, "--ts"), from: required(values, "--from"), to: required(values, "--to"),
        fromVendor: required(values, "--from-vendor"), fromSession: required(values, "--from-session"),
        toVendor: required(values, "--to-vendor"), toSession: required(values, "--to-session"),
      });
      console.log(relative(repo, writeHandoff(repo, handoff)));
    } else {
      const path = resolve(required(values, "--file"));
      const nowMs = Number(required(values, "--now-ms"));
      const maxAgeMs = values.has("--max-age-ms") ? Number(values.get("--max-age-ms")) : HANDOFF_MAX_AGE_MS;
      if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs)) throw new Error("--now-ms and --max-age-ms must be numbers");
      const validation = validateHandoff(JSON.parse(readFileSync(path, "utf8")), nowMs, maxAgeMs);
      if (!validation.valid) {
        console.error(`FAIL ${basename(path)}: ${validation.errors.join("; ")}`);
        process.exit(1);
      }
      console.log(`PASS ${basename(path)}: schema valid, fresh (age ${validation.ageMs}ms)`);
    }
  } catch (error) {
    console.error(`handoff: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
