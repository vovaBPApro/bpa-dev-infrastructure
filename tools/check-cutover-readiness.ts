#!/usr/bin/env bun
// Cutover readiness: one PASS / FAIL / UNKNOWN line per gate A-G.
//
// The gates are NOT invented here. They are the seven bullets under "Definition
// of cutover-ready" in instance/consilium-cutover-2026-08-04-evening-synthesis.md,
// quoted verbatim below and re-checked against that file on every run: a gate
// whose quoted text no longer appears in the source is reported UNKNOWN rather
// than judged, so a gate cannot be quietly watered down by editing either side.
//
// Three verdicts, and the rule that orders them (the consilium's own):
//
//   FAIL     the gate's condition is observably violated in this tree.
//   UNKNOWN  the inputs needed to certify the gate are absent. Never a pass.
//   PASS     the mechanism exists and its condition holds.
//
// FAIL beats UNKNOWN when a gate has several halves: an observed violation is a
// stronger claim than an unmeasurable sibling. Exit 0 only when every gate is
// PASS; anything else exits 1. Green is fail-closed (Hard Floor 7).
//
// This command measures. It does not fix, and it never runs the thing it judges:
// it is read-only toward the whole repository, starts no container, mutates no
// state, and takes well under a second. Where a gate's real verifier already
// exists it is INSPECTED, not re-implemented (one predicate, one home) -- the
// meteorite runner for D, the instruction checker for E, the unit-drift checker
// for B's installed-path half, core/mission-cli-actions.ts for C's vocabulary.
//
// Halves that can only be settled by an act performed OUTSIDE the repository --
// starting a clean clone, running the suite from three checkout kinds, proving
// nothing is stranded off origin -- cannot be read out of the tree at all. Those
// are proven by a SHA-pinned attestation row in instance/cutover-attestations.tsv:
//
//   <gate><TAB><40-char sha><TAB><evidence>
//
// A row counts only when its SHA equals HEAD, so an attestation goes stale the
// moment the tree moves and the gate falls back to UNKNOWN. That file does not
// exist yet, which is exactly why gates A, E and F cannot report PASS today.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isMissionCliAction } from "../core/mission-cli-actions";

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";
export type GateResult = { id: string; verdict: Verdict; evidence: string };

const SYNTHESIS = "instance/consilium-cutover-2026-08-04-evening-synthesis.md";
const LAUNCHER = "orchestrator/launch.sh";
const ATTESTATIONS = "instance/cutover-attestations.tsv";
const HOST_STATE = "instance/host-state.tsv";
const METEORITE = "meteorite/run.sh";
const LEDGER_CHECKER = "tools/instructions/check.ts";
const UNIT_DRIFT = "bootstrap/check-unit-drift.sh";
const WHISPER_INSTALLER = "tools/whisper/install.sh";
const BOOTSTRAP = "bootstrap/install.sh";

// This file and its test quote gate A's definition (which names the break-glass
// directory) and print evidence about mission-cli calls. Scanning them would
// report those citations as the defects they describe, and would let a reworded
// evidence string move a verdict. Excluding them is safe in the one direction
// that matters: a read-only measurement tool is not a caller of anything.
const SELF = ["tools/check-cutover-readiness.ts", "tools/check-cutover-readiness.test.ts"];

function read(repo: string, path: string): string | null {
  try { return readFileSync(join(repo, path), "utf8"); } catch { return null; }
}

function worst(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.includes("UNKNOWN")) return "UNKNOWN";
  return "PASS";
}

// ---------------------------------------------------------------------------
// Shared inputs

// The executable paths orchestrator/launch.sh requires from the tree: its
// `source` lines and the `${OVERRIDE:-$SCRIPT_DIR/...}` / `$REPO_DIR/...`
// defaults. Only .sh and .ts are required to EXIST -- the same syntax also
// names runtime artifacts the launcher creates (locks, state.db, heartbeat
// files), and a clean clone is supposed not to have those.
//
// This is gate B's predicate and it lives here, once. A future dedicated
// launcher-path lock imports this function rather than re-deriving the list.
export type LauncherPath = { path: string; line: number };

