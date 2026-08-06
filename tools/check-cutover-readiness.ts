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
// An earlier revision had each of A, E and F consult a SHA-pinned attestation
// row in a tracked TSV. That was the same defect wearing the opposite mask: a
// row counts only when its SHA equals HEAD, committing the row changes HEAD, so
// the only state that could ever reach PASS was an untracked host-local file.
// Green meant dirty. The mechanism is gone; halves that no tree can settle now
// say so, and name the mechanism that would settle them.
//
// ---------------------------------------------------------------------------
// How a gate is judged: an executed result, never a substring
//
// Two earlier revisions of this command were greened by text that said the work
// was NOT done. First a comment: `# TODO: bash orchestrator/launch.sh` made gate
// D report that the meteorite starts the orchestrator. Then, after the stage
// list was parsed rather than grepped, a stage command that merely mentioned the
// launcher did the same -- the sharpest reproduction being a stage whose own
// words were "NOT DONE: nothing here runs orchestrator/launch.sh yet". Both
// times the repair was a sharper pattern, and both times a sharper pattern lost
// to a sentence. So the rule here is not a pattern:
//
//   Text may move a gate toward FAIL. Only an executed result moves one toward
//   PASS.
//
// Concretely, per gate:
//
//   D, and A's clean-clone half   REHEARSED. The tree must register a start
//                                 proof (runner:orchestrator-start-proof) and
//                                 the meteorite must run it as a stage; this
//                                 command then EXECUTES that proof twice, in a
//                                 sandbox holding an orchestrator analog: once
//                                 in a world where the analog comes up, once in
//                                 a world where it refuses to. PASS requires the
//                                 analog to record a real invocation of itself,
//                                 the proof to exit 0 against a live analog, and
//                                 the SAME proof to exit non-zero when nothing
//                                 came up. A script that prints the launcher's
//                                 path never invokes the analog; a stage that
//                                 deletes the lease exits 0 in both worlds.
//                                 Neither can pass. The meteorite's stage text is
//                                 read only to explain a FAIL.
//   E                             EXECUTED. The ledger checker is run against a
//                                 throwaway directory whose inputs are absent,
//                                 and its output is parsed as ITS OWN finding
//                                 grammar (`LEVEL file [check] detail`). PASS
//                                 requires a finding whose LEVEL column is
//                                 UNKNOWN -- an outcome. The token UNKNOWN in a
//                                 legend, a warning, or a summary tally is prose
//                                 about outcomes, not one, and a checker that
//                                 reports success against a tree with no inputs
//                                 is the FAIL this gate exists to catch.
//   G                             comment- and heredoc-stripped shell, and the
//                                 path has to appear in a command position, not
//                                 merely on a line.
//   B, C, F                       structure: extracted paths, a parsed call
//                                 vocabulary, a parsed inventory.
//
// TRUST BOUNDARY. `--repo` is an input, and the two executed judgements above
// run code from the tree it names: the tracked ledger checker, and the start
// proof that tree registers and its meteorite runs. Each is bounded by a
// timeout, runs with a fresh temporary directory as its cwd and HOME, is never
// handed the measured repository as a working directory, and a kill is UNKNOWN
// rather than a pass; the measured tree is left byte-identical. That is
// containment, not a sandbox -- point this command at a tree you would be
// willing to run. Nothing is executed from a tree that registers no proof,
// which is why measuring an unfamiliar repository stays inert unless it opted in.
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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

