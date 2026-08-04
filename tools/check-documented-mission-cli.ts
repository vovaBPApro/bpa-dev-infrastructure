#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMissionCliAction } from "../core/mission-cli-actions";

export type DocumentedInvocation = { file: string; line: number; group: string; action?: string };

// Match executable shell calls containing `bun ...mission-cli.ts <group>
// [action]`, including quoted/variable paths, leading env settings, and the
// explicit backslash continuations used by the repository's shell examples.
// Plain prose and soft-wrapped text without a shell continuation are excluded.
export function documentedInvocations(repo: string, files: string[]): DocumentedInvocation[] {
  const found: DocumentedInvocation[] = [];
  const command = /\bbun\s+(?:"[^"]*mission-cli\.ts"|'[^']*mission-cli\.ts'|\S*mission-cli\.ts)\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/;
  for (const file of files) {
    const lines = readFileSync(join(repo, file), "utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
      const start = index;
      let logical = lines[index]!;
      while (/\\\s*$/.test(logical) && index + 1 < lines.length) {
        logical = `${logical.replace(/\\\s*$/, " ")}${lines[++index]!.trimStart()}`;
      }
      const match = logical.match(command);
      if (match) found.push({ file, line: start + 1, group: match[1]!, action: match[2] });
    }
  }
  return found;
}

export function checkDocumentedMissionCli(repo: string, files: string[]): string[] {
  return documentedInvocations(repo, files).filter(({ group, action }) => !isMissionCliAction(group, action))
    .map(({ file, line, group, action }) => `${file}:${line}: undocumented CLI action ${group}${action ? ` ${action}` : ""}`);
}

if (import.meta.main) {
  const index = process.argv.indexOf("--repo");
  const repo = index >= 0 ? process.argv[index + 1] : process.cwd();
  if (!repo) throw new Error("--repo requires a path");
  const listed = Bun.spawnSync(["git", "-C", repo, "ls-files", "instructions", "instance"]);
  if (listed.exitCode !== 0) throw new Error("cannot enumerate tracked instruction files");
  const files = listed.stdout.toString().split("\n").filter((file) => file.endsWith(".md"));
  const errors = checkDocumentedMissionCli(repo, files);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`DOCUMENTED-MISSION-CLI clean invocations=${documentedInvocations(repo, files).length}`);
}
