#!/usr/bin/env bun
// Cutover readiness: one PASS / FAIL / UNKNOWN line per gate A-G.
//
// The gates are NOT invented here. They are the seven bullets under "Definition
// of cutover-ready" in instance/consilium-cutover-2026-08-04-evening-synthesis.md,
// quoted verbatim below and re-checked against that file's own bullet on every
// run: a gate whose quoted text no longer appears there is reported UNKNOWN
// rather than judged, so a gate cannot be quietly watered down by editing
// either side.
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
// ---------------------------------------------------------------------------
// What "the tree" means here: git's tracked set, and nothing else
//
// The definition this command measures says "from a clean clone, with no file
// from this host". So the file set is `git ls-files`, not the directory: an
// untracked file is invisible to every gate, and a tracked path that is missing
// from the working tree is absent. A gate therefore cannot be greened by a
// host-local file, and `cutover-ready=yes` is reachable from a clean checkout
// alone -- which is the only environment the definition is written for. Outside
// a git repository nothing is judged at all.
//
// ---------------------------------------------------------------------------
// How a gate is judged: an executed result, never a matched string
//
// Three revisions of this command were greened by text that said the work was
// NOT done. A comment naming the launcher greened gate D; then a stage command
// that mentioned the launcher inside an `echo` did; then a bare variable
// assignment (`PROOF=meteorite/assert-orchestrator-live.sh`) read as an
// invocation and greened gate G and half of D. Each time the repair was a
// sharper pattern, and each time a sharper pattern lost to a sentence. So the
// rule here is not a pattern, and there is deliberately no "invocation
// recognizer" left in this file to sharpen:
//
//   Text may move a gate toward FAIL or hold it at UNKNOWN. Only an executed
//   result moves a gate toward PASS.
//
// Concretely, per gate:
//
//   D, and A's clean-clone half   REHEARSED, twice over. (1) The tree must
//                                 register a start proof
//                                 (runner:orchestrator-start-proof); that proof
//                                 is EXECUTED against an orchestrator analog in
//                                 three worlds -- one where the analog comes up
//                                 live, one where its launcher succeeds but no
//                                 live state ever appears, one where the launch
//                                 fails. It must invoke the launcher (the
//                                 analog's own invocation log is the evidence),
//                                 exit 0 only in the live world, and exit
//                                 non-zero in the other two -- so a proof that
//                                 merely propagates the launcher's exit status,
//                                 prints the launcher's path, or deletes the
//                                 liveness marker cannot pass. (2) The meteorite
//                                 itself is EXECUTED with its container replaced
//                                 by a rehearsal world (a `docker` shim runs
//                                 each stage command in a disposable copy of the
//                                 tracked tree, unprivileged); the proof's place
//                                 in that world is a journaling sentinel, and
//                                 "the meteorite runs it" means the journal
//                                 records the invocation. A stage that assigns
//                                 the proof's path to a variable, echoes it, or
//                                 talks about it leaves the journal empty. The
//                                 meteorite's stage text is read only to word a
//                                 FAIL.
//   G                             EXECUTED the same way. If no executable line
//                                 of bootstrap/install.sh or meteorite/run.sh
//                                 even names the Whisper installer, that absence
//                                 is FAIL (text may move a gate toward FAIL).
//                                 If one does, the naming script is executed in
//                                 its rehearsal world with a journaling sentinel
//                                 at the installer's path, and only the journal
//                                 greens the gate. A script that aborts in the
//                                 rehearsal world before any invocation is
//                                 UNKNOWN, with the aborting line quoted.
//   E                             EXECUTED, and judged on a structured outcome
//                                 set. The ledger checker is run against a
//                                 throwaway directory whose inputs are absent,
//                                 with CHECK_OUTCOMES_JSON naming a file where
//                                 it may write its findings as JSON
//                                 ({"findings":[{"level":...},...]}). PASS
//                                 requires that channel to carry at least one
//                                 UNKNOWN finding and zero PASS findings: on a
//                                 tree with no inputs at all, EVERY PASS finding
//                                 is the violation this gate exists to catch, so
//                                 all findings are read, not the first match. A
//                                 checker with no structured channel can still
//                                 FAIL (printed findings and its exit status are
//                                 read toward FAIL) but can never PASS: a
//                                 printed line is forgeable by a printed line,
//                                 and this gate will not green on stdout.
//   B, C, F                       structure: extracted paths, a parsed call
//                                 vocabulary, a parsed inventory.
//
// TRUST BOUNDARY. `--repo` is an input, and the executed judgements above run
// code from the tree it names: the tracked ledger checker, the registered start
// proof, and -- when they claim the wiring under measurement -- the tracked
// meteorite runner and bootstrap installer, each in a disposable copy of the
// tracked tree. Every rehearsal is bounded by a timeout, runs with a fresh
// temporary directory as cwd and HOME, and never receives the measured
// repository as a working directory; the measured tree is left byte-identical.
// When this command runs as root, every rehearsed script (all but the ledger
// probe, which predates this revision and runs as before) is executed as the
// unprivileged `nobody` user via setpriv, so a rehearsed stage cannot mutate
// the host; without setpriv, or without a world the unprivileged user can
// read, the rehearsal refuses to run and the gate reports UNKNOWN naming what
// is missing. A kill is UNKNOWN rather than a pass. That is containment, not a
// sandbox -- point this command at a tree you would be willing to run. Nothing
// is executed from a tree that registers no proof and names no wiring, which
// is why measuring an unfamiliar repository stays inert unless it opted in.
//
// Rehearsal worlds are honest about their limits: a stage command that needs
// container state this world does not provide (`cd /work/install`, an absolute
// path into the container image) aborts its script, and the gate reports
// UNKNOWN quoting the aborting line -- never a verdict parsed from the text it
// could not run.
//
// Where a gate's real verifier already exists it is INSPECTED or EXECUTED, not
// re-implemented (one predicate, one home) -- the meteorite runner for D and A,
// the instruction checker for E, the unit-drift checker for B's installed-path
// half, core/mission-cli-actions.ts for C's vocabulary.
//
// Halves that can only be settled by an act performed OUTSIDE the repository --
// running the suite from three checkout kinds, proving nothing is stranded off
// origin -- have no tracked verifier yet. They report UNKNOWN and name the
// mechanism id that would settle them, so the way to green is to land that
// mechanism and register it in instance/required-mechanisms.tsv. That is why
// gates E and F cannot report PASS today.

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isMissionCliAction } from "../core/mission-cli-actions";

export type Verdict = "PASS" | "FAIL" | "UNKNOWN";
export type GateResult = { id: string; verdict: Verdict; evidence: string };

const SYNTHESIS = "instance/consilium-cutover-2026-08-04-evening-synthesis.md";
const LAUNCHER = "orchestrator/launch.sh";
const RUNTIME_ENV = "orchestrator/runtime.env";
const HOST_STATE = "instance/host-state.tsv";
const METEORITE = "meteorite/run.sh";
const LEDGER_CHECKER = "tools/instructions/check.ts";
const UNIT_DRIFT = "bootstrap/check-unit-drift.sh";
const WHISPER_INSTALLER = "tools/whisper/install.sh";
const BOOTSTRAP = "bootstrap/install.sh";
const REGISTRY = "instance/required-mechanisms.tsv";

// Mechanism ids in REGISTRY. The first exists; the rest do not yet, and naming
// them is how A, D, E and F say what would settle a half no tree can settle.
const METEORITE_MECHANISM = "runner:meteorite";
const START_PROOF = "runner:orchestrator-start-proof";
const CHECKOUT_PARITY = "checker:checkout-parity";
const STRANDED_WORK = "checker:stranded-work";

