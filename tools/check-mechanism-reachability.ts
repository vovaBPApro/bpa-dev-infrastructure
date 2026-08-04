#!/usr/bin/env bun
// Does anything INVOKE each tracked mechanism?
//
// What this checker can decide, and nothing beyond it: whether the tracked
// repository contains an invocation edge to each mechanism in
// instance/expected-mechanisms.tsv. It reads git-tracked text and runs exactly
// one subprocess, `git ls-files`.
//
// It therefore does NOT encode "installed is not armed" -- it cannot, and no
// document may claim it does. The 2026-08-01 incident (orch-runtime-watchdog
// .timer installed on the host and never enabled) is host state; this checker
// would report `clean` throughout it, because `armed` here means only "a
// tracked, non-parked file runs `systemctl enable <unit>` in command position".
// Proving a host's actual unit state needs a runtime witness against a real
// host, which is a different mechanism from this one.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildGraph, type Edge, type Graph } from "./invocation-graph";
import { checkDocumentedLand, documentedLandInvocations } from "./check-documented-mission-cli";

type Row = { id: string; kind: string; target: string };

// What a mechanism's reachability rests on. `production` and `test-real` are
// the only classes that make a mechanism reachable on the generic path;
// `gate-collected` and `documented-entry` are the two kind-specific ones.
// `fixture-only` is the honest name for "exercised, but never against the real
// subject" -- the class that used to read as reachable and is now a NO-GO
// unless a tracked exemption states why.
export type ReachClass =
  | "production" | "test-real" | "gate-collected" | "documented-entry" | "armed"
  | "fixture-only" | "none";

export type Classification = { id: string; cls: ReachClass; where: string };

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

function pick(edges: Edge[]): Edge | undefined {
  return edges.find((edge) => edge.cls === "production") ?? edges.find((edge) => edge.cls === "test-real");
}

function show(edge: Edge): string {
  return `${edge.cls} ${edge.from}:${edge.line} (${edge.how})`;
}

// The landing gate collects and runs tracked test files by extension. Read the
// gate's own case patterns rather than restating them, so a gate that stops
// collecting *.test.ts makes the tier row go red instead of silently lapsing.
function gateCollects(repo: string, target: string): boolean {
  const line = read(join(repo, "gate/land-lib.sh")).split("\n")
    .find((candidate) => candidate.includes("*.test.ts") && candidate.includes("|") && candidate.trimEnd().endsWith(")"));
  if (!line) return false;
  return line.trim().replace(/\)$/, "").split("|").map((pattern) => pattern.trim())
    .some((pattern) => pattern && new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(basename(target)));
}

function trackedMarkdown(repo: string): string[] {
  const listed = Bun.spawnSync(["git", "-C", repo, "ls-files", "instructions", "instance"]);
  return listed.stdout.toString().split("\n").filter((file) => file.endsWith(".md"));
}

