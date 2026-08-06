#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = { id: string; kind: string; target: string };

function fail(message: string): never {
  throw new Error(`MECHANISM-REACHABILITY ${message}`);
}

function read(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch { fail(`unreadable file: ${path}`); }
}

function rows(path: string, columns: number): string[][] {
  const parsed = read(path).split("\n").filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("\t"));
  if (parsed.length === 0) fail(`empty manifest: ${path}`);
  for (const row of parsed) if (row.length !== columns || row.some((v) => !v.trim())) fail(`malformed row: ${row.join("\\t")}`);
  return parsed;
}

export function check(repo: string): string[] {
  const manifestPath = join(repo, "instance/expected-mechanisms.tsv");
  const requiredPath = join(repo, "instance/required-mechanisms.tsv");
  const exclusionPath = join(repo, "instance/expected-mechanism-exclusions.tsv");
  const manifest = rows(manifestPath, 3).map(([id, kind, target]) => ({ id, kind, target }));
  const required = rows(requiredPath, 3).map((row) => row.join("\t")).sort();
  const exclusions = new Map(rows(exclusionPath, 2).map(([id, reason]) => [id, reason]));
  const ids = new Set<string>();
  const errors: string[] = [];
  const observed = manifest.map(({ id, kind, target }) => [id, kind, target].join("\t")).sort();
  if (JSON.stringify(observed) !== JSON.stringify(required)) errors.push("mechanism inventory differs from independent required-mechanisms.tsv");
  for (const row of manifest) {
    if (ids.has(row.id)) errors.push(`duplicate mechanism: ${row.id}`);
    ids.add(row.id);
    if (!existsSync(join(repo, row.target))) errors.push(`missing mechanism: ${row.id} target=${row.target}`);
  }

  // Units are independently pinned by expected-units.tsv. Comparing both sets
  // means deleting either a template or a reachability row cannot shrink truth.
  const expectedUnits = rows(join(repo, "instance/expected-units.tsv"), 2).map(([unit]) => `unit:${unit}`).sort();
  const unitRows = manifest.filter((r) => r.kind === "systemd").map((r) => r.id).sort();
  if (JSON.stringify(unitRows) !== JSON.stringify(expectedUnits)) errors.push("systemd inventory differs from independent expected-units.tsv");

  const tracked = (suffix: string) => Bun.spawnSync(["git", "-C", repo, "ls-files", "-z", suffix]).stdout.toString().split("\0").filter(Boolean);
  const trackedCheckers = [...tracked("tools/check*.sh"), ...tracked("tools/check*.ts"), ...tracked("hygiene/check*.sh"), ...tracked("hygiene/check*.ts")]
    .filter((file) => !file.includes(".test.")).sort();
  const checkerRows = manifest.filter((r) => r.kind === "checker").map((r) => r.target).sort();
  if (JSON.stringify(checkerRows) !== JSON.stringify(trackedCheckers)) errors.push("checker inventory differs from tracked checker files");

  const allText = new Map<string, string>();
  for (const file of tracked("*.ts").concat(tracked("*.sh"), tracked("*.in"))) allText.set(file, read(join(repo, file)));
  const parked = new Set(tracked("instance/parked/*.md"));
  const hasArmEdge = (unit: string) => [...allText].some(([file, text]) =>
    !parked.has(file) && !file.endsWith(".test.ts") && !file.endsWith(".test.sh") &&
    new RegExp(`systemctl(?:[^\\n]*)enable(?:[^\\n]*)${unit.replaceAll(".", "\\.")}`).test(
      text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n"),
    ));
  function reachable(row: Row): boolean {
    if (row.kind === "systemd") {
      const unit = row.id.slice(5);
      if (hasArmEdge(unit)) return true;
      if (unit.endsWith(".timer")) return false;
      return manifest.filter((candidate) => candidate.kind === "systemd" && candidate.id.endsWith(".timer"))
        .some((timer) => read(join(repo, timer.target)).includes(`Unit=${unit}`) && hasArmEdge(timer.id.slice(5)));
    }
    if (row.kind === "gate") return read(join(repo, "tools/shell-test-tier.test.ts")).includes("gate/land.test.sh");
    if (row.kind === "shell-tier") return read(join(repo, "gate/land-lib.sh")).includes("*.test.ts");
    if (row.kind === "cron") return read(join(repo, "bootstrap/install.sh")).includes("install_hygiene_cron") && read(join(repo, "bootstrap/install.sh")).includes("install_hygiene_cron\n");
    // A host-tooling installer is reachable only when bootstrap both DEFINES
    // its step and CALLS it. The generic text scan at the end of this function
    // would be satisfied by any file containing the basename "install.sh",
    // which is most of this tree -- so a mechanism no clean server ever runs
    // would read as reachable, which is precisely the state gate G found
    // Whisper in (tracked installer, nothing invoking it).
    if (row.kind === "installer") {
      const step = `install_${row.id.slice("installer:".length).replaceAll("-", "_")}`;
      const lines = read(join(repo, "bootstrap/install.sh")).split("\n").map((line) => line.trim());
      return lines.includes(`${step}() {`) && lines.includes(step);
    }
    const needle = row.target.split("/").at(-1)!;
    return [...allText].some(([file, text]) => file !== row.target && !parked.has(file) && text.includes(needle));
  }

  for (const row of manifest) {
    const active = reachable(row);
    const exempt = exclusions.has(row.id);
    if (!active && !exempt) errors.push(`unreachable mechanism: ${row.id}`);
    if (active && exempt) errors.push(`stale exemption: ${row.id}`);
  }
  for (const id of exclusions.keys()) if (!ids.has(id)) errors.push(`orphan exemption: ${id}`);
  return errors;
}

if (import.meta.main) {
  const index = process.argv.indexOf("--repo");
  const repo = index >= 0 ? process.argv[index + 1] : process.cwd();
  if (!repo) fail("--repo requires a path");
  try {
    const errors = check(repo);
    if (errors.length) fail(errors.join("\nMECHANISM-REACHABILITY "));
    console.log("MECHANISM-REACHABILITY clean");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
