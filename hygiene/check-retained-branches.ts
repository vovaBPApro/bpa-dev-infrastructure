#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { spawnSync } from "child_process";

type Options = { repo: string; protectedFile: string; parkedDir: string; workboard: string; remote: string };

function fail(cause: string): never {
  console.error(`RETAINED-BRANCHES FAIL cause=${cause}`);
  process.exit(1);
}

function readableFile(path: string, label: string): string {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o444) === 0) fail(`${label}-unreadable path=${path}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`${label}-unreadable path=${path} detail=${error instanceof Error ? error.message : String(error)}`);
  }
}

function retainedBranchNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/retained branch[^\n]{0,120}\b(ag-[a-zA-Z0-9][a-zA-Z0-9._/-]*)/gi)) names.add(match[1]);
  for (const match of text.matchAll(/\b(ag-[a-zA-Z0-9][a-zA-Z0-9._/-]*)[^\n]{0,60}\bretained\b/gi)) names.add(match[1]);
  for (const match of text.matchAll(/## Retained artifact\s+Branch\s+`?(ag-[a-zA-Z0-9][a-zA-Z0-9._/-]*)/gi)) names.add(match[1]);
  return [...names].map((name) => name.replace(/\.review\.md$/, ""));
}

function parkItemId(filename: string): string | undefined {
  return filename.match(/^(V\d+-\d+(?:\.\d+)*[a-z]?)-/)?.[1];
}

function landedWorkboardItems(workboard: string): Set<string> {
  const landed = new Set<string>();
  for (const row of workboard.split("\n")) {
    const cells = row.split("|").map((cell) => cell.trim());
    const item = cells[1];
    if (/^V\d+-\d+(?:\.\d+)*[a-z]?$/.test(item ?? "") && /\*\*done\*\*/i.test(row) && /\blanded\b/i.test(row)) landed.add(item);
  }
  return landed;
}

export function expectedBranches(options: Options): Set<string> {
  const expected = new Set<string>();
  for (const raw of readableFile(options.protectedFile, "protected-list").split("\n")) {
    const name = raw.replace(/#.*/, "").trim();
    if (name) expected.add(name);
  }

  const workboard = readableFile(options.workboard, "workboard");
  const landedItems = landedWorkboardItems(workboard);
  let parkedFiles: string[];
  try {
    const stat = statSync(options.parkedDir);
    if (!stat.isDirectory() || (stat.mode & 0o555) === 0) fail(`parked-dir-unreadable path=${options.parkedDir}`);
    parkedFiles = readdirSync(options.parkedDir).filter((name) => name.endsWith(".md"));
  } catch (error) {
    fail(`parked-dir-unreadable path=${options.parkedDir} detail=${error instanceof Error ? error.message : String(error)}`);
  }
  for (const name of parkedFiles) {
    const item = parkItemId(name);
    // A park record is historical once its authoritative workboard row explicitly
    // says both done and landed. Missing or ambiguous disposition stays retained.
    if (item && landedItems.has(item)) continue;
    for (const branch of retainedBranchNames(readableFile(join(options.parkedDir, name), `park-record-${basename(name)}`))) expected.add(branch);
  }

  for (const row of workboard.split("\n")) {
    if (/\bPARKED\b|\bparked\b|\bretained\b|\bRetained\b/.test(row)) {
      for (const branch of retainedBranchNames(row)) expected.add(branch);
    }
  }
  return expected;
}

function argument(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!Bun.argv[index + 1]) fail(`argument-missing name=${name}`);
  return Bun.argv[index + 1];
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const options: Options = {
    repo: argument("--repo", root),
    protectedFile: argument("--protected-file", join(root, "instance", "hygiene-protected-branches.txt")),
    parkedDir: argument("--parked-dir", join(root, "instance", "parked")),
    workboard: argument("--workboard", join(root, "instance", "workboard.md")),
    remote: argument("--remote", "origin"),
  };
  const expected = expectedBranches(options);
  if (expected.size === 0) fail("expected-set-empty");
  const remote = spawnSync("git", ["-C", options.repo, "ls-remote", "--heads", options.remote], { encoding: "utf8" });
  if (remote.status !== 0) fail(`remote-unreachable remote=${options.remote} detail=${remote.stderr.trim() || `exit-${remote.status}`}`);
  const present = new Set(remote.stdout.split("\n").map((line) => line.match(/refs\/heads\/(.+)$/)?.[1]).filter(Boolean));
  const missing = [...expected].filter((name) => !present.has(name)).sort();
  if (missing.length) fail(`absent-from-remote remote=${options.remote} branches=${missing.join(",")}`);
  console.log(`RETAINED-BRANCHES PASS remote=${options.remote} checked=${expected.size}`);
}