export function classify(repo: string): { manifest: Row[]; results: Map<string, Classification>; errors: string[] } {
  const manifestPath = join(repo, "instance/expected-mechanisms.tsv");
  const requiredPath = join(repo, "instance/required-mechanisms.tsv");
  const exclusionPath = join(repo, "instance/expected-mechanism-exclusions.tsv");
  const manifest = rows(manifestPath, 3).map(([id, kind, target]) => ({ id, kind, target } as Row));
  const required = rows(requiredPath, 3).map((row) => row.join("\t")).sort();
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

  // A unit template only carries an invocation edge once that unit is armed:
  // an ExecStart in a template nothing enables runs exactly never.
  let graph: Graph | null = null;
  const built = buildGraph(allText, (file) => graph !== null && graph.armEdges(basename(file).replace(/\.in$/, ""), parked) !== null);
  graph = built;

  const armEdge = (unit: string) => built.armEdges(unit, parked);
  function systemd(row: Row): Classification {
    const unit = row.id.slice(5);
    const armed = armEdge(unit);
    if (armed) return { id: row.id, cls: "armed", where: `systemctl enable at ${armed.file}:${armed.line}` };
    if (unit.endsWith(".timer")) return { id: row.id, cls: "none", where: "no tracked systemctl enable for this timer" };
    const timer = manifest.filter((candidate) => candidate.kind === "systemd" && candidate.id.endsWith(".timer"))
      .find((candidate) => read(join(repo, candidate.target)).includes(`Unit=${unit}`) && armEdge(candidate.id.slice(5)));
    return timer
      ? { id: row.id, cls: "armed", where: `armed timer ${timer.id}` }
      : { id: row.id, cls: "none", where: "no armed timer names this unit" };
  }

  const markdown = trackedMarkdown(repo);
  function verdict(row: Row): Classification {
    if (row.kind === "systemd") return systemd(row);
    if (row.kind === "shell-tier") {
      return gateCollects(repo, row.target)
        ? { id: row.id, cls: "gate-collected", where: "matched by gate/land-lib.sh test collection" }
        : { id: row.id, cls: "none", where: "gate/land-lib.sh no longer collects this file" };
    }
    if (row.kind === "gate") {
      // An operator entry point has no in-repository caller by definition. It is
      // reachable when tracked instructions document a complete invocation --
      // every flag the gate's own usage line makes mandatory -- and a tracked
      // test actually drives the script. A bare mention satisfies neither.
      const documented = documentedLandInvocations(repo, markdown);
      const malformed = checkDocumentedLand(repo, markdown);
      const exercised = built.edgesTo(row.target);
      if (!documented.length) return { id: row.id, cls: "none", where: "no documented operator invocation" };
      if (malformed.length) return { id: row.id, cls: "none", where: `documented invocation is incomplete: ${malformed[0]}` };
      if (!exercised.length) return { id: row.id, cls: "none", where: "no tracked test drives the entry point" };
      return { id: row.id, cls: "documented-entry", where: `${documented[0]!.file}:${documented[0]!.line}, exercised by ${exercised[0]!.from}:${exercised[0]!.line}` };
    }
    const edges = built.edgesTo(row.target);
    const best = pick(edges);
    if (best) return { id: row.id, cls: best.cls === "production" ? "production" : "test-real", where: show(best) };
    if (edges.length) return { id: row.id, cls: "fixture-only", where: edges.map(show).join(", ") };
    return { id: row.id, cls: "none", where: "no tracked file invokes it" };
  }

  const results = new Map<string, Classification>();
  for (const row of manifest) results.set(row.id, verdict(row));
  return { manifest, results, errors };
}

const REACHABLE: ReadonlySet<ReachClass> = new Set<ReachClass>(["production", "test-real", "gate-collected", "documented-entry", "armed"]);

export function check(repo: string): string[] {
  const { manifest, results, errors } = classify(repo);
  const exclusions = new Map(rows(join(repo, "instance/expected-mechanism-exclusions.tsv"), 2).map(([id, reason]) => [id, reason]));
  const ids = new Set(manifest.map((row) => row.id));
  for (const row of manifest) {
    const result = results.get(row.id)!;
    const active = REACHABLE.has(result.cls);
    const exempt = exclusions.has(row.id);
    if (!active && !exempt) errors.push(`unreachable mechanism: ${row.id} (${result.cls}: ${result.where})`);
    if (active && exempt) errors.push(`stale exemption: ${row.id} (${result.cls}: ${result.where})`);
  }
  for (const id of exclusions.keys()) if (!ids.has(id)) errors.push(`orphan exemption: ${id}`);
  return errors;
}

if (import.meta.main) {
  const index = process.argv.indexOf("--repo");
  const repo = index >= 0 ? process.argv[index + 1] : process.cwd();
  if (!repo) fail("--repo requires a path");
  try {
    if (process.argv.includes("--explain")) {
      for (const [id, result] of classify(repo).results) console.log(`${id}\t${result.cls}\t${result.where}`);
    }
    const errors = check(repo);
    if (errors.length) fail(errors.join("\nMECHANISM-REACHABILITY "));
    console.log("MECHANISM-REACHABILITY clean");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