// The environment variable through which the ledger checker may publish its
// findings as a structured outcome set. Gate E defines this protocol and names
// it in its evidence; the checker adopting it is part of what closes the gate.
export const OUTCOME_CHANNEL_ENV = "CHECK_OUTCOMES_JSON";

// Every executed judgement announces its own bound rather than letting a kill
// reach the caller as an ordinary status. CUTOVER_PROBE_TIMEOUT_MS exists so
// the kill path itself can be locked; shortening it can only produce UNKNOWN,
// never PASS, so it is not a way to launder a green.
const GIT_TIMEOUT_MS = 30_000;

function probeTimeoutMs(): number {
  const override = Number(process.env.CUTOVER_PROBE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0 ? override : 60_000;
}

// This file and its test quote gate A's definition (which names the break-glass
// directory) and print evidence about mission-cli calls. Scanning them would
// report those citations as the defects they describe, and would let a reworded
// evidence string move a verdict. Excluding them is safe in the one direction
// that matters: a read-only measurement tool is not a caller of anything.
const SELF = ["tools/check-cutover-readiness.ts", "tools/check-cutover-readiness.test.ts"];

// ---------------------------------------------------------------------------
// The tracked tree

export type Tree = {
  repo: string;
  read(path: string): string | null;
  has(path: string): boolean;
  // Whether a clean clone would CARRY the path, which is not the same question
  // as `has`: a tracked file deleted from this working tree is still in the
  // clone. Gate A's "renamed away" clause is about the clone, so it asks this.
  tracked(path: string): boolean;
  paths(): string[];
  sources(): string[];
  // Per-run memo, so a judgement two gates share is executed once.
  memo: Map<string, unknown>;
};

function once<T>(tree: Tree, key: string, compute: () => T): T {
  if (!tree.memo.has(key)) tree.memo.set(key, compute());
  return tree.memo.get(key) as T;
}

// Tracked runtime source, excluding tests and fixtures: a `mission_cli reap`
// inside a test fixture is test data, not a caller, and reading it as one would
// make gate C fail on its own evidence.
function isRuntimeSource(path: string): boolean {
  if (!/\.(sh|ts)$/.test(path)) return false;
  if (/\.test\.(ts|sh)$/.test(path) || /\.fixture\.ts$/.test(path)) return false;
  if (SELF.includes(path)) return false;
  return !path.split("/").some((segment) => ["tests", "fixtures", "testdata", "vendor", "node_modules"].includes(segment));
}

// `null` when the tracked set cannot be read at all (not a repository, or git
// failed). Nothing may be judged from a file set git does not vouch for.
export function openTree(repo: string): Tree | null {
  const listed = Bun.spawnSync(["git", "-C", repo, "ls-files", "-z"], { timeout: GIT_TIMEOUT_MS });
  if (listed.exitCode !== 0) return null;
  const trackedPaths = new Set(listed.stdout.toString().split("\0").filter(Boolean));
  const cache = new Map<string, string | null>();
  return {
    repo,
    has: (path) => trackedPaths.has(path) && existsSync(join(repo, path)),
    tracked: (path) => trackedPaths.has(path),
    read(path) {
      if (!trackedPaths.has(path)) return null;
      if (!cache.has(path)) {
        try { cache.set(path, readFileSync(join(repo, path), "utf8")); } catch { cache.set(path, null); }
      }
      return cache.get(path)!;
    },
    paths: () => [...trackedPaths].sort(),
    sources: () => [...trackedPaths].filter(isRuntimeSource).sort(),
    memo: new Map<string, unknown>(),
  };
}

export function sourceFiles(repo: string): string[] {
  return openTree(repo)?.sources() ?? [];
}

function worst(verdicts: Verdict[]): Verdict {
  if (verdicts.includes("FAIL")) return "FAIL";
  if (verdicts.includes("UNKNOWN")) return "UNKNOWN";
  return "PASS";
}

// ---------------------------------------------------------------------------
// Shell reading: comments and heredoc bodies are not instructions
//
// Used in the fail-closed direction only: to extract the launcher's required
// paths (gate B, where a missed path can only under-report), and to decide
// whether a script's executable text NAMES a thing at all -- an absence that
// FAILs a gate, or a presence that licenses executing the script to find out.
// Nothing here decides that anything RUNS; the rehearsals do.

export type SourceLine = { line: number; text: string };

// A `#` opens a comment only outside quotes and only at the start of a word, so
// `${VAR#prefix}` and `sha#1` survive. Backslash escapes are honoured except
// inside single quotes, where the shell does not honour them either.
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\\" && quote !== "'") { index += 1; continue; }
    if (quote !== null) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "#" && (index === 0 || /[\s;&|(]/.test(line[index - 1]!))) return line.slice(0, index);
  }
  return line;
}

// The lines of a shell script that carry instructions: comments removed, and
// heredoc bodies dropped whole -- a usage banner is text the script prints, not
// a command it runs, and a gate that read one could be greened by documentation.
export function executableShellLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let terminator: string | null = null;
  text.split("\n").forEach((raw, index) => {
    if (terminator !== null) {
      if (raw.trim() === terminator) terminator = null;
      return;
    }
    const code = stripComment(raw);
    const opener = code.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (opener) terminator = opener[1]!;
    if (code.trim()) lines.push({ line: index + 1, text: code });
  });
  return lines;
}

// ---------------------------------------------------------------------------
// Shared inputs

// The executable paths orchestrator/launch.sh requires from the tree: its
// `source` lines and the `${OVERRIDE:-$SCRIPT_DIR/...}` / `$REPO_DIR/...`
// defaults, in bare and braced form. Only .sh and .ts are required to EXIST --
// the same syntax also names runtime artifacts the launcher creates (locks,
// state.db, heartbeat files), and a clean clone is supposed not to have those.
//
// This is gate B's predicate and it lives here, once. A future dedicated
// launcher-path lock imports this function rather than re-deriving the list.
export type LauncherPath = { path: string; line: number };

function launcherPaths(tree: Tree): LauncherPath[] | null {
  const text = tree.read(LAUNCHER);
  if (text === null) return null;
  const found = new Map<string, number>();
  for (const { line, text: code } of executableShellLines(text)) {
    for (const match of code.matchAll(/\$\{?(SCRIPT_DIR|REPO_DIR)\}?\/([A-Za-z0-9._/-]+)/g)) {
      const relative = match[1] === "SCRIPT_DIR" ? `orchestrator/${match[2]}` : match[2]!;
      if (!/\.(sh|ts)$/.test(relative)) continue;
      if (!found.has(relative)) found.set(relative, line);
    }
  }
  return [...found].map(([path, line]) => ({ path, line }));
}

export function requiredLauncherPaths(repo: string): LauncherPath[] | null {
  const tree = openTree(repo);
  return tree === null ? null : launcherPaths(tree);
}