// The gate-E probe announces its own bound rather than letting a kill reach the
// caller as an ordinary status. CUTOVER_PROBE_TIMEOUT_MS exists so the kill path
// itself can be locked; shortening it can only produce UNKNOWN, never PASS, so
// it is not a way to launder a green.
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lines that RUN `path` rather than merely mentioning it: the path has to sit in
// a command position -- at the start of a command, after a separator, or as the
// argument of bash/sh/exec/source -- optionally behind a prefix expansion such
// as "$REPO_DIR/". A mention inside a variable assignment is deliberately not an
// invocation: that is fail-closed, and a gate is allowed to under-report a
// mechanism, never to over-report one.
export function invocationsOf(lines: SourceLine[], path: string): SourceLine[] {
  const pattern = new RegExp(`(?:^|[;&|(]|\\$\\(|\`|\\b(?:bash|sh|exec|source)\\s+)\\s*["']?[^"'\\s;&|]*${escapeRegExp(path)}`);
  return lines.filter((entry) => pattern.test(entry.text));
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
// cannot read is reported UNKNOWN, never judged from the raw file text.
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

// DIAGNOSTIC ONLY, and the distinction is the whole point of this revision.
// These two say whether a stage's text NAMES a start or a liveness check. That
// is worth reporting when gate D fails -- "its stages end at install and suite"
// is the sentence the operator was promised -- but a stage that names the
// launcher inside an `echo`, and a stage that names the lease inside `rm -f`,
// both match. So a match here can only ever narrow a FAIL's wording. What a
// gate PASSES on is the rehearsal below, which executes something.
const MENTIONS_START = /(?:^|[\s;&|(`"'])(?:[^\s"';|&]*\/)?orchestrator\/launch\.sh|systemctl\s+(?:--\S+\s+)*(?:start|enable\s+--now|restart)\s+\S*bpa-orchestrator/;
const MENTIONS_LIVENESS = /orchestrator\/status\.sh|orchestrator\.lease|orchestrator\.heartbeat|orchestrator\.liveness|systemctl\s+(?:--\S+\s+)*is-active\s+\S*bpa-orchestrator/;

// A clone whose source is a remote: a URL, an scp-style `user@host:path`, or a
// variable holding one. Flags between `clone` and the source are unrestricted
// (`--depth 1`, `-b main`, `-q` and their arguments all read the same to git),
// but the run stops at a command separator so a later command's URL cannot
// certify an earlier local `cp`. A local path source does not match, which is
// the fail-closed direction: a clean clone is the point of the gate.
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
// The start rehearsal: gate D's evidence, and gate A's clean-clone half
//
// The thing under test is a tracked script the tree registers as
// runner:orchestrator-start-proof and the meteorite runs as one of its stages.
// Its contract, of which this rehearsal is the executable statement:
//
//   Given $REPO_DIR (a repository to start from) and $RUNTIME_DIR (where the
//   orchestrator's liveness state lives), it starts the orchestrator by running
//   $REPO_DIR/orchestrator/launch.sh, and exits 0 ONLY IF the orchestrator
//   reached a live state.
//
// It is rehearsed against an ANALOG rather than the real orchestrator, so the
// judgement is hermetic, needs no container, and can be run in both directions.
// The analog appends a line to a log every time it is invoked -- that log, not
// the proof's text, is what "it starts the orchestrator" means here -- and the
// two worlds differ only in whether it comes up:
//
//   live   the analog writes a lease and exits 0. A proof that works exits 0.
//   dead   the analog writes nothing and exits 1. A proof that ASSERTS liveness
//          must exit non-zero; one that merely launches and hopes exits 0, and
//          that difference is the only honest way to tell the two apart.
//
// Nothing about this can be satisfied by writing words: a proof that prints the
// launcher's path leaves the analog's log empty, and a proof that deletes the
// lease exits 0 in both worlds.

const LEASE = "orchestrator.lease";
const ANALOG_LOG = "analog-invocations.log";

type World = "live" | "dead";
type Rehearsal = { launched: boolean; exitCode: number | null; signal: string | null; firstLine: string };

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

// The analog orchestrator: a launcher that records being run, and a status
// command that answers from the lease the launcher does or does not write.
function writeAnalog(repoDir: string, runtimeDir: string, log: string, world: World): void {
  mkdirSync(join(repoDir, "orchestrator"), { recursive: true });
  const record = `printf '%s %s\\n' "$0" "$*" >> ${shellQuote(log)}`;
  const lease = shellQuote(join(runtimeDir, LEASE));
  const launcher = world === "live"
    ? `#!/usr/bin/env bash\n${record}\nprintf 'analog-orchestrator pid=%s\\n' "$$" > ${lease}\nexit 0\n`
    : `#!/usr/bin/env bash\n${record}\nprintf 'analog-orchestrator: did not come up\\n' >&2\nexit 1\n`;
  writeFileSync(join(repoDir, "orchestrator/launch.sh"), launcher, { mode: 0o755 });
  writeFileSync(join(repoDir, "orchestrator/status.sh"), `#!/usr/bin/env bash\n${record}\ntest -s ${lease}\n`, { mode: 0o755 });
}

function rehearse(tree: Tree, target: string, world: World): Rehearsal {
  const sandbox = mkdtempSync(join(tmpdir(), `cutover-rehearsal-${world}-`));
  try {
    const repoDir = join(sandbox, "repo");
    const runtimeDir = join(sandbox, "runtime");
    const log = join(sandbox, ANALOG_LOG);
    mkdirSync(runtimeDir, { recursive: true });
    writeAnalog(repoDir, runtimeDir, log, world);
    const absolute = resolve(tree.repo, target);
    const argv = target.endsWith(".ts") ? [process.execPath, absolute] : ["bash", absolute];
    // cwd and HOME are the sandbox, never the measured repository: the proof is
    // handed a world to start, not the tree being judged. See TRUST BOUNDARY.
    const run = Bun.spawnSync(argv, {
      cwd: sandbox,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: sandbox,
        TMPDIR: sandbox,
        REPO_DIR: repoDir,
        RUNTIME_DIR: runtimeDir,
      },
      timeout: probeTimeoutMs(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = `${run.stdout?.toString() ?? ""}${run.stderr?.toString() ?? ""}`;
    let launched = false;
    try { launched = readFileSync(log, "utf8").includes("orchestrator/launch.sh"); } catch { launched = false; }
    return {
      launched,
      exitCode: run.exitCode,
      signal: run.signalCode ?? null,
      firstLine: output.split("\n").map((line) => line.trim()).find((line) => line.length > 0)?.slice(0, 120) ?? "no output",
    };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// `unproven` — nothing in the tree even claims to do it (gate D's definition is
// about the meteorite's own stages, so that is a FAIL there; gate A's clause is
// about a clean clone, which someone could still start by hand, so it is
// UNKNOWN there). `refuted` — the proof ran and does not do what it claims.
// `unmeasured` — the rehearsal could not finish, and a kill is not a pass.
type Proof = { kind: "proven" | "unproven" | "refuted" | "unmeasured"; evidence: string };

function startProof(tree: Tree, stages: MeteoriteStage[]): Proof {
  return once(tree, "start-proof", (): Proof => {
    const registered = mechanism(tree, START_PROOF);
    if ("reason" in registered) {
      return { kind: "unproven", evidence: `no rehearsable start proof (${START_PROOF}): ${registered.reason}` };
    }
    const target = registered.target;
    const stage = stages.find((entry) => invocationsOf([{ line: entry.line, text: entry.command }], target).length > 0);
    if (!stage) {
      return { kind: "unproven", evidence: `${target} is registered as ${START_PROOF} but no ${METEORITE} stage runs it` };
    }
    const live = rehearse(tree, target, "live");
    if (live.signal !== null || live.exitCode === null) {
      return { kind: "unmeasured", evidence: `the rehearsal of ${target} was killed (${live.signal ?? "no exit status"}) against a live orchestrator analog, so it measured nothing` };
    }
    if (live.exitCode !== 0) {
      return { kind: "refuted", evidence: `${target} (stage ${stage.name}) exited ${live.exitCode} rehearsed against an orchestrator analog that came up — the start it is supposed to prove does not work: ${live.firstLine}` };
    }
    if (!live.launched) {
      return { kind: "refuted", evidence: `${target} (stage ${stage.name}) exited 0 without ever invoking $REPO_DIR/orchestrator/launch.sh — the analog recorded no launch, so it describes a start rather than performing one` };
    }
    const dead = rehearse(tree, target, "dead");
    if (dead.signal !== null || dead.exitCode === null) {
      return { kind: "unmeasured", evidence: `the rehearsal of ${target} was killed (${dead.signal ?? "no exit status"}) against an orchestrator analog that never came up, so its liveness assertion is unmeasured` };
    }
    if (dead.exitCode === 0) {
      return { kind: "refuted", evidence: `${target} (stage ${stage.name}) exits 0 whether or not the orchestrator comes up — rehearsed against an analog that never started, it still succeeded, so it asserts no live state` };
    }
    return { kind: "proven", evidence: `${METEORITE} runs ${target} (stage ${stage.name}); rehearsed, it starts the orchestrator analog and exits 0 only when that analog is live (live exit 0, dead exit ${dead.exitCode})` };
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
// the meteorite's job, judged on its parsed stages, not on its prose.
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
    default: return result("D", "FAIL", `${inventory}; ${stageDiagnosis(stages)}; ${proof.evidence}`);
  }
}

// The ledger checker's own finding grammar, which is its structured result:
// one line per finding, `LEVEL file [check] detail`, plus a trailing `summary:`
// tally. Gate E reads the LEVEL column of a finding and nothing else, because
// that column is the OUTCOME. The word UNKNOWN in a legend line, in a warning,
// or as a count in the summary is the checker talking about outcomes, and an
// earlier revision of this gate accepted exactly that: a checker printing
// `summary: 0 FAIL, ..., 0 UNKNOWN, 0 PASS` -- reporting total success against a
// tree with no inputs at all -- greened the gate whose entire subject is that
// absent inputs must not silently pass.
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

// Gate E's first half, measured by BEHAVIOUR: run the tracked ledger checker
// against a throwaway directory in which its inputs do not exist, and read its
// structured result for an UNKNOWN outcome. Source text is not consulted -- a
// checker that mentions UNKNOWN in a comment and never emits one is exactly the
// failure this gate exists to catch.
function probeAbsentInputs(tree: Tree): GateResult {
  if (!tree.has(LEDGER_CHECKER)) return result("E", "UNKNOWN", `${LEDGER_CHECKER} is absent from the tracked tree`);
  const sandbox = mkdtempSync(join(tmpdir(), "cutover-readiness-probe-"));
  try {
    // Absolute, because the probe runs with the sandbox as its cwd and a
    // relative --repo would make the checker unfindable rather than unproven.
    const probe = Bun.spawnSync([process.execPath, resolve(tree.repo, LEDGER_CHECKER), "--repo", sandbox, "--strict"], {
      cwd: sandbox,
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
    const unknown = findings.filter((finding) => finding.level === "UNKNOWN");
    if (unknown.length > 0 && countedUnknown === 0) {
      return result("E", "FAIL", `${LEDGER_CHECKER} printed ${unknown.length} UNKNOWN finding(s) its own summary counts as zero — the outcome and the tally disagree, so neither can be believed (${summary})`);
    }
    if (unknown.length > 0) {
      return result("E", "PASS", `${LEDGER_CHECKER} reports UNKNOWN when run against a tree whose inputs are absent — ${unknown.length} UNKNOWN finding(s), first ${unknown[0]!.file} (probe exit ${probe.exitCode})`);
    }
    if (findings.length === 0 && summary === null) {
      const firstLine = output.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "no output";
      return result("E", "FAIL", `${LEDGER_CHECKER} emits no UNKNOWN outcome when its inputs are absent, and no finding in its own "LEVEL file [check]" grammar at all — probe exit ${probe.exitCode}, first line: ${firstLine.slice(0, 120)}`);
    }
    return result("E", "FAIL", `${LEDGER_CHECKER} emits no UNKNOWN outcome when its inputs are absent — probe exit ${probe.exitCode}, ${findings.length} finding(s) (${findings.map((finding) => finding.level).join(", ") || "none"}), ${summary ?? "no summary line"}`);
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
    // command should not do". The two executed judgements this command DOES make
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

function judgeG(tree: Tree): GateResult {
  if (!tree.has(WHISPER_INSTALLER)) return result("G", "FAIL", `${WHISPER_INSTALLER} is absent — the clean server has nothing to install Whisper with`);
  const bootstrap = tree.read(BOOTSTRAP);
  if (bootstrap === null) return result("G", "UNKNOWN", `${BOOTSTRAP} is absent from the tracked tree; the clean-server install path cannot be read`);
  const bootstrapRuns = invocationsOf(executableShellLines(bootstrap), WHISPER_INSTALLER)[0];
  if (bootstrapRuns) return result("G", "PASS", `${BOOTSTRAP}:${bootstrapRuns.line} runs ${WHISPER_INSTALLER}`);
  const stages = meteoriteStages(tree) ?? [];
  const stage = stages.find((entry) => invocationsOf([{ line: entry.line, text: entry.command }], WHISPER_INSTALLER).length > 0);
  if (stage) return result("G", "PASS", `${METEORITE} runs ${WHISPER_INSTALLER} on the clean machine (stage ${stage.name})`);
  return result("G", "FAIL", `${WHISPER_INSTALLER} exists but no command in ${BOOTSTRAP} or ${METEORITE} runs it — a clean server comes up without Whisper`);
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