export function requiredLauncherPaths(repo: string): LauncherPath[] | null {
  const text = read(repo, LAUNCHER);
  if (text === null) return null;
  const found = new Map<string, number>();
  text.split("\n").forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    for (const match of line.matchAll(/\$(SCRIPT_DIR|REPO_DIR)\/([A-Za-z0-9._/-]+)/g)) {
      const relative = match[1] === "SCRIPT_DIR" ? `orchestrator/${match[2]}` : match[2]!;
      if (!/\.(sh|ts)$/.test(relative)) continue;
      if (!found.has(relative)) found.set(relative, index + 1);
    }
  });
  return [...found].map(([path, line]) => ({ path, line }));
}

// Tracked runtime source, excluding tests and fixtures: a `mission_cli reap`
// inside a test fixture is test data, not a caller, and reading it as one would
// make gate C fail on its own evidence.
const SCAN_DIRS = ["orchestrator", "core", "gate", "hygiene", "daemon", "bootstrap", "tools", "meteorite"];

export function sourceFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (relative: string) => {
    let entries: string[];
    try { entries = readdirSync(join(repo, relative)); } catch { return; }
    for (const entry of entries) {
      const child = `${relative}/${entry}`;
      if (entry === "node_modules" || entry === ".git" || entry === "fixtures" || entry === "testdata") continue;
      let directory = false;
      try { directory = statSync(join(repo, child)).isDirectory(); } catch { continue; }
      if (directory) { walk(child); continue; }
      if (!/\.(sh|ts)$/.test(entry)) continue;
      if (/\.test\.(ts|sh)$/.test(entry) || /\.fixture\.ts$/.test(entry)) continue;
      if (SELF.includes(child)) continue;
      out.push(child);
    }
  };
  for (const dir of SCAN_DIRS) walk(dir);
  return out.sort();
}

function headSha(repo: string): string | null {
  const result = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]);
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.toString().trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

// A gate half proven outside the repository. Returns the evidence string when a
// current attestation exists, otherwise a reason the half stays UNKNOWN.
export function attestation(repo: string, gate: string): { evidence: string } | { reason: string } {
  const text = read(repo, ATTESTATIONS);
  if (text === null) return { reason: `no attestation file (${ATTESTATIONS})` };
  const head = headSha(repo);
  if (head === null) return { reason: "HEAD is unreadable, so no attestation can be matched to this tree" };
  let stale = false;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [id, sha, ...rest] = line.split("\t");
    if (id !== gate) continue;
    if (sha === head) return { evidence: `${ATTESTATIONS} ${gate} ${head.slice(0, 12)} ${rest.join(" ").trim()}`.trim() };
    stale = true;
  }
  return { reason: stale ? `attestation for ${gate} is stale (not HEAD ${head.slice(0, 12)})` : `no attestation row for ${gate}` };
}

// ---------------------------------------------------------------------------
// Gates

type Gate = { id: string; definition: string; judge: (repo: string) => GateResult };

function result(id: string, verdict: Verdict, evidence: string): GateResult {
  return { id, verdict, evidence };
}

function missingLauncherPaths(repo: string): LauncherPath[] | null {
  const required = requiredLauncherPaths(repo);
  if (required === null) return null;
  return required.filter(({ path }) => !existsSync(join(repo, path)));
}

