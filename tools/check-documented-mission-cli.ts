#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMissionCliAction } from "../core/mission-cli-actions";

export type DocumentedInvocation = { file: string; line: number; group: string; action?: string };
export type DocumentedLandInvocation = { file: string; line: number; text: string };

type LogicalLine = { line: number; text: string; shell: boolean };

const SHELL_FENCE_LANGUAGES = new Set(["sh", "bash", "shell", "console"]);

// Join the explicit backslash continuations used by the repository's shell
// examples into one logical line, reported at its STARTING line, and track
// which fenced block each line sits in. Plain prose and soft-wrapped text
// without a shell continuation stay separate lines.
function logicalLines(source: string): LogicalLine[] {
  const lines = source.split("\n");
  const out: LogicalLine[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const fenceMatch = lines[index]!.match(/^\s*(?:```|~~~)\s*([A-Za-z0-9_+-]*)/);
    if (fenceMatch) { fence = fence === null ? fenceMatch[1]!.toLowerCase() : null; continue; }
    const start = index;
    let logical = lines[index]!;
    while (/\\\s*$/.test(logical) && index + 1 < lines.length) {
      logical = `${logical.replace(/\\\s*$/, " ")}${lines[++index]!.trimStart()}`;
    }
    out.push({ line: start + 1, text: logical, shell: fence !== null && SHELL_FENCE_LANGUAGES.has(fence) });
  }
  return out;
}

// Match executable shell calls containing `bun ...mission-cli.ts <group>
// [action]`, including quoted/variable paths and leading env settings.
export function documentedInvocations(repo: string, files: string[]): DocumentedInvocation[] {
  const found: DocumentedInvocation[] = [];
  const command = /\bbun\s+(?:"[^"]*mission-cli\.ts"|'[^']*mission-cli\.ts'|\S*mission-cli\.ts)\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/;
  for (const file of files) {
    for (const { line, text } of logicalLines(readFileSync(join(repo, file), "utf8"))) {
      const match = text.match(command);
      if (match) found.push({ file, line, group: match[1]!, action: match[2] });
    }
  }
  return found;
}

export function checkDocumentedMissionCli(repo: string, files: string[]): string[] {
  return documentedInvocations(repo, files).filter(({ group, action }) => !isMissionCliAction(group, action))
    .map(({ file, line, group, action }) => `${file}:${line}: undocumented CLI action ${group}${action ? ` ${action}` : ""}`);
}

// The landing gate is the other command this documentation tells an operator to
// run, and an invocation missing a mandatory flag is refused at usage. Only
// shell-fenced lines count: a backticked `gate/land.sh` in prose is a reference,
// not an invocation an operator would paste.
export function documentedLandInvocations(repo: string, files: string[]): DocumentedLandInvocation[] {
  const found: DocumentedLandInvocation[] = [];
  const command = /(?:"[^"]*gate\/land\.sh"|'[^']*gate\/land\.sh'|(?:^|\s)\S*gate\/land\.sh)(?=\s|$)/;
  for (const file of files) {
    for (const { line, text, shell } of logicalLines(readFileSync(join(repo, file), "utf8"))) {
      if (shell && command.test(text)) found.push({ file, line, text });
    }
  }
  return found;
}

// Derived from gate/land.sh's own usage line rather than restated here, so the
// lock cannot drift from what the gate actually requires: bracketed flags are
// the optional tail, everything outside brackets is mandatory.
export function mandatoryLandFlags(repo: string): string[] {
  const usage = readFileSync(join(repo, "gate", "land.sh"), "utf8").split("\n").find((line) => line.includes("usage: gate/land.sh"));
  if (!usage) throw new Error("cannot locate gate/land.sh usage line");
  const flags = [...new Set(usage.replace(/\[[^\]]*\]/g, " ").match(/--[a-z][a-z-]*/g) ?? [])];
  if (!flags.length) throw new Error("gate/land.sh usage line names no mandatory flags");
  return flags;
}

export function checkDocumentedLand(repo: string, files: string[]): string[] {
  const invocations = documentedLandInvocations(repo, files);
  if (!invocations.length) return [];
  const mandatory = mandatoryLandFlags(repo);
  return invocations.flatMap(({ file, line, text }) =>
    mandatory.filter((flag) => !new RegExp(`(?:^|\\s)${flag}(?=[\\s=]|$)`).test(text))
      .map((flag) => `${file}:${line}: documented gate/land.sh invocation omits mandatory ${flag}`));
}

if (import.meta.main) {
  const index = process.argv.indexOf("--repo");
  const repo = index >= 0 ? process.argv[index + 1] : process.cwd();
  if (!repo) throw new Error("--repo requires a path");
  const listed = Bun.spawnSync(["git", "-C", repo, "ls-files", "instructions", "instance"]);
  if (listed.exitCode !== 0) throw new Error("cannot enumerate tracked instruction files");
  const files = listed.stdout.toString().split("\n").filter((file) => file.endsWith(".md"));
  const errors = [...checkDocumentedMissionCli(repo, files), ...checkDocumentedLand(repo, files)];
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`DOCUMENTED-MISSION-CLI clean invocations=${documentedInvocations(repo, files).length}`);
  console.log(`DOCUMENTED-LAND clean invocations=${documentedLandInvocations(repo, files).length} mandatory=${mandatoryLandFlags(repo).join(",")}`);
}