// `mission_cli <group> [<action>]` and `.../mission-cli.ts <group> [<action>]`.
// A bare `$` / `"` / `{` after the name means an expansion, a redirection or the
// shell function's own definition, none of which is a vocabulary claim.
const MISSION_CLI_CALL = /(?:^|[\s;&|(`"'$])mission[_-]cli(?:\.ts)?\s+([A-Za-z][A-Za-z0-9-]*)(?:\s+([A-Za-z][A-Za-z0-9-]*))?/g;

export type MissionCliCall = { file: string; line: number; group: string; action?: string };

function missionCalls(tree: Tree): MissionCliCall[] {
  const calls: MissionCliCall[] = [];
  for (const file of tree.sources()) {
    const text = tree.read(file);
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

export function missionCliCalls(repo: string): MissionCliCall[] {
  const tree = openTree(repo);
  return tree === null ? [] : missionCalls(tree);
}

// The meteorite's executable stage list: the entries of the `commands=(...)`
// array the runner loops over, as `"<stage>|<command>"`. Comment lines inside
// the array are not stages, and a line inside it that is neither a comment nor a
// well-formed entry makes the whole parse fail -- a stage list this function
// cannot read is reported UNKNOWN, never judged from the raw file text. The
// parse decides nothing toward PASS: it feeds gate A's clone check (a necessary
// condition), the stage inventory a FAIL quotes, and nothing else.
export type MeteoriteStage = { name: string; command: string; line: number };

export function meteoriteStages(tree: Tree): MeteoriteStage[] | null {
  const text = tree.read(METEORITE);
  if (text === null) return null;
  const lines = text.split("\n");
  const opening = lines.findIndex((line) => /^\s*commands=\(\s*$/.test(line));
  if (opening < 0) return null;
  const stages: MeteoriteStage[] = [];
  for (let index = opening + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^\s*\)\s*$/.test(line)) return stages;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const entry = line.match(/^\s*"([^|"]+)\|(.*)"\s*$/);
    if (!entry) return null;
    stages.push({ name: entry[1]!, command: entry[2]!, line: index + 1 });
  }
  return null;
}

// DIAGNOSTIC ONLY. These two say whether a stage's text NAMES a start or a
// liveness check. That is worth reporting when gate D fails -- "its stages end
// at install and suite" is the sentence the operator was promised -- but a
// stage that names the launcher inside an `echo`, and a stage that names the
// lease inside `rm -f`, both match. So a match here can only ever narrow a
// FAIL's wording. What a gate PASSES on is executed evidence, never this.
const MENTIONS_START = /(?:^|[\s;&|(`"'])(?:[^\s"';|&]*\/)?orchestrator\/launch\.sh|systemctl\s+(?:--\S+\s+)*(?:start|enable\s+--now|restart)\s+\S*bpa-orchestrator/;
const MENTIONS_LIVENESS = /orchestrator\/status\.sh|orchestrator\.lease|orchestrator\.heartbeat|orchestrator\.liveness|systemctl\s+(?:--\S+\s+)*is-active\s+\S*bpa-orchestrator/;

// A clone whose source is a remote: a URL, an scp-style `user@host:path`, or a
// variable holding one. Flags between `clone` and the source are unrestricted
// (`--depth 1`, `-b main`, `-q` and their arguments all read the same to git),
// but the run stops at a command separator so a later command's URL cannot
// certify an earlier local `cp`. A local path source does not match, which is
// the fail-closed direction: a clean clone is the point of the gate. This is a
// necessary condition for gate A, never a sufficient one.
const CLONES_FROM_REMOTE = /\bgit\s+clone\b[^\n;&|]*?['"]?(?:(?:https?|ssh|git):\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:|\$)/;

// ---------------------------------------------------------------------------
// The mechanism registry

export type Mechanism = { id: string; kind: string; target: string };

function mechanisms(tree: Tree): Mechanism[] | null {
  const text = tree.read(REGISTRY);
  if (text === null) return null;
  return text
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => line.split("\t"))
    .filter((cells) => cells.length >= 3)
    .map(([id, kind, target]) => ({ id: id!.trim(), kind: kind!.trim(), target: target!.trim() }));
}

// A mechanism counts only when it is registered AND its tracked target is in
// the tree: a registry row naming a file nobody landed proves nothing.
function mechanism(tree: Tree, id: string): { target: string } | { reason: string } {
  const rows = mechanisms(tree);
  if (rows === null) return { reason: `${REGISTRY} is absent from the tracked tree` };
  const row = rows.find((entry) => entry.id === id);
  if (!row) return { reason: `no mechanism ${id} in ${REGISTRY}` };
  if (!tree.has(row.target)) return { reason: `${id} names ${row.target}, absent from the tracked tree` };
  return { target: row.target };
}

// ---------------------------------------------------------------------------
// Rehearsal worlds
//
// A rehearsal world is a disposable directory holding a copy of the TRACKED
// tree (so an untracked host file can no more reach a rehearsal than it can
// reach a clean clone), journaling sentinels in place of the files whose
// invocation is under measurement, and shims for the boundary the rehearsed
// script talks through. The rehearsed script runs unprivileged; the journal --
// which only a sentinel process appends to, under a nonce generated per run --
// is the only thing a gate greens on. Printed output cannot forge it.

type Sentinel = { path: string; marker: string };

type WorldRun =
  | { built: false; reason: string }
  | {
      built: true;
      outcome: "completed" | "aborted" | "killed";
      exitCode: number | null;
      signal: string | null;
      firstError: string;
      invoked: Map<string, string>;
    };

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function writeExecutable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

function sentinelScript(journal: string, nonce: string, marker: string): string {
  return `#!/bin/bash\nprintf '%s %s %s %s\\n' ${shellQuote(nonce)} ${shellQuote(marker)} "$0" "$*" >> ${shellQuote(journal)}\nexit 0\n`;
}

const NOOP_SHIMS = ["apt-get", "sudo", "systemctl", "curl", "wget", "crontab"];

// Root must not execute a rehearsed script with its own privileges: a stage
// like `ln -sfn ... /usr/local/bin/bun`, honest inside the meteorite's
// container, would mutate this host. When running as root the rehearsal is
// executed as `nobody`; when that cannot be arranged the rehearsal refuses and
// the gate reports UNKNOWN naming the missing capability.
function unprivileged(): { prefix: string[] } | { reason: string } {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return { prefix: [] };
  const setpriv = Bun.which("setpriv");
  if (!setpriv) return { reason: "running as root with no setpriv on PATH — refusing to execute a rehearsed script with root privileges" };
  return { prefix: [setpriv, "--reuid", "nobody", "--regid", "nogroup", "--clear-groups", "--"] };
}

// Hand the world to the unprivileged user. Nothing in it is precious: it is
// rebuilt per run and removed in the same call.
function surrender(root: string): void {
  chmodSync(root, 0o755);
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    Bun.spawnSync(["chown", "-R", "nobody:nogroup", root], { timeout: GIT_TIMEOUT_MS });
  }
}

// A world the unprivileged user cannot traverse into (a 0700 parent above the
// temp directory) proves nothing, so candidate locations are preflighted with
// the rehearsal user's own eyes and the first readable one wins.
function worldRoot(prefix: string, grant: { prefix: string[] }): string | null {
  for (const base of [tmpdir(), "/tmp"]) {
    let root: string;
    try { root = mkdtempSync(join(base, prefix)); } catch { continue; }
    chmodSync(root, 0o755);
    const probe = join(root, "probe");
    writeFileSync(probe, "probe\n");
    chmodSync(probe, 0o644);
    const seen = Bun.spawnSync([...grant.prefix, "cat", probe], { timeout: GIT_TIMEOUT_MS });
    rmSync(probe, { force: true });
    if (seen.exitCode === 0) return root;
    rmSync(root, { recursive: true, force: true });
  }
  return null;
}

function materializeTrackedTree(tree: Tree, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const path of tree.paths()) {
    const source = join(tree.repo, path);
    if (!existsSync(source)) continue;
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, statSync(source).mode & 0o111 ? 0o755 : 0o644);
  }
}

function worldResult(
  run: ReturnType<typeof Bun.spawnSync>,
  journal: string,
  nonce: string,
): WorldRun {
  const invoked = new Map<string, string>();
  let journalText = "";
  try { journalText = readFileSync(journal, "utf8"); } catch { journalText = ""; }
  for (const line of journalText.split("\n")) {
    if (!line.startsWith(`${nonce} `)) continue;
    const rest = line.slice(nonce.length + 1);
    const marker = rest.split(" ", 1)[0]!;
    if (marker && !invoked.has(marker)) invoked.set(marker, rest.slice(0, 160));
  }
  const output = `${run.stderr?.toString() ?? ""}${run.stdout?.toString() ?? ""}`;
  const firstError = (output.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "no output").slice(0, 160);
  if (run.signalCode || run.exitCode === null) {
    return { built: true, outcome: "killed", exitCode: run.exitCode, signal: run.signalCode ?? null, firstError, invoked };
  }
  return { built: true, outcome: run.exitCode === 0 ? "completed" : "aborted", exitCode: run.exitCode, signal: null, firstError, invoked };
}