function judgeA(repo: string): GateResult {
  const missing = missingLauncherPaths(repo);
  if (missing === null) return result("A", "UNKNOWN", `${LAUNCHER} is unreadable; startability cannot be judged`);
  if (missing.length) {
    const first = missing[0]!;
    return result("A", "FAIL", `${LAUNCHER}:${first.line} requires ${first.path}, absent from the tree — a clean clone cannot start (${missing.length} missing)`);
  }
  const glass: string[] = [];
  for (const file of sourceFiles(repo)) {
    const text = read(repo, file);
    if (text && text.includes("oldorch-breakglass")) glass.push(file);
  }
  if (glass.length) return result("A", "FAIL", `break-glass path referenced by tracked runtime source: ${glass.join(", ")}`);
  const proof = attestation(repo, "A");
  if ("evidence" in proof) return result("A", "PASS", proof.evidence);
  return result("A", "UNKNOWN", `launcher paths present, but starting a clean clone is not readable from the tree: ${proof.reason}`);
}

function judgeB(repo: string): GateResult {
  const required = requiredLauncherPaths(repo);
  if (required === null) return result("B", "UNKNOWN", `${LAUNCHER} is unreadable`);
  if (required.length === 0) return result("B", "UNKNOWN", `${LAUNCHER} names no required executable path — the extraction found nothing to check`);
  const missing = required.filter(({ path }) => !existsSync(join(repo, path)));
  if (missing.length) {
    return result("B", "FAIL", `${missing.map((entry) => `${entry.path} (${LAUNCHER}:${entry.line})`).join(", ")} absent from the tree`);
  }
  if (!existsSync(join(repo, UNIT_DRIFT))) {
    return result("B", "UNKNOWN", `${required.length} launcher paths present, but the installed-path verifier ${UNIT_DRIFT} is absent`);
  }
  return result("B", "PASS", `${required.length} launcher paths present (${LAUNCHER}); installed paths covered by ${UNIT_DRIFT}`);
}

// `mission_cli <group> [<action>]` and `.../mission-cli.ts <group> [<action>]`.
// A bare `$` / `"` / `{` after the name means an expansion, a redirection or the
// shell function's own definition, none of which is a vocabulary claim.
const MISSION_CLI_CALL = /(?:^|[\s;&|(`"'$])mission[_-]cli(?:\.ts)?\s+([A-Za-z][A-Za-z0-9-]*)(?:\s+([A-Za-z][A-Za-z0-9-]*))?/g;

export type MissionCliCall = { file: string; line: number; group: string; action?: string };

export function missionCliCalls(repo: string): MissionCliCall[] {
  const calls: MissionCliCall[] = [];
  for (const file of sourceFiles(repo)) {
    const text = read(repo, file);
    if (!text) continue;
    text.split("\n").forEach((line, index) => {
      if (/^\s*(#|\/\/)/.test(line)) return;
      for (const match of line.matchAll(MISSION_CLI_CALL)) {
        calls.push({ file, line: index + 1, group: match[1]!, action: match[2] });
      }
    });
  }
  return calls;
}

function judgeC(repo: string): GateResult {
  const calls = missionCliCalls(repo);
  if (calls.length === 0) return result("C", "UNKNOWN", "no mission-cli invocation found in tracked runtime source");
  const unknown = calls.filter(({ group, action }) => !isMissionCliAction(group, action));
  if (unknown.length) {
    const shown = unknown.slice(0, 3).map((call) => `${call.file}:${call.line} ${call.group}${call.action ? ` ${call.action}` : ""}`);
    return result("C", "FAIL", `${unknown.length} call(s) outside core/mission-cli-actions.ts: ${shown.join(", ")}`);
  }
  return result("C", "PASS", `${calls.length} mission-cli call(s) all in core/mission-cli-actions.ts`);
}

function judgeD(repo: string): GateResult {
  const text = read(repo, METEORITE);
  if (text === null) return result("D", "UNKNOWN", `${METEORITE} is absent`);
  const starts = /orchestrator\/launch\.sh|start\s+bpa-orchestrator|bpa-orchestrator\.service/.test(text);
  const liveness = /orchestrator\/status\.sh|orchestrator\.liveness|orchestrator\.heartbeat|orchestrator\.lease/.test(text);
  if (!starts && !liveness) return result("D", "FAIL", `${METEORITE} neither starts the orchestrator nor asserts liveness — its stages end at install and suite`);
  if (!starts) return result("D", "FAIL", `${METEORITE} asserts liveness state but never starts the orchestrator`);
  if (!liveness) return result("D", "FAIL", `${METEORITE} starts the orchestrator but asserts no live state`);
  return result("D", "PASS", `${METEORITE} starts the orchestrator and asserts a live state`);
}

function judgeE(repo: string): GateResult {
  const checker = read(repo, LEDGER_CHECKER);
  const absentInputs: GateResult = checker === null
    ? result("E", "UNKNOWN", `${LEDGER_CHECKER} is absent`)
    : checker.includes("UNKNOWN")
      ? result("E", "PASS", `${LEDGER_CHECKER} carries an UNKNOWN outcome for absent inputs`)
      : result("E", "FAIL", `${LEDGER_CHECKER} has no UNKNOWN outcome — a check whose inputs are absent still passes`);
  const proof = attestation(repo, "E");
  const identical: GateResult = "evidence" in proof
    ? result("E", "PASS", proof.evidence)
    : result("E", "UNKNOWN", `identical verdict from primary repo, lane worktree and land-main is unproven: ${proof.reason}`);
  const verdict = worst([absentInputs.verdict, identical.verdict]);
  const evidence = verdict === "PASS"
    ? `${absentInputs.evidence}; ${identical.evidence}`
    : [absentInputs, identical].filter((part) => part.verdict === verdict).map((part) => part.evidence).join("; ");
  return result("E", verdict, evidence);
}

function judgeF(repo: string): GateResult {
  const inventory = read(repo, HOST_STATE);
  let enumerated: GateResult;
  if (inventory === null) {
    enumerated = result("F", "FAIL", `no tracked non-git host-state inventory (${HOST_STATE})`);
  } else {
    const rows = inventory.split("\n").filter((line) => line.trim() && !line.startsWith("#")).map((line) => line.split("\t"));
    const malformed = rows.filter((row) => row.length < 3 || row.some((cell) => !cell.trim()));
    enumerated = rows.length === 0
      ? result("F", "FAIL", `${HOST_STATE} enumerates nothing`)
      : malformed.length
        ? result("F", "FAIL", `${HOST_STATE} has ${malformed.length} row(s) without a verifying command`)
        : result("F", "PASS", `${HOST_STATE} enumerates ${rows.length} item(s), each with a verifying command`);
  }
  const proof = attestation(repo, "F");
  const stranded: GateResult = "evidence" in proof
    ? result("F", "PASS", proof.evidence)
    : result("F", "UNKNOWN", `whether ACCEPTed work exists only on this host is unproven: ${proof.reason}`);
  const verdict = worst([enumerated.verdict, stranded.verdict]);
  const evidence = verdict === "PASS"
    ? `${enumerated.evidence}; ${stranded.evidence}`
    : [enumerated, stranded].filter((part) => part.verdict === verdict).map((part) => part.evidence).join("; ");
  return result("F", verdict, evidence);
}

function judgeG(repo: string): GateResult {
  if (!existsSync(join(repo, WHISPER_INSTALLER))) return result("G", "FAIL", `${WHISPER_INSTALLER} is absent — the clean server has nothing to install Whisper with`);
  const bootstrap = read(repo, BOOTSTRAP);
  const meteorite = read(repo, METEORITE);
  if (bootstrap === null) return result("G", "UNKNOWN", `${BOOTSTRAP} is absent; the clean-server install path cannot be read`);
  if (bootstrap.includes(WHISPER_INSTALLER)) return result("G", "PASS", `${BOOTSTRAP} invokes ${WHISPER_INSTALLER}`);
  if (meteorite?.includes(WHISPER_INSTALLER)) return result("G", "PASS", `${METEORITE} runs ${WHISPER_INSTALLER} on the clean machine`);
  return result("G", "FAIL", `${WHISPER_INSTALLER} exists but neither ${BOOTSTRAP} nor ${METEORITE} runs it — a clean server comes up without Whisper`);
}

// Verbatim from the synthesis file's "Definition of cutover-ready" bullets. The
// text is re-checked against that file on every run; see definitionDrift.
export const GATES: Gate[] = [
  {
    id: "A",
    definition: "A clean clone of `main` at the cutover SHA starts the orchestrator, with `orchestrator/runtime.env` renamed away — no break-glass, no `/root/oldorch-breakglass/`.",
    judge: judgeA,
  },
  {
    id: "B",
    definition: "Every path the launcher requires exists in the tree; a test fails if any required path is absent.",
    judge: judgeB,
  },
  {
    id: "C",
    definition: "The caller/callee vocabulary agrees — no script calls a `mission-cli` action that is not implemented.",
    judge: judgeC,
  },
  {
    id: "D",
    definition: "The meteorite **starts** the orchestrator in the container and asserts it reaches a live state, rather than asserting that files copied.",
    judge: judgeD,
  },
  {
    id: "E",
    definition: "The suite returns the same verdict in the primary repo, a lane worktree and `land-main`; any check whose inputs are absent reports `UNKNOWN`, never `PASS`.",
    judge: judgeE,
  },
  {
    id: "F",
    definition: "Every piece of non-git host state is enumerated with the command that verifies it, and no ACCEPTed work exists only on this host.",
    judge: judgeF,
  },
  {
    id: "G",
    definition: "The runtime models the product depends on come up on the clean server — Whisper first, since speech-to-text is on the operator's path every day.",
    judge: judgeG,
  },
];

// Gate ids whose quoted definition no longer appears in the synthesis file.
// `null` means the source itself is unreadable, which drifts every gate at once.
export function definitionDrift(repo: string): string[] | null {
  const text = read(repo, SYNTHESIS);
  if (text === null) return null;
  const flat = text.replace(/\s+/g, " ");
  return GATES.filter((gate) => !flat.includes(gate.definition.replace(/\s+/g, " "))).map((gate) => gate.id);
}

export function checkReadiness(repo: string): GateResult[] {
  const drift = definitionDrift(repo);
  if (drift === null) {
    return GATES.map((gate) => result(gate.id, "UNKNOWN", `gate definitions unreadable (${SYNTHESIS}) — nothing may be judged against an unread definition`));
  }
  return GATES.map((gate) => (drift.includes(gate.id)
    ? result(gate.id, "UNKNOWN", `definition drifted from ${SYNTHESIS} — refusing to judge a gate whose text moved`)
    : gate.judge(repo)));
}

export function report(results: GateResult[]): { lines: string[]; exitCode: number } {
  const lines = results.map(({ id, verdict, evidence }) => `CUTOVER-READINESS ${id} ${verdict} ${evidence}`);
  const count = (verdict: Verdict) => results.filter((entry) => entry.verdict === verdict).length;
  const ready = results.length > 0 && results.every((entry) => entry.verdict === "PASS");
  lines.push(`CUTOVER-READINESS summary pass=${count("PASS")} fail=${count("FAIL")} unknown=${count("UNKNOWN")} cutover-ready=${ready ? "yes" : "no"}`);
  return { lines, exitCode: ready ? 0 : 1 };
}

if (import.meta.main) {
  const index = process.argv.indexOf("--repo");
  const repo = index >= 0 ? process.argv[index + 1] : process.cwd();
  if (!repo) {
    console.error("CUTOVER-READINESS --repo requires a path");
    process.exit(2);
  }
  const { lines, exitCode } = report(checkReadiness(repo));
  for (const line of lines) console.log(line);
  process.exit(exitCode);
}