// The sentinels a meteorite rehearsal plants are decided by the tree, not the
// caller, so gates D, A and G share one executed run per measurement.
function meteoriteSentinels(tree: Tree): Sentinel[] {
  const sentinels: Sentinel[] = [];
  const registered = mechanism(tree, START_PROOF);
  if ("target" in registered) sentinels.push({ path: registered.target, marker: "start-proof" });
  if (tree.has(WHISPER_INSTALLER) && !sentinels.some((sentinel) => sentinel.path === WHISPER_INSTALLER)) {
    sentinels.push({ path: WHISPER_INSTALLER, marker: "whisper" });
  }
  return sentinels;
}

// The meteorite talks to its container exclusively through `docker`, so that
// boundary is where the rehearsal world stands in: `docker run` answers with an
// analog container id, and `docker exec` runs the stage command in the world's
// copy of the tracked tree, unprivileged, with an inner PATH whose `git`
// answers `rev-parse` with this run's candidate SHA and whose package/network
// tools are inert. The meteorite's own loop, validation and recording execute
// for real; a stage command that needs state this world does not provide fails
// its stage, and the gate says so as UNKNOWN rather than guessing.
function dockerShim(worldTree: string, innerBin: string): string {
  return [
    "#!/bin/bash",
    'subcommand="${1:-}"',
    "shift || true",
    'case "$subcommand" in',
    "  run) printf 'rehearsal-cid\\n' ;;",
    "  exec)",
    '    while (($#)) && [ "$1" != rehearsal-cid ]; do shift; done',
    "    if (($#)); then shift; fi",
    "    if (($# == 0)); then exit 0; fi",
    `    cd ${shellQuote(worldTree)} || exit 125`,
    `    PATH=${shellQuote(innerBin)}:"$PATH" exec "$@"`,
    "    ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n");
}

function meteoriteRehearsal(tree: Tree): WorldRun {
  return once(tree, "meteorite-rehearsal", (): WorldRun => {
    const grant = unprivileged();
    if ("reason" in grant) return { built: false, reason: grant.reason };
    const root = worldRoot("cutover-meteorite-", grant);
    if (root === null) return { built: false, reason: "no temp directory the unprivileged rehearsal user can read" };
    try {
      const worldTree = join(root, "tree");
      materializeTrackedTree(tree, worldTree);
      const journal = join(root, "journal");
      writeFileSync(journal, "");
      chmodSync(journal, 0o666);
      const nonce = randomBytes(16).toString("hex");
      for (const sentinel of meteoriteSentinels(tree)) {
        const at = join(worldTree, sentinel.path);
        mkdirSync(dirname(at), { recursive: true });
        writeExecutable(at, sentinelScript(journal, nonce, sentinel.marker));
      }
      const candidateSha = randomBytes(20).toString("hex");
      const innerBin = join(root, "inner");
      mkdirSync(innerBin);
      writeExecutable(
        join(innerBin, "git"),
        `#!/bin/bash\nfor argument in "$@"; do\n  if [ "$argument" = rev-parse ]; then printf '%s\\n' ${shellQuote(candidateSha)}; exit 0; fi\ndone\nexit 0\n`,
      );
      for (const name of NOOP_SHIMS) writeExecutable(join(innerBin, name), "#!/bin/bash\nexit 0\n");
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeExecutable(join(bin, "docker"), dockerShim(worldTree, innerBin));
      // `docker exec ... bash -lc` starts a login shell, and /etc/profile may
      // reset PATH; the rehearsal HOME's profile puts the inner shims back.
      writeFileSync(join(root, ".bash_profile"), `export PATH=${shellQuote(innerBin)}:"$PATH"\n`);
      for (const scratch of ["tmp", "state"]) mkdirSync(join(root, scratch));
      surrender(root);
      const run = Bun.spawnSync([...grant.prefix, "bash", join(worldTree, METEORITE), "--ref", candidateSha], {
        cwd: worldTree,
        env: {
          PATH: `${bin}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
          HOME: root,
          TMPDIR: join(root, "tmp"),
          XDG_STATE_HOME: join(root, "state"),
          METEORITE_REPORT: join(root, "state", "meteorite-report.md"),
          METEORITE_REPO_URL: "https://rehearsal.invalid/candidate.git",
          METEORITE_DONOR_SHA: candidateSha,
          METEORITE_DONOR_REF: `refs/meteorite-candidates/1-1-${candidateSha}/v2-deprecated`,
          METEORITE_KEEP: "0",
        },
        timeout: probeTimeoutMs(),
        stdout: "pipe",
        stderr: "pipe",
      });
      return worldResult(run, journal, nonce);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// Bootstrap's boundary is its environment: every destination it writes is an
// override, so the world hands it a disposable install root, env file, runtime
// directory, unit directory, crontab command and bun -- and a clone-able twin
// of the tracked tree as REPO_URL, pre-cloned so its branch check holds. The
// Whisper installer's place in both trees is the journaling sentinel.
function bootstrapRehearsal(tree: Tree): WorldRun {
  return once(tree, "bootstrap-rehearsal", (): WorldRun => {
    const grant = unprivileged();
    if ("reason" in grant) return { built: false, reason: grant.reason };
    const root = worldRoot("cutover-bootstrap-", grant);
    if (root === null) return { built: false, reason: "no temp directory the unprivileged rehearsal user can read" };
    try {
      const worldTree = join(root, "tree");
      materializeTrackedTree(tree, worldTree);
      const git = (...args: string[]) =>
        Bun.spawnSync(["git", "-C", worldTree, "-c", "user.email=rehearsal@invalid", "-c", "user.name=rehearsal", ...args], { timeout: GIT_TIMEOUT_MS });
      git("init", "-q", "-b", "rehearsal");
      git("add", "-A");
      git("commit", "-qm", "rehearsal world");
      const install = join(root, "install");
      Bun.spawnSync(["git", "clone", "-q", worldTree, install], { timeout: GIT_TIMEOUT_MS });
      const journal = join(root, "journal");
      writeFileSync(journal, "");
      chmodSync(journal, 0o666);
      const nonce = randomBytes(16).toString("hex");
      for (const base of [worldTree, install]) {
        const at = join(base, WHISPER_INSTALLER);
        mkdirSync(dirname(at), { recursive: true });
        writeExecutable(at, sentinelScript(journal, nonce, "whisper"));
      }
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeExecutable(join(bin, "bun"), `#!/bin/bash\nif [ "\${1:-}" = --version ]; then printf '1.0.0-rehearsal\\n'; fi\nexit 0\n`);
      for (const name of NOOP_SHIMS) writeExecutable(join(bin, name), "#!/bin/bash\nexit 0\n");
      for (const scratch of ["tmp", "config", "runtime", "units"]) mkdirSync(join(root, scratch));
      surrender(root);
      const run = Bun.spawnSync([...grant.prefix, "bash", join(worldTree, BOOTSTRAP)], {
        cwd: worldTree,
        env: {
          PATH: `${bin}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
          HOME: root,
          TMPDIR: join(root, "tmp"),
          INSTALL_ROOT: install,
          REPO_URL: worldTree,
          REPO_BRANCH: "rehearsal",
          ENV_FILE: join(root, "config", "orchestrator.env"),
          BUN_BIN: join(bin, "bun"),
          RUNTIME_DIR: join(root, "runtime"),
          INFRA_STATE_DB: join(root, "runtime", "state.db"),
          CRONTAB_CMD: join(bin, "crontab"),
          SYSTEMD_SYSTEM_DIR: join(root, "units"),
        },
        timeout: probeTimeoutMs(),
        stdout: "pipe",
        stderr: "pipe",
      });
      return worldResult(run, journal, nonce);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// The start-proof rehearsal: gate D's evidence, and gate A's clean-clone half
//
// The thing under test is a tracked script the tree registers as
// runner:orchestrator-start-proof. Its contract, of which this rehearsal is the
// executable statement:
//
//   Given $REPO_DIR (a repository to start from) and $RUNTIME_DIR (where the
//   orchestrator's liveness state lives), it starts the orchestrator by running
//   $REPO_DIR/orchestrator/launch.sh, and exits 0 ONLY IF the orchestrator
//   reached a live state.
//
// It is rehearsed against an ANALOG rather than the real orchestrator, so the
// judgement is hermetic, needs no container, and can be run in every direction.
// The analog appends a line to a log every time it is invoked -- that log, not
// the proof's text, is what "it starts the orchestrator" means here -- and the
// three worlds differ only in what the launch produces:
//
//   live     the analog's launcher writes a lease and exits 0. A working proof
//            exits 0.
//   zombie   the launcher exits 0 but writes NO lease: the launch "succeeded"
//            and nothing is alive. A proof that merely propagates the
//            launcher's exit status exits 0 here, and that is exactly the proof
//            gate D's definition rejects -- it must assert the liveness
//            evidence itself, and exit non-zero.
//   dead     the launcher fails outright. The proof must exit non-zero.
//
// Nothing about this can be satisfied by writing words: a proof that prints the
// launcher's path leaves the analog's log empty, a proof that deletes the lease
// exits 0 in the zombie world, and a proof that trusts the launcher's status
// exits 0 there too.

const LEASE = "orchestrator.lease";

type World = "live" | "zombie" | "dead";
type Rehearsal = { launched: boolean; exitCode: number | null; signal: string | null; firstLine: string };

function writeAnalog(repoDir: string, runtimeDir: string, log: string, world: World): void {
  mkdirSync(join(repoDir, "orchestrator"), { recursive: true });
  const record = `printf '%s %s\\n' "$0" "$*" >> ${shellQuote(log)}`;
  const lease = shellQuote(join(runtimeDir, LEASE));
  const launcher =
    world === "live"
      ? `#!/usr/bin/env bash\n${record}\nprintf 'analog-orchestrator pid=%s\\n' "$$" > ${lease}\nexit 0\n`
      : world === "zombie"
        ? `#!/usr/bin/env bash\n${record}\nexit 0\n`
        : `#!/usr/bin/env bash\n${record}\nprintf 'analog-orchestrator: did not come up\\n' >&2\nexit 1\n`;
  writeExecutable(join(repoDir, "orchestrator/launch.sh"), launcher);
  writeExecutable(join(repoDir, "orchestrator/status.sh"), `#!/usr/bin/env bash\n${record}\ntest -s ${lease}\n`);
}

// `unproven` — nothing in the tree even claims to do it (gate D's definition is
// about the meteorite, so that is a FAIL there; gate A's clause is about a
// clean clone, which someone could still start by hand, so it is UNKNOWN
// there). `refuted` — the proof ran and does not do what it claims. `unwired` —
// the proof works, but the meteorite, executed, never invoked it. `unmeasured`
// — a rehearsal could not finish, and a kill is not a pass.
type Proof = { kind: "proven" | "unproven" | "refuted" | "unwired" | "unmeasured"; evidence: string };

function rehearseProof(tree: Tree, target: string): Proof {
  const grant = unprivileged();
  if ("reason" in grant) return { kind: "unmeasured", evidence: `the start-proof rehearsal could not run: ${grant.reason}` };
  const source = tree.read(target);
  if (source === null) return { kind: "unmeasured", evidence: `${target} could not be read from the tracked tree` };
  const root = worldRoot("cutover-proof-", grant);
  if (root === null) return { kind: "unmeasured", evidence: "no temp directory the unprivileged rehearsal user can read" };
  try {
    const proofPath = join(root, target.endsWith(".ts") ? "proof.ts" : "proof.sh");
    writeExecutable(proofPath, source);
    let runner = ["bash", proofPath];
    if (target.endsWith(".ts")) {
      const bunCopy = join(root, "bun");
      copyFileSync(process.execPath, bunCopy);
      chmodSync(bunCopy, 0o755);
      runner = [bunCopy, proofPath];
    }
    const worlds: World[] = ["live", "zombie", "dead"];
    for (const world of worlds) {
      const repoDir = join(root, world, "repo");
      const runtimeDir = join(root, world, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      writeAnalog(repoDir, runtimeDir, join(root, world, "analog.log"), world);
    }
    mkdirSync(join(root, "tmp"));
    surrender(root);
    const outcomes = {} as Record<World, Rehearsal>;
    for (const world of worlds) {
      const run = Bun.spawnSync([...grant.prefix, ...runner], {
        cwd: join(root, world),
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: root,
          TMPDIR: join(root, "tmp"),
          REPO_DIR: join(root, world, "repo"),
          RUNTIME_DIR: join(root, world, "runtime"),
        },
        timeout: probeTimeoutMs(),
        stdout: "pipe",
        stderr: "pipe",
      });
      let launched = false;
      try { launched = readFileSync(join(root, world, "analog.log"), "utf8").includes("orchestrator/launch.sh"); } catch { launched = false; }
      const output = `${run.stdout?.toString() ?? ""}${run.stderr?.toString() ?? ""}`;
      outcomes[world] = {
        launched,
        exitCode: run.signalCode ? null : run.exitCode,
        signal: run.signalCode ?? null,
        firstLine: output.split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 120) ?? "no output",
      };
      if (outcomes[world].signal !== null || outcomes[world].exitCode === null) {
        return {
          kind: "unmeasured",
          evidence: `the rehearsal of ${target} was killed (${outcomes[world].signal ?? "no exit status"}) in the ${world} analog world, so it measured nothing`,
        };
      }
    }
    const { live, zombie, dead } = outcomes;
    if (live.exitCode !== 0) {
      return {
        kind: "refuted",
        evidence: `${target} exited ${live.exitCode} rehearsed against an orchestrator analog that came up — the start it is supposed to prove does not work: ${live.firstLine}`,
      };
    }
    if (!live.launched) {
      return {
        kind: "refuted",
        evidence: `${target} exited 0 without ever invoking $REPO_DIR/orchestrator/launch.sh — the analog recorded no launch, so it describes a start rather than performing one`,
      };
    }
    if (zombie.exitCode === 0) {
      return {
        kind: "refuted",
        evidence: `${target} exits 0 against an orchestrator analog whose launcher succeeded without ever producing a live state — it accepts the launcher's exit status instead of asserting the liveness evidence, so it asserts no live state of its own`,
      };
    }
    if (dead.exitCode === 0) {
      return {
        kind: "refuted",
        evidence: `${target} exits 0 whether or not the orchestrator comes up — rehearsed against an analog that never started, it still succeeded, so it asserts no live state`,
      };
    }
    return {
      kind: "proven",
      evidence: `rehearsed against an orchestrator analog in three worlds, it starts the analog and exits 0 only when a live state exists (live exit 0, launcher-success-without-liveness exit ${zombie.exitCode}, dead exit ${dead.exitCode})`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function startProof(tree: Tree, stages: MeteoriteStage[]): Proof {
  return once(tree, "start-proof", (): Proof => {
    const registered = mechanism(tree, START_PROOF);
    if ("reason" in registered) {
      return { kind: "unproven", evidence: `no rehearsable start proof (${START_PROOF}): ${registered.reason}` };
    }
    const target = registered.target;
    const quality = rehearseProof(tree, target);
    if (quality.kind !== "proven") return quality;
    const wiring = meteoriteRehearsal(tree);
    if (!wiring.built) {
      return { kind: "unmeasured", evidence: `the ${METEORITE} rehearsal could not run: ${wiring.reason}` };
    }
    if (wiring.invoked.has("start-proof")) {
      return {
        kind: "proven",
        evidence: `${METEORITE}, executed with its container replaced by a rehearsal world, invoked ${target}; ${quality.evidence}`,
      };
    }
    if (wiring.outcome === "killed") {
      return {
        kind: "unmeasured",
        evidence: `the ${METEORITE} rehearsal was killed (${wiring.signal ?? "no exit status"}) before any invocation of ${target}, so the wiring is unmeasured`,
      };
    }
    if (wiring.outcome === "aborted") {
      return {
        kind: "unmeasured",
        evidence: `${METEORITE}, executed in the rehearsal world, aborted (exit ${wiring.exitCode}: ${wiring.firstError}) before invoking ${target} — whether the meteorite runs the proof is unmeasured`,
      };
    }
    return {
      kind: "unwired",
      evidence: `${METEORITE}, executed to completion in the rehearsal world, never invoked ${target} — ${stageDiagnosis(stages)}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Gates

type Gate = { id: string; definition: string; judge: (tree: Tree) => GateResult };

function result(id: string, verdict: Verdict, evidence: string): GateResult {
  return { id, verdict, evidence };
}

// Whether a tracked mechanism proves that a clean clone -- fetched from a
// remote, carrying no file from this host -- starts the orchestrator. That is
// the meteorite's job, judged on the executed rehearsal, not on its prose.
function cleanCloneStart(tree: Tree): GateResult {
  const registered = mechanism(tree, METEORITE_MECHANISM);
  if ("reason" in registered) {
    return result("A", "UNKNOWN", `starting a clean clone has no registered proof mechanism: ${registered.reason}`);
  }
  const stages = meteoriteStages(tree);
  if (stages === null) {
    return result("A", "UNKNOWN", `${registered.target} carries no readable stage list, so the clean-clone start is unproven`);
  }
  const clone = stages.find((stage) => CLONES_FROM_REMOTE.test(stage.command));
  if (!clone) {
    return result("A", "UNKNOWN", `${registered.target} runs ${stages.length} stage(s) but none that clones the candidate from a remote, so a clean clone starting is unproven`);
  }
  const proof = startProof(tree, stages);
  const clones = `${registered.target} clones the candidate from a remote (stage ${clone.name})`;
  if (proof.kind === "proven") return result("A", "PASS", `${clones}; ${proof.evidence}`);
  if (proof.kind === "refuted") return result("A", "FAIL", `${clones}, but ${proof.evidence}`);
  return result("A", "UNKNOWN", `${clones}, but a clean clone starting is unproven: ${proof.evidence}`);
}

function judgeA(tree: Tree): GateResult {
  const required = launcherPaths(tree);
  if (required === null) return result("A", "UNKNOWN", `${LAUNCHER} is not in the tracked tree; startability cannot be judged`);
  const missing = required.filter(({ path }) => !tree.has(path));
  if (missing.length) {
    const first = missing[0]!;
    return result("A", "FAIL", `${LAUNCHER}:${first.line} requires ${first.path}, absent from the tree — a clean clone cannot start (${missing.length} missing)`);
  }
  const glass: string[] = [];
  for (const file of tree.sources()) {
    const text = tree.read(file);
    if (text && text.includes("oldorch-breakglass")) glass.push(file);
  }
  if (glass.length) return result("A", "FAIL", `break-glass path referenced by tracked runtime source: ${glass.join(", ")}`);
  // "with orchestrator/runtime.env renamed away". The clause is about what the
  // clean clone CARRIES, and the tracked set answers that exactly: an untracked
  // runtime.env cannot reach a clone, so the clause holds by construction; a
  // tracked one reaches every clone, and no rename here can be assumed there.
  // Today the file is gitignored, and this predicate is what ties the clause to
  // that fact instead of leaving it resting on a line in another file.
  if (tree.tracked(RUNTIME_ENV)) {
    return result("A", "FAIL", `${RUNTIME_ENV} is tracked, so every clean clone carries it — gate A's "renamed away" precondition cannot hold for a clone`);
  }
  return cleanCloneStart(tree);
}

function judgeB(tree: Tree): GateResult {
  const required = launcherPaths(tree);
  if (required === null) return result("B", "UNKNOWN", `${LAUNCHER} is not in the tracked tree`);
  if (required.length === 0) return result("B", "UNKNOWN", `${LAUNCHER} names no required executable path — the extraction found nothing to check`);
  const missing = required.filter(({ path }) => !tree.has(path));
  if (missing.length) {
    return result("B", "FAIL", `${missing.map((entry) => `${entry.path} (${LAUNCHER}:${entry.line})`).join(", ")} absent from the tree`);
  }
  if (!tree.has(UNIT_DRIFT)) {
    return result("B", "UNKNOWN", `${required.length} launcher paths present, but the installed-path verifier ${UNIT_DRIFT} is absent`);
  }
  return result("B", "PASS", `${required.length} launcher paths present (${LAUNCHER}); installed paths covered by ${UNIT_DRIFT}`);
}

function judgeC(tree: Tree): GateResult {
  const calls = missionCalls(tree);
  if (calls.length === 0) return result("C", "UNKNOWN", "no mission-cli invocation found in tracked runtime source");
  const unknown = calls.filter(({ group, action }) => !isMissionCliAction(group, action));
  if (unknown.length) {
    const shown = unknown.slice(0, 3).map((call) => `${call.file}:${call.line} ${call.group}${call.action ? ` ${call.action}` : ""}`);
    return result("C", "FAIL", `${unknown.length} call(s) outside core/mission-cli-actions.ts: ${shown.join(", ")}`);
  }
  return result("C", "PASS", `${calls.length} mission-cli call(s) all in core/mission-cli-actions.ts`);
}

// What the stage list SAYS, used only to make a FAIL legible. Naming the
// launcher is not starting it, so this sentence never decides a verdict; it
// tells the operator which of "the meteorite has no such stage" and "the
// meteorite has a stage that talks about it" they are looking at.
function stageDiagnosis(stages: MeteoriteStage[]): string {
  const start = stages.find((stage) => MENTIONS_START.test(stage.command));
  const liveness = stages.find((stage) => MENTIONS_LIVENESS.test(stage.command));
  if (!start && !liveness) return "none starts the orchestrator and none asserts liveness — its stages end at install and suite";
  if (!start) return `stage ${liveness!.name} names a liveness marker but no stage starts the orchestrator`;
  if (!liveness) return `stage ${start.name} names the launcher but no stage asserts a live state`;
  return `stages ${start.name} and ${liveness.name} name the launcher and a liveness marker, but naming is not doing`;
}

function judgeD(tree: Tree): GateResult {
  if (!tree.has(METEORITE)) return result("D", "UNKNOWN", `${METEORITE} is absent from the tracked tree`);
  const stages = meteoriteStages(tree);
  if (stages === null) return result("D", "UNKNOWN", `${METEORITE} carries no readable commands=(...) stage list — refusing to judge its stages from raw file text`);
  if (stages.length === 0) return result("D", "FAIL", `${METEORITE} runs no stages at all`);
  const inventory = `${METEORITE} runs ${stages.length} stages (${stages.map((stage) => stage.name).join(", ")})`;
  const proof = startProof(tree, stages);
  switch (proof.kind) {
    case "proven": return result("D", "PASS", proof.evidence);
    case "unmeasured": return result("D", "UNKNOWN", `${inventory}; ${proof.evidence}`);
    case "refuted": return result("D", "FAIL", `${inventory}, but ${proof.evidence}`);
    case "unwired": return result("D", "FAIL", `${inventory}, but ${proof.evidence}`);
    default: return result("D", "FAIL", `${inventory}; ${stageDiagnosis(stages)}; ${proof.evidence}`);
  }
}

// The ledger checker's printed finding grammar -- one line per finding,
// `LEVEL file [check] detail`, plus a trailing `summary:` tally. Printed lines
// are read in the FAIL direction only: a PASS finding printed against an
// inputless tree, or a summary that contradicts the findings beside it, is a
// violation whatever channel it arrives on. Nothing printed can green the
// gate, because a printed line is forgeable by a printed line; the green path
// is the structured outcome channel below.
const FINDING = /^(PASS|WARN|SKIP|FAIL|UNKNOWN)\s+(\S+)\s+\[([^\]]+)\]/;
const SUMMARY = /^\s*summary:\s*(.+)$/;

type ProbeOutcome = { findings: { level: string; file: string }[]; summary: string | null; countedUnknown: number | null };

export function probeOutcome(output: string): ProbeOutcome {
  const lines = output.split("\n");
  const findings = lines
    .map((line) => line.match(FINDING))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ level: match[1]!, file: match[2]! }));
  const summary = lines.filter((line) => SUMMARY.test(line)).at(-1)?.trim() ?? null;
  const counted = summary?.match(/(\d+)\s+UNKNOWN\b/)?.[1];
  return { findings, summary, countedUnknown: counted === undefined ? null : Number(counted) };
}

const OUTCOME_LEVELS = new Set(["PASS", "WARN", "SKIP", "FAIL", "UNKNOWN"]);

type OutcomeChannel = { findings: { level: string; subject: string }[] } | { error: string } | null;

// The structured outcome set the probed checker may write to the path named by
// CHECK_OUTCOMES_JSON: {"findings":[{"level":"UNKNOWN","file":...},...]}. It is
// the checker's own report on a dedicated channel -- a printed line cannot
// write a file -- and it is read whole: every finding counts, not the first
// match.
function readOutcomeChannel(path: string): OutcomeChannel {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return { error: "unparseable JSON" }; }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { findings?: unknown }).findings)) {
    return { error: "no findings array" };
  }
  const findings: { level: string; subject: string }[] = [];
  for (const entry of (parsed as { findings: unknown[] }).findings) {
    if (typeof entry !== "object" || entry === null) return { error: "a finding that is not an object" };
    const level = (entry as { level?: unknown }).level;
    if (typeof level !== "string" || !OUTCOME_LEVELS.has(level)) return { error: "a finding without a valid level" };
    const file = (entry as { file?: unknown }).file;
    const subject = (entry as { subject?: unknown }).subject;
    findings.push({ level, subject: typeof file === "string" ? file : typeof subject === "string" ? subject : "?" });
  }
  return { findings };
}

// Gate E's first half, measured by BEHAVIOUR: run the tracked ledger checker
// against a throwaway directory in which its inputs do not exist, and judge its
// structured outcome set. On that tree EVERY input is absent, so any PASS
// finding anywhere in the run is the violation the gate names, and one UNKNOWN
// finding is not a defence against it.
function probeAbsentInputs(tree: Tree): GateResult {
  if (!tree.has(LEDGER_CHECKER)) return result("E", "UNKNOWN", `${LEDGER_CHECKER} is absent from the tracked tree`);
  const sandbox = mkdtempSync(join(tmpdir(), "cutover-readiness-probe-"));
  try {
    const inputless = join(sandbox, "tree");
    mkdirSync(inputless);
    const channelPath = join(sandbox, "outcomes.json");
    // Absolute, because the probe runs with the sandbox as its cwd and a
    // relative --repo would make the checker unfindable rather than unproven.
    const probe = Bun.spawnSync([process.execPath, resolve(tree.repo, LEDGER_CHECKER), "--repo", inputless, "--strict"], {
      cwd: inputless,
      env: { ...process.env, [OUTCOME_CHANNEL_ENV]: channelPath },
      timeout: probeTimeoutMs(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${probe.stdout?.toString() ?? ""}${probe.stderr?.toString() ?? ""}`;
    // A kill is not a pass: an unfinished probe measured nothing.
    if (probe.exitCode === null || probe.signalCode) {
      return result("E", "UNKNOWN", `${LEDGER_CHECKER} was killed (${probe.signalCode ?? "no exit status"}) before it could report on absent inputs`);
    }
    if (probe.exitCode === 2) {
      return result("E", "UNKNOWN", `${LEDGER_CHECKER} rejected the absent-input probe as a usage error, so its outcome for absent inputs is unmeasured`);
    }
    const { findings, summary, countedUnknown } = probeOutcome(output);
    const channel = readOutcomeChannel(channelPath);
    const channelFindings = channel !== null && "findings" in channel ? channel.findings : [];
    const passes = [
      ...channelFindings.filter((finding) => finding.level === "PASS").map((finding) => finding.subject),
      ...findings.filter((finding) => finding.level === "PASS").map((finding) => finding.file),
    ];
    if (passes.length) {
      return result("E", "FAIL", `${LEDGER_CHECKER} reports PASS against a tree whose inputs are absent — ${passes.length} PASS finding(s), first ${passes[0]}; a check with nothing to check must report UNKNOWN, never PASS (probe exit ${probe.exitCode})`);
    }
    const printedUnknown = findings.filter((finding) => finding.level === "UNKNOWN");
    if (printedUnknown.length > 0 && countedUnknown === 0) {
      return result("E", "FAIL", `${LEDGER_CHECKER} printed ${printedUnknown.length} UNKNOWN finding(s) its own summary counts as zero — the outcome and the tally disagree, so neither can be believed (${summary})`);
    }
    if (channel === null) {
      if (probe.exitCode === 0) {
        return result("E", "FAIL", `${LEDGER_CHECKER} reported success (exit 0) against a tree whose inputs are absent, and offers no structured outcome channel (${OUTCOME_CHANNEL_ENV}) — ${summary ?? "no summary line"}`);
      }
      if (printedUnknown.length > 0) {
        return result("E", "UNKNOWN", `${LEDGER_CHECKER} prints UNKNOWN findings against an inputless tree but offers no structured outcome channel (${OUTCOME_CHANNEL_ENV}) — a printed line is not an outcome this gate will green on, so its behaviour is unmeasured`);
      }
      return result("E", "FAIL", `${LEDGER_CHECKER} emits no UNKNOWN outcome when its inputs are absent — probe exit ${probe.exitCode}, ${findings.length} finding(s) (${findings.map((finding) => finding.level).join(", ") || "none"}), ${summary ?? "no summary line"}, no structured outcome channel (${OUTCOME_CHANNEL_ENV})`);
    }
    if ("error" in channel) {
      return result("E", "UNKNOWN", `${LEDGER_CHECKER} wrote a structured outcome channel this gate cannot read (${channel.error}), so its outcome for absent inputs is unmeasured`);
    }
    const channelUnknown = channelFindings.filter((finding) => finding.level === "UNKNOWN");
    if (channelUnknown.length === 0) {
      return result("E", "FAIL", `${LEDGER_CHECKER}'s structured outcome channel carries no UNKNOWN outcome against a tree whose inputs are absent — ${channelFindings.length} finding(s) (${channelFindings.map((finding) => finding.level).join(", ") || "none"}), probe exit ${probe.exitCode}`);
    }
    return result("E", "PASS", `${LEDGER_CHECKER} reports UNKNOWN and never PASS against a tree whose inputs are absent — structured outcome channel: ${channelUnknown.length} UNKNOWN, 0 PASS of ${channelFindings.length} finding(s), first ${channelUnknown[0]!.subject} (probe exit ${probe.exitCode})`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function judgeE(tree: Tree): GateResult {
  const absentInputs = probeAbsentInputs(tree);
  const registered = mechanism(tree, CHECKOUT_PARITY);
  const identical: GateResult = "target" in registered
    ? result("E", "PASS", `identical verdict across checkout kinds proven by ${registered.target} (${CHECKOUT_PARITY})`)
    : result("E", "UNKNOWN", `identical verdict from primary repo, lane worktree and land-main is unproven: ${registered.reason}`);
  const verdict = worst([absentInputs.verdict, identical.verdict]);
  const evidence = verdict === "PASS"
    ? `${absentInputs.evidence}; ${identical.evidence}`
    : [absentInputs, identical].filter((part) => part.verdict === verdict).map((part) => part.evidence).join("; ");
  return result("E", verdict, evidence);
}

function judgeF(tree: Tree): GateResult {
  const inventory = tree.read(HOST_STATE);
  let enumerated: GateResult;
  if (inventory === null) {
    enumerated = result("F", "FAIL", `no tracked non-git host-state inventory (${HOST_STATE})`);
  } else {
    // Arity and non-emptiness only: whether the third column is a command that
    // actually verifies the item is beyond a read-only tool, and executing an
    // arbitrary tracked string is not something this command will do. Reviewed
    // twice and accepted as the ceiling, in the round-2 reviewer's words:
    // "deciding whether the column is a command that verifies the item means
    // executing an arbitrary tracked string, which a read-only measurement
    // command should not do". The executed judgements this command DOES make
    // are bounded and named in the TRUST BOUNDARY note; a host-state row is not
    // a rehearsable contract, so it stays an inspection.
    const rows = inventory.split("\n").filter((line) => line.trim() && !line.startsWith("#")).map((line) => line.split("\t"));
    const malformed = rows.filter((row) => row.length < 3 || row.some((cell) => !cell.trim()));
    enumerated = rows.length === 0
      ? result("F", "FAIL", `${HOST_STATE} enumerates nothing`)
      : malformed.length
        ? result("F", "FAIL", `${HOST_STATE} has ${malformed.length} row(s) without a verifying command`)
        : result("F", "PASS", `${HOST_STATE} enumerates ${rows.length} item(s), each with a verifying command`);
  }
  const registered = mechanism(tree, STRANDED_WORK);
  const stranded: GateResult = "target" in registered
    ? result("F", "PASS", `no ACCEPTed work stranded off origin, proven by ${registered.target} (${STRANDED_WORK})`)
    : result("F", "UNKNOWN", `whether ACCEPTed work exists only on this host is unproven: ${registered.reason}`);
  const verdict = worst([enumerated.verdict, stranded.verdict]);
  const evidence = verdict === "PASS"
    ? `${enumerated.evidence}; ${stranded.evidence}`
    : [enumerated, stranded].filter((part) => part.verdict === verdict).map((part) => part.evidence).join("; ");
  return result("F", verdict, evidence);
}

// One arm of gate G: what one script's rehearsal proved about the Whisper
// installer. `line` is where its executable text names the installer -- the
// license for executing it, and the line a FAIL points at.
function whisperArm(run: WorldRun, script: string, line: number): GateResult {
  if (!run.built) {
    return result("G", "UNKNOWN", `${script}:${line} names ${WHISPER_INSTALLER} but the rehearsal could not run: ${run.reason}`);
  }
  const hit = run.invoked.get("whisper");
  if (hit) {
    return result("G", "PASS", `${script}, executed in the rehearsal world, ran ${WHISPER_INSTALLER} (journal: ${hit})`);
  }
  if (run.outcome === "killed") {
    return result("G", "UNKNOWN", `the ${script} rehearsal was killed (${run.signal ?? "no exit status"}) before any Whisper invocation, so it is unmeasured`);
  }
  if (run.outcome === "aborted") {
    return result("G", "UNKNOWN", `${script}:${line} names ${WHISPER_INSTALLER} but the rehearsal aborted (exit ${run.exitCode}: ${run.firstError}) before any invocation, so whether it runs the installer is unmeasured`);
  }
  return result("G", "FAIL", `${script}:${line} names ${WHISPER_INSTALLER} but, executed to completion in the rehearsal world, never ran it`);
}

function judgeG(tree: Tree): GateResult {
  if (!tree.has(WHISPER_INSTALLER)) return result("G", "FAIL", `${WHISPER_INSTALLER} is absent — the clean server has nothing to install Whisper with`);
  const bootstrap = tree.read(BOOTSTRAP);
  if (bootstrap === null) return result("G", "UNKNOWN", `${BOOTSTRAP} is absent from the tracked tree; the clean-server install path cannot be read`);
  const meteoriteText = tree.read(METEORITE) ?? "";
  const bootstrapMention = executableShellLines(bootstrap).find((entry) => entry.text.includes(WHISPER_INSTALLER));
  const meteoriteMention = executableShellLines(meteoriteText).find((entry) => entry.text.includes(WHISPER_INSTALLER));
  // Absence of even a mention is decided from text, in the FAIL direction; a
  // mention only licenses executing the script that carries it.
  if (!bootstrapMention && !meteoriteMention) {
    return result("G", "FAIL", `${WHISPER_INSTALLER} exists but no executable line in ${BOOTSTRAP} or ${METEORITE} names it — a clean server comes up without Whisper`);
  }
  const arms: GateResult[] = [];
  if (bootstrapMention) arms.push(whisperArm(bootstrapRehearsal(tree), BOOTSTRAP, bootstrapMention.line));
  if (meteoriteMention) arms.push(whisperArm(meteoriteRehearsal(tree), METEORITE, meteoriteMention.line));
  const pass = arms.find((arm) => arm.verdict === "PASS");
  if (pass) return pass;
  if (arms.some((arm) => arm.verdict === "UNKNOWN")) {
    return result("G", "UNKNOWN", arms.map((arm) => arm.evidence).join("; "));
  }
  return result("G", "FAIL", `${arms.map((arm) => arm.evidence).join("; ")} — a clean server comes up without Whisper`);
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

// Gate ids whose quoted definition is no longer the synthesis file's own bullet.
// The match is anchored twice -- to the `- **<id>.**` bullet, and to the
// "Definition of cutover-ready" section it belongs to -- so quoting the original
// sentence somewhere else in the file (an appendix, a changelog note, a
// quotation of what a bullet used to say) does not cover for a watered-down
// definition. `null` means the source itself is unreadable, which drifts every
// gate at once; a missing section drifts every gate one at a time.
export function definitionDrift(repo: string): string[] | null {
  const tree = openTree(repo);
  const text = tree?.read(SYNTHESIS) ?? null;
  if (text === null) return null;
  const heading = text.search(/^##\s+Definition of cutover-ready\b/m);
  if (heading < 0) return GATES.map((gate) => gate.id);
  const rest = text.slice(heading);
  const next = rest.slice(1).search(/^##\s/m);
  const section = (next < 0 ? rest : rest.slice(0, next + 1)).replace(/\s+/g, " ");
  return GATES.filter((gate) => !section.includes(`- **${gate.id}.** ${gate.definition.replace(/\s+/g, " ")}`)).map((gate) => gate.id);
}

export function checkReadiness(repo: string): GateResult[] {
  const tree = openTree(repo);
  if (tree === null) {
    return GATES.map((gate) => result(gate.id, "UNKNOWN", `the tracked file set of ${repo} is unreadable (not a git repository?) — a gate may not be judged from files git does not carry`));
  }
  const drift = definitionDrift(repo);
  if (drift === null) {
    return GATES.map((gate) => result(gate.id, "UNKNOWN", `gate definitions unreadable (${SYNTHESIS}) — nothing may be judged against an unread definition`));
  }
  return GATES.map((gate) => (drift.includes(gate.id)
    ? result(gate.id, "UNKNOWN", `definition drifted from ${SYNTHESIS} — refusing to judge a gate whose text moved`)
    : gate.judge(tree)));
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
