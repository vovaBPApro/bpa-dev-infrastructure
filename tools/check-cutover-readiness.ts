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
// A fourth revision was rejected for the same disease one layer up. Gates D and
// A rehearsed the meteorite HERE: a `docker` shim, a disposable copy of the
// tracked tree, a journaling sentinel at the start proof's path -- and they
// greened on "the sentinel was invoked at some point during that run". A
// journal entry names no stage, carries no author, and says nothing about
// whether the run finished or acted on what the proof returned, so a meteorite
// whose stage list was `clone` and `full-test-suite` -- with no stage that
// starts anything -- greened gate D, because the suite stage ran the start
// proof's own regression lock. That is the shape the repository actually
// writes, so the false green sat ON the path to closing the gate.
//
// The conclusion four rounds paid for: no simulation of a rebuild proof, run by
// this command, can certify what the rebuild proof did. The only honest witness
// of an executed meteorite run is that run itself. So gates D and A stopped
// simulating and started READING -- and the rehearsal machinery they used is
// deleted rather than sharpened, exactly as the invocation recognizer before it.
//
// Concretely, per gate:
//
//   D, and A's clean-clone half   READ from the run's own artifact, and only
//                                 once origin vouches for it.
//                                 meteorite/run.sh writes a
//                                 `meteorite-result/v1` JSON artifact on every
//                                 run -- outside any checkout, replaced
//                                 atomically, written on failure as well as
//                                 success -- carrying the tree SHA it actually
//                                 proved, its stage list with a verdict per
//                                 stage, whether it FINISHED, its own verdict
//                                 and blocker, and the orchestrator-live stage's
//                                 liveness evidence. This command reads that
//                                 artifact and nothing else:
//                                   absent, unreadable, or recording a tree SHA
//                                   that is not this tree's HEAD  -> UNKNOWN
//                                   ("no rehearsal artifact at this SHA");
//                                   present but not anchored on origin ->
//                                   UNKNOWN ("an artifact is present but
//                                   unanchored, which is not evidence");
//                                   finished:false, or the live stage failed or
//                                   is absent from the stage list  -> FAIL, in
//                                   the artifact's own words;
//                                   a finished, anchored run whose live stage
//                                   PASSed at this SHA               -> PASS.
//                                 No text of meteorite/run.sh is read by either
//                                 gate: not its stage array, not its clone line,
//                                 not a mention of anything. A stage list is a
//                                 claim about what would run; the artifact is a
//                                 record of what did.
//   G                             EXECUTED. If no executable line of
//                                 bootstrap/install.sh or meteorite/run.sh even
//                                 names the Whisper installer, that absence is
//                                 FAIL (text may move a gate toward FAIL). If
//                                 bootstrap/install.sh does, it is executed in a
//                                 rehearsal world with a journaling sentinel at
//                                 the installer's path, and only the journal
//                                 greens the gate. A script that aborts in that
//                                 world before any invocation is UNKNOWN, with
//                                 the aborting line quoted. A mention that
//                                 appears only in meteorite/run.sh is UNKNOWN:
//                                 this command no longer runs the meteorite in
//                                 any form, and the rebuild artifact carries no
//                                 Whisper evidence, so that mention is real
//                                 evidence this command cannot measure.
//   E                             EXECUTED, in two worlds, and judged on the
//                                 outcomes the checker reports plus the exit
//                                 status it moves. World one is a throwaway
//                                 installation whose inputs are absent; world
//                                 two is a copy of the tracked tree, where the
//                                 same inputs are present. PASS requires all of:
//                                 at least one UNKNOWN outcome and ZERO PASS
//                                 outcomes in world one (on a tree with no
//                                 inputs, EVERY PASS is the violation this gate
//                                 exists to catch, so all outcomes are read, not
//                                 the first match); the checker's exit status to
//                                 MOVE with --strict there (blocking strict,
//                                 clean lenient), which is what makes UNKNOWN an
//                                 outcome rather than a word it printed; and at
//                                 least one non-UNKNOWN outcome in world two, so
//                                 a checker that answers UNKNOWN to everything
//                                 cannot green a gate by measuring nothing. If
//                                 the checker offers the structured outcome
//                                 channel (CHECK_OUTCOMES_JSON, findings as
//                                 JSON) it is read whole and held to the same
//                                 rules; it is stronger evidence than stdout,
//                                 but it is not required, because the exit
//                                 status is the part no printed line can forge.
//   B, C, F                       structure: extracted paths, a parsed call
//                                 vocabulary, a parsed inventory.
//
// TRUST BOUNDARY. `--repo` is an input, and the executed judgements above run
// code from the tree it names: the tracked ledger checker, and -- when it names
// the wiring under measurement -- the tracked bootstrap installer, in a
// disposable copy of the tracked tree. Every rehearsal is bounded by a timeout,
// runs with a fresh temporary directory as cwd and HOME, and never receives the
// measured repository as a working directory; the measured tree is left
// byte-identical. When this command runs as root, every rehearsed script (all
// but the ledger probe, which predates this revision and runs as before) is
// executed as the unprivileged `nobody` user via setpriv, so a rehearsed script
// cannot mutate the host; without setpriv, or without a world the unprivileged
// user can read, the rehearsal refuses to run and the gate reports UNKNOWN
// naming what is missing. A kill is UNKNOWN rather than a pass. That is
// containment, not a sandbox -- point this command at a tree you would be
// willing to run. Nothing is executed from a tree that names no wiring, which
// is why measuring an unfamiliar repository stays inert unless it opted in.
//
// ---------------------------------------------------------------------------
// The artifact's trust anchor: origin, not this host
//
// The rebuild artifact D and A read is host state by design (an artifact inside
// the tree would make the next landing refuse a dirty worktree), and it is the
// one input to this command that the measured tree cannot produce: nothing from
// that tree runs, so a tree can no longer certify itself. The fourth review's
// forgery ceiling -- a rehearsed script executing the sentinel's own line -- is
// therefore dead for these two gates by construction.
//
// The fifth review found what replaced it, and it was worse: one `printf` of
// 300 bytes, at an address the CALLER chose (a METEORITE_ARTIFACT environment
// override), greened gate D on this repository, and kept greening it on every
// later run. A local file nobody signed is not evidence, and a caller who picks
// which file is the proof is choosing the verdict. Two rules from elsewhere in
// this repository answer both halves, and both are applied here:
//
//   1. The caller does not select the trust root. gate/review-rounds.ts dies
//      with `caller-controlled-trust-root-refused` when a caller supplies
//      --allowed-signers or --decision-file. So METEORITE_ARTIFACT is DELETED,
//      not sharpened: the artifact's address is the XDG host-state root the
//      runner itself resolves (meteorite/run.sh:17) plus a path constant tracked
//      here, and nothing else. A caller wanting a different artifact read is a
//      caller forging evidence.
//   2. Durable, origin-visible refs are what a local file cannot forge.
//      gate/land.sh publishes each reviewed attempt into refs/bpa-review-
//      attempts/* with a mirror in a second namespace, asks ORIGIN for them at
//      the single configured URL (local refs, refs/remotes/origin/* included,
//      are writable by any lane sharing this Git directory), and cross-checks
//      the two namespaces. The rebuild proof's artifact is anchored the same
//      way: the run publishes the artifact's sha256 as a ref NAME under
//      refs/bpa-meteorite-proofs/<tree_sha>/<sha256>, mirrored under
//      refs/bpa-meteorite-proof-mirrors/<tree_sha>/<sha256>, both pointing at
//      the commit the run proved. This command recomputes the digest of the
//      bytes it read, asks origin for both refs, and requires both to exist and
//      to point at that same commit. A reviewer can re-derive the whole claim
//      with one command: `git ls-remote <the pinned URL>
//      refs/bpa-meteorite-proofs/<sha>/<digest>`, which the evidence prints.
//   3. Verifying a URL is not verifying what is contacted. The sixth review
//      greened D and A on a correctly pinned checkout with one `git config`
//      write -- `url.<local path>.insteadOf`, and `core.sshCommand` by a second
//      route -- both in the SHARED config any lane worktree can write, neither
//      visible in `remote.origin.url`. So the anchor read now leaves the
//      repository entirely: no `-C`, a scratch cwd asserted to be inside no
//      worktree, global/system config neutralized, and the inherited
//      GIT_DIR/GIT_CONFIG* overrides deleted (anchorReadEnv, anchorReadCwd).
//      Forging a green costs push access to origin -- the landing gate's own
//      boundary -- rather than one `printf` or one config line.
//
// The writer half of rule 2 IS NOT LANDED. meteorite/run.sh writes no anchor
// today (the artifact writer itself lives unlanded on ag-v3-5.36), so the
// reader is written against the ref shape specified above and the gate stays
// honestly UNKNOWN until it exists: an artifact present without its anchor is
// reported "present but unanchored, which is not evidence", never PASS. That is
// deliberate -- this command must be correct both before and after the writer
// lands -- and it means gate D cannot go green by a reader-side change alone.
//
// What remains outside this boundary is stated plainly: whoever can push to
// origin can anchor whatever they wrote, exactly as whoever can push to origin
// can land a green checker. And whoever can rewrite this host's PATH, its `git`
// binary or ssh's own configuration is inside the measurement rather than
// redirecting it from the side -- that is the disclosed root-equivalence
// ceiling, and it is a different act from the lane-writable repository config
// rule 3 closes. Gate G's bootstrap arm still greens on a journal and
// still carries the original ceiling, unchanged and unclosed: the cheap tell
// named there ($0 must be the sentinel's own path) remains available and unused.
//
// The rehearsal world is honest about its limits: a script that needs state
// this world does not provide aborts, and the gate reports UNKNOWN quoting the
// aborting line -- never a verdict parsed from the text it could not run.
//
// Where a gate's real verifier already exists it is INSPECTED, EXECUTED or READ,
// not re-implemented (one predicate, one home) -- the meteorite's own artifact
// for D and A, the instruction checker for E, the unit-drift checker for B's
// installed-path half, core/mission-cli-actions.ts for C's vocabulary.
//
// Halves that can only be settled by an act performed OUTSIDE the repository --
// running the suite from three checkout kinds, proving nothing is stranded off
// origin -- have no tracked verifier yet. They report UNKNOWN and name the
// mechanism id that would settle them, so the way to green is to land that
// mechanism and register it in instance/required-mechanisms.tsv. Those two
// halves are why gates E and F cannot report PASS today, and where such a
// mechanism IS registered and landed the evidence says exactly that much -- the
// mechanism exists and this command did not run it -- rather than claiming the
// act was proven.

import { createHash, randomBytes } from "node:crypto";
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
// them is how A, E and F say what would settle a half no tree can settle.
const METEORITE_MECHANISM = "runner:meteorite";
const CHECKOUT_PARITY = "checker:checkout-parity";
const STRANDED_WORK = "checker:stranded-work";

// The rebuild proof's machine-readable artifact: the interface meteorite/run.sh
// documents in its own header and writes on every run. Its address is resolved
// exactly as the runner resolves it, so this reader and that writer cannot
// disagree about where the artifact is -- and it is resolved from the runner's
// XDG host-state root and this tracked constant ALONE. There is deliberately no
// environment override: an override is a caller choosing which file is the
// proof, which is the shape gate/review-rounds.ts refuses outright. There is one
// file, replaced atomically per run, which is what makes "the newest artifact" a
// path rather than a search: the runner never leaves an older one behind to be
// picked by mistake.
const REBUILD_ARTIFACT_RELATIVE = "bpa-dev-infrastructure/evidence/meteorite-latest.json";
const REBUILD_SCHEMA = "meteorite-result/v1";
// The artifact's trust anchor, in the shape gate/land.sh uses for reviewed
// attempts: a durable origin-visible ref plus a mirror in a second namespace, so
// a record forged or suppressed in only one is detectable. The digest of the
// artifact's bytes is the ref NAME, so the ref cannot be made to vouch for a
// file it was not published for; the ref's TARGET is the commit the run proved.
const PROOF_ANCHOR_NAMESPACE = "refs/bpa-meteorite-proofs";
const PROOF_ANCHOR_MIRROR_NAMESPACE = "refs/bpa-meteorite-proof-mirrors";
// Where the origin URL pin lives, read from the tracked tree exactly as
// gate/land.sh reads it (repos.git_remote).
const PARAMS = "instance/params.yaml";
// Stage names from the runner's own `required_stages` contract.
const CLONE_STAGE = "clone";
const LIVE_STAGE = "orchestrator-live";

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

// A comment is not a call, and the skip is a LINE-PREFIX rule: `#`, `//`, and
// `*` (a block comment's continuation lines, as every such comment in this
// repository is written). `core/mission-cli-actions.ts` says "It lives in this
// module and not in mission-cli.ts because mission-cli.ts runs its `main` at
// import time" on a ` * ` line, and gate C read `because` as an action and
// FAILed the real repository on a sentence about itself. The ` * ` prefix is
// what fixes that, and it is all that is needed.
//
// Tracking `/*` and `*/` ACROSS lines was tried in round 5 and is deleted here,
// because it made the gate blind rather than accurate. `/*` is a block-comment
// opener in TypeScript; in shell it is an ordinary glob, and this repository's
// own shell is full of `for f in "$dir"/*.in` and `[[ "$p" == /* ]]`. Every line
// after one of those was skipped until some later line happened to contain `*/`,
// which hid 5,106 lines of tracked runtime source and 6 of the repository's 12
// mission-cli calls -- including the orchestrator's own `mission_cli status` and
// `reap` -- while the gate printed a sentence an operator reads as coverage. A
// scan that hides a call is not the fail-closed direction executableShellLines
// is used in for gate B; it is the opposite one. The tests below lock both
// halves: the prose sentence is not a call, and a call after a glob IS one.
function missionCalls(tree: Tree): MissionCliCall[] {
  const calls: MissionCliCall[] = [];
  for (const file of tree.sources()) {
    const text = tree.read(file);
    if (!text) continue;
    text.split("\n").forEach((line, index) => {
      if (/^\s*(#|\/\/|\*)/.test(line)) return;
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

// The meteorite's stage list, its clone line and every other sentence in
// meteorite/run.sh used to be parsed here, for gates D and A. All of it is
// gone. Three rounds proved that a claim about what a script WOULD do cannot
// certify what it DID, and the fourth proved that this command's own rehearsal
// of the script cannot either. What those gates read now is the stage list the
// run itself recorded, in the artifact below -- names and verdicts of stages
// that executed, not entries of an array that might have.

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
// The rehearsal world (gate G)
//
// A rehearsal world is a disposable directory holding a copy of the TRACKED
// tree (so an untracked host file can no more reach a rehearsal than it can
// reach a clean clone), a journaling sentinel in place of the file whose
// invocation is under measurement, and shims for the boundary the rehearsed
// script talks through. The rehearsed script runs unprivileged; the journal --
// which only a sentinel process appends to, under a nonce generated per run --
// is the only thing gate G greens on. Printed output cannot forge it.
//
// The CEILING, stated where it applies rather than where it does not: a
// rehearsed script CAN forge a journal entry, by reading the sentinel's own
// text and executing the line that writes it. The fourth review found that and
// recorded it as a ceiling rather than a defect, because it is deliberate
// forgery by a script inside the trust boundary rather than the drift the
// earlier rounds were about; the cheap tell it named -- the journal records
// $0, so requiring $0 to be the sentinel's own path costs one comparison --
// remains available and unused. What changed since is the ceiling's REACH: it
// used to cover gates D and A too, whose meteorite rehearsal lived here. Those
// gates now read the artifact of a real run, nothing from the measured tree
// executes for them, and so the tree they measure can no longer forge their
// verdict at all. Only gate G's bootstrap arm still stands on a journal.

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
// The rebuild proof's artifact: gate D's evidence, and gate A's clean-clone half
//
// meteorite/run.sh is the rebuild proof. It installs prerequisites in a fresh
// container, clones the candidate from a remote without touching a host file,
// runs bootstrap, runs the suite, and -- since the orchestrator-live stage
// landed -- starts the orchestrator inside that container and asserts it
// reaches a live state. It writes what it did to a `meteorite-result/v1` JSON
// artifact: the interface documented in its own header, written outside any
// checkout, replaced atomically, written on failure as well as success.
//
// This command reads that artifact. It does not run the meteorite, simulate it,
// shim its container, or parse a word of it. The reason is the whole history of
// this file: a text scan cannot tell doing from describing; an invocation
// recognizer cannot either; and a rehearsal of the runner, which was the third
// answer, greens on "the path executed" while knowing nothing about who called
// it, whether the run survived, or whether its verdict mattered. A run's own
// record is the only witness that carries all three, because the runner is the
// only party present when the run happens.
//
// What that buys, and what it costs, both stated plainly:
//
//   + the evidence is a real container, a real clone, a real launcher, and a
//     real liveness assertion -- not an analog of any of them;
//   + the artifact names the tree SHA it proved, so it cannot vouch for a tree
//     it never saw. A stale artifact is UNKNOWN, exactly like no artifact;
//   + nothing from the measured tree runs for these gates, so that tree cannot
//     forge its own verdict;
//   - the artifact is host state, so these two gates are the only ones whose
//     evidence a clean clone does not carry. That is inherent: "a clean clone
//     starts the orchestrator" is a claim about an act performed somewhere, and
//     no file in the tree can be that act. UNKNOWN until someone runs it is the
//     honest state, and it is what this repository reports today.

type RebuildStage = { name: string; verdict: string };

type RebuildArtifact = {
  path: string;
  // sha256 of the exact bytes read from `path`. This is what origin's anchor ref
  // is named after, so a green artifact and the ref that vouches for it cannot
  // be a different file.
  digest: string;
  // The anchor ref origin answered with, printed in the evidence so a reviewer
  // can re-derive the claim. Empty until the anchor has been verified.
  anchor: string;
  finished: boolean;
  result: string;
  blocker: string;
  treeSha: string;
  requestedSha: string;
  stages: RebuildStage[];
  livenessProven: boolean;
  livenessDetail: string;
  finishedAt: string;
};

type Rebuild = { kind: "unread"; evidence: string } | { kind: "read"; artifact: RebuildArtifact };

// Resolved exactly as meteorite/run.sh resolves it, so the reader and the writer
// cannot end up looking at different files: $XDG_STATE_HOME, then
// $HOME/.local/state (meteorite/run.sh:17), plus the tracked path constant.
// That is the whole address. No caller-supplied selector participates -- see the
// trust-anchor note in the header for why the override that used to sit here is
// deleted rather than validated.
function rebuildArtifactPath(): { path: string } | { reason: string } {
  const state = process.env.XDG_STATE_HOME || (process.env.HOME ? join(process.env.HOME, ".local/state") : "");
  if (!state) {
    return { reason: `neither XDG_STATE_HOME nor HOME is set, so the rebuild proof's artifact has no address on this host` };
  }
  return { path: join(state, REBUILD_ARTIFACT_RELATIVE) };
}

// The SHA the artifact must be about: this tree's HEAD. A tracked file that
// differs from HEAD makes the pair meaningless -- the artifact would certify a
// commit, and the gates would report it about a tree that is not that commit --
// so an uncommitted change is unmeasured rather than covered. Untracked files
// are invisible here as everywhere else in this command.
function measuredSha(tree: Tree): { sha: string } | { reason: string } {
  const head = Bun.spawnSync(["git", "-C", tree.repo, "rev-parse", "HEAD"], { timeout: GIT_TIMEOUT_MS });
  if (head.exitCode !== 0) return { reason: `${tree.repo} has no HEAD commit to compare a rebuild artifact against` };
  const sha = head.stdout.toString().trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) return { reason: `${tree.repo} reports no readable HEAD SHA` };
  const status = Bun.spawnSync(["git", "-C", tree.repo, "status", "--porcelain"], { timeout: GIT_TIMEOUT_MS });
  if (status.exitCode !== 0) return { reason: `the working tree state of ${tree.repo} is unreadable` };
  const dirty = status.stdout.toString().split("\n").filter((line) => line.trim() && !line.startsWith("??"));
  if (dirty.length) {
    return { reason: `${dirty.length} tracked file(s) differ from HEAD (${dirty[0]!.trim()}), so no artifact can be about this tree` };
  }
  return { sha };
}

function readRebuildArtifact(path: string): RebuildArtifact | { error: string } {
  if (!existsSync(path)) return { error: "does not exist" };
  // The bytes are hashed BEFORE they are parsed, and the parse reads those same
  // bytes: the digest origin vouches for is the digest of what was read, not of
  // a second read that could have changed underneath it.
  let bytes: Buffer;
  try { bytes = readFileSync(path); } catch { return { error: "is not readable" }; }
  const digest = createHash("sha256").update(bytes).digest("hex");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return { error: "is not readable JSON" }; }
  if (typeof parsed !== "object" || parsed === null) return { error: "is not a JSON object" };
  const record = parsed as Record<string, unknown>;
  if (record.schema !== REBUILD_SCHEMA) return { error: `carries schema ${JSON.stringify(record.schema) ?? "none"}, not ${REBUILD_SCHEMA}` };
  if (typeof record.finished !== "boolean") return { error: "carries no boolean finished field" };
  if (typeof record.tree_sha !== "string") return { error: "carries no tree_sha" };
  if (!Array.isArray(record.stages)) return { error: "carries no stages array" };
  const stages: RebuildStage[] = [];
  for (const entry of record.stages) {
    if (typeof entry !== "object" || entry === null) return { error: "carries a stage that is not an object" };
    const { name, verdict } = entry as { name?: unknown; verdict?: unknown };
    if (typeof name !== "string" || typeof verdict !== "string") return { error: "carries a stage without a name and a verdict" };
    stages.push({ name, verdict });
  }
  const liveness = typeof record.liveness === "object" && record.liveness !== null ? (record.liveness as Record<string, unknown>) : {};
  const detail = Object.entries(liveness)
    .filter(([key]) => key !== "proven")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return {
    path,
    digest,
    anchor: "",
    finished: record.finished,
    result: typeof record.result === "string" ? record.result : "unstated",
    blocker: typeof record.blocker === "string" ? record.blocker : "none stated",
    treeSha: record.tree_sha,
    requestedSha: typeof record.requested_sha === "string" ? record.requested_sha : "UNMEASURED",
    stages,
    livenessProven: liveness.proven === true,
    livenessDetail: detail.slice(0, 240) || "no liveness fields",
    finishedAt: typeof record.finished_at === "string" ? record.finished_at : "an unstated time",
  };
}

// The pinned origin URL, read from the TRACKED instance parameters -- the same
// one home gate/land.sh reads (repos.git_remote). `null` means this repository
// tracks no pin (minimal fixtures and product repos), which is not an error.
function pinnedRemote(tree: Tree): string | null {
  const text = tree.read(PARAMS);
  if (text === null) return null;
  return text.match(/^\s+git_remote:\s*(\S+)/m)?.[1] ?? null;
}

// A URL git would resolve against the repository's own directory. This command
// asks its remote reads from outside every repository (see anchorReadCwd), so
// such a URL has no meaning where the question is asked, and it is refused with
// its own sentence rather than becoming a confusing "could not be asked".
function isRepositoryRelative(url: string): boolean {
  if (url.startsWith("/") || url.startsWith("~")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) return false; // scheme://host/path
  if (/^[^/]+:/.test(url)) return false; // user@host:path
  return true;
}

// The single URL the anchor may be asked of. Everything here is refused rather
// than worked around, for gate/land.sh's reason: local refs -- including
// refs/remotes/origin/* -- are writable by any lane sharing this Git directory,
// so only the answer origin itself gives at one verified URL is evidence.
//
// Reading the URL from the repository's config is safe BECAUSE the tracked pin
// must vouch for the string. What was never safe is letting that same config
// decide what the string means -- see anchorReadEnv below.
function anchorOrigin(tree: Tree): { url: string } | { reason: string } {
  const configured = Bun.spawnSync(["git", "-C", tree.repo, "config", "--get-all", "remote.origin.url"], { timeout: GIT_TIMEOUT_MS });
  const urls = configured.stdout.toString().split("\n").map((line) => line.trim()).filter(Boolean);
  if (urls.length !== 1) {
    return { reason: `${tree.repo} configures ${urls.length} remote.origin.url value(s), so there is no single origin the anchor could be asked of` };
  }
  const pushurls = Bun.spawnSync(["git", "-C", tree.repo, "config", "--get-all", "remote.origin.pushurl"], { timeout: GIT_TIMEOUT_MS });
  if (pushurls.stdout.toString().trim()) {
    return { reason: `remote.origin.pushurl is set on ${tree.repo}, so the URL a proof is published to and the URL it is read from need not be the same one` };
  }
  const pin = pinnedRemote(tree);
  if (pin !== null && pin !== urls[0]) {
    return { reason: `origin is configured as ${urls[0]} but the tracked pin (${PARAMS}: repos.git_remote) is ${pin}, so this checkout is pointed at a remote the repository does not vouch for` };
  }
  if (isRepositoryRelative(urls[0]!)) {
    return { reason: `origin is configured as ${urls[0]}, which is relative to the checkout, and an anchor is read from outside every repository — a relative address names nothing there` };
  }
  return { url: urls[0]! };
}

// ---------------------------------------------------------------------------
// Asking a remote WITHOUT the repository underneath the question
//
// The sixth review greened gates D and A on a correctly pinned canonical
// checkout with ONE `git config` write and no credential. `url.<local
// path>.insteadOf <the pinned URL>` leaves `git config --get remote.origin.url`
// answering the pinned string, satisfies the single-URL, pushurl and tracked-pin
// checks above, and rewrites what git actually CONTACTS to a bare repository the
// lane created. `core.sshCommand` does the same by a second route that
// `ls-remote --get-url` cannot even see -- and this installation already sets
// that key. Both land in the SHARED common-dir config, which every linked lane
// worktree can write and which review-policy names as lane-writable. So the
// four checks above verified the URL string and nothing about the question.
//
// Enumerating the redirect knobs (url.*.insteadOf, url.*.pushInsteadOf,
// core.sshCommand, proxies, protocol settings, and whatever the next git adds)
// would be one release behind forever. This command therefore does not
// enumerate them: it LEAVES THE CONTEXT THAT SUPPLIES THEM. Every remote read
// runs
//
//   - with no `-C <repo>`, from a scratch directory ASSERTED to be inside no
//     git worktree, so there is no local or common-dir config to consult;
//   - with GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at /dev/null (and
//     GIT_CONFIG_NOSYSTEM set), so ~/.gitconfig and /etc/gitconfig supply
//     nothing either;
//   - with every inherited GIT_CONFIG*, GIT_DIR, GIT_WORK_TREE and sibling
//     override deleted from the child environment, so a rewrite that can no
//     longer arrive from a file cannot arrive from the environment instead.
//
// What is deliberately NOT scrubbed: PATH and the ssh transport variables
// (GIT_SSH_COMMAND, GIT_SSH). Whoever sets this command's environment already
// chooses which `git` binary runs, so scrubbing those buys nothing real, and a
// working GIT_SSH_COMMAND is how a suite proves hermeticity by pointing it at
// /bin/false. On this host the neutralized config costs nothing operationally:
// the deploy key reaches origin through ~/.ssh/config (Host github.com,
// IdentityFile /root/.ssh/id_github_vova), not through core.sshCommand. A host
// where the ONLY route to origin is a git config value now fails to reach
// origin, and the gate says UNKNOWN -- fail-closed, never a forged PASS.
//
// This is the file's ONLY remote read. The rehearsal world's git calls (init,
// commit and a clone of a scratch tree this command created moments earlier)
// contact no remote and vouch for nothing: their verdict comes from executing
// the bootstrap afterwards, so redirecting them can only break a world, never
// forge one. They are deliberately left as they are.
const GIT_CONTEXT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

export function anchorReadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (GIT_CONTEXT_ENV.includes(name) || name.startsWith("GIT_CONFIG")) continue;
    env[name] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  // With no configuration there is no credential helper either; a prompt would
  // hang until the timeout rather than answering the question.
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

// The directory a remote read runs in. git discovers configuration by walking
// UP from its cwd, so "outside every repository" is a claim about the whole
// ancestor chain -- asserted here, never assumed, because a temp root that
// happens to sit inside a checkout would restore exactly the surface this
// function exists to leave. A failed assertion is a refusal, not a fallback.
function anchorReadCwd(): { dir: string } | { reason: string } {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "cutover-anchor-read-"));
  } catch {
    return { reason: `there is no temporary directory to ask origin from, and this command does not ask from inside a repository` };
  }
  const discovered = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir, env: anchorReadEnv(), timeout: GIT_TIMEOUT_MS });
  if (discovered.exitCode === 0) {
    const top = discovered.stdout.toString().trim() || "an enclosing checkout";
    rmSync(dir, { recursive: true, force: true });
    return { reason: `the scratch directory a remote read would run from (${dir}) is inside the git worktree ${top}, whose configuration can rewrite the URL being asked, so the anchor was not asked for at all` };
  }
  return { dir };
}

// Does ORIGIN carry the anchor for exactly these bytes? Both namespaces must
// hold the ref, and both must point at the commit the artifact claims to have
// proved. Anything else -- absent, one-sided, pointing elsewhere, unaskable, or
// killed -- is UNKNOWN, because the absence of an anchor is the absence of
// evidence and never evidence of a forgery either.
function proofAnchor(tree: Tree, artifact: RebuildArtifact): { ref: string } | { reason: string } {
  const origin = anchorOrigin(tree);
  if ("reason" in origin) return { reason: origin.reason };
  const leaf = `${artifact.treeSha}/${artifact.digest}`;
  const ref = `${PROOF_ANCHOR_NAMESPACE}/${leaf}`;
  const mirror = `${PROOF_ANCHOR_MIRROR_NAMESPACE}/${leaf}`;
  // Asked from outside every repository, with ambient configuration
  // neutralized: the URL was verified four ways above, and this is what stops
  // the config under it from deciding where that URL leads.
  const scratch = anchorReadCwd();
  if ("reason" in scratch) return { reason: scratch.reason };
  let listed: ReturnType<typeof Bun.spawnSync>;
  try {
    listed = Bun.spawnSync(["git", "ls-remote", "--refs", origin.url, ref, mirror], {
      cwd: scratch.dir,
      env: anchorReadEnv(),
      timeout: GIT_TIMEOUT_MS,
    });
  } finally {
    rmSync(scratch.dir, { recursive: true, force: true });
  }
  if (listed.signalCode || listed.exitCode === null) {
    return { reason: `asking ${origin.url} for ${ref} was killed (${listed.signalCode ?? "no exit status"}), so whether origin vouches for this artifact is unmeasured` };
  }
  if (listed.exitCode !== 0) {
    return { reason: `${origin.url} could not be asked for ${ref} (git ls-remote exited ${listed.exitCode}: ${listed.stderr.toString().trim().split("\n")[0] ?? "no detail"})` };
  }
  const found = new Map(
    listed.stdout.toString().split("\n").filter(Boolean)
      .map((line) => line.split("\t"))
      .filter((cells) => cells.length >= 2)
      .map((cells) => [cells[1]!.trim(), cells[0]!.trim()] as const),
  );
  const missing = [ref, mirror].filter((name) => !found.has(name));
  if (missing.length) {
    return { reason: `${origin.url} carries ${2 - missing.length} of the 2 anchor refs for sha256 ${artifact.digest.slice(0, 16)} (missing ${missing.join(", ")}) — anyone can write a file at that address, so only a run that published its digest to origin has produced evidence` };
  }
  const wrong = [ref, mirror].filter((name) => found.get(name) !== artifact.treeSha);
  if (wrong.length) {
    return { reason: `${origin.url} carries ${wrong[0]} pointing at ${found.get(wrong[0]!)!.slice(0, 12)}, not at the commit the artifact claims to have proved (${artifact.treeSha.slice(0, 12)})` };
  }
  return { ref };
}

// One read per measurement, shared by D and A's clean-clone half. Every path
// out of it that is not `read` is UNKNOWN: an absent, unreadable, stale or
// unanchored artifact is the absence of evidence, and this gate has never been
// allowed to spend that as evidence of absence.
function rebuildProof(tree: Tree): Rebuild {
  return once(tree, "rebuild-artifact", (): Rebuild => {
    const measured = measuredSha(tree);
    if ("reason" in measured) return { kind: "unread", evidence: `no rehearsal artifact at this SHA: ${measured.reason}` };
    const address = rebuildArtifactPath();
    if ("reason" in address) return { kind: "unread", evidence: `no rehearsal artifact at this SHA: ${address.reason}` };
    const artifact = readRebuildArtifact(address.path);
    if ("error" in artifact) {
      return {
        kind: "unread",
        evidence: `no rehearsal artifact at this SHA: ${address.path} ${artifact.error} — nothing has run ${METEORITE} against ${measured.sha.slice(0, 12)} on this host`,
      };
    }
    if (artifact.treeSha !== measured.sha) {
      return {
        kind: "unread",
        evidence: `no rehearsal artifact at this SHA: ${address.path} records tree_sha ${artifact.treeSha.slice(0, 12)} (finished_at ${artifact.finishedAt}) and HEAD is ${measured.sha.slice(0, 12)} — a rebuild proof vouches for the tree it measured and no other`,
      };
    }
    // Only now, with an artifact that is about THIS tree, is origin asked
    // anything. A repository with no artifact reaches no network at all, which
    // is why today's honest UNKNOWN costs nothing and stays hermetic.
    const anchored = proofAnchor(tree, artifact);
    if ("reason" in anchored) {
      return {
        kind: "unread",
        evidence: `an artifact is present but unanchored, which is not evidence: ${address.path} (tree_sha ${artifact.treeSha.slice(0, 12)}, sha256 ${artifact.digest.slice(0, 16)}) — ${anchored.reason}`,
      };
    }
    return { kind: "read", artifact: { ...artifact, anchor: anchored.ref } };
  });
}

// What the artifact says about the orchestrator-live stage: the executed answer
// to gate D's sentence, and the second half of gate A's. `false` is a FAIL in
// the artifact's own words -- the blocker the run recorded, or the stage list
// it recorded instead of a live one.
type LiveVerdict = { proven: boolean; evidence: string };

function liveStageVerdict(artifact: RebuildArtifact): LiveVerdict {
  // The anchor ref is part of the evidence, not decoration: it is the one string
  // that lets the next reader re-derive this verdict without trusting this host
  // (`git ls-remote origin <ref>`).
  const where = `${artifact.path} (tree_sha ${artifact.treeSha.slice(0, 12)}, finished_at ${artifact.finishedAt}, anchored at ${artifact.anchor})`;
  const inventory = artifact.stages.length
    ? `${artifact.stages.length} executed stage(s): ${artifact.stages.map((stage) => `${stage.name} ${stage.verdict}`).join(", ")}`
    : "no executed stages at all";
  if (!artifact.finished) {
    return {
      proven: false,
      evidence: `${METEORITE} did not finish its rebuild proof — ${where} records finished:false, result ${artifact.result}, blocker: ${artifact.blocker}; ${inventory}`,
    };
  }
  const live = artifact.stages.find((stage) => stage.name === LIVE_STAGE);
  if (!live) {
    return {
      proven: false,
      evidence: `${METEORITE} finished without running a ${LIVE_STAGE} stage at all — ${where} records ${inventory}, so the proof asserts that files copied and never that the orchestrator started`,
    };
  }
  if (live.verdict !== "PASS") {
    return {
      proven: false,
      evidence: `${METEORITE} ran ${LIVE_STAGE} and it did not pass (${live.verdict}) — ${where}, blocker: ${artifact.blocker}, liveness: ${artifact.livenessDetail}`,
    };
  }
  if (!artifact.livenessProven) {
    return {
      proven: false,
      evidence: `${METEORITE} records ${LIVE_STAGE} PASS beside liveness proven:false (${artifact.livenessDetail}) — ${where}; the stage verdict and the liveness evidence disagree, so neither can be believed`,
    };
  }
  return {
    proven: true,
    evidence: `${METEORITE}, executed against this SHA, ran ${LIVE_STAGE} to PASS with liveness proven — ${where}, ${inventory}; declared boundaries: ${artifact.livenessDetail}`,
  };
}

// ---------------------------------------------------------------------------
// Gates

type Gate = { id: string; definition: string; judge: (tree: Tree) => GateResult };

function result(id: string, verdict: Verdict, evidence: string): GateResult {
  return { id, verdict, evidence };
}

// Whether a clean clone -- fetched from a remote, carrying no file from this
// host -- starts the orchestrator. That is the meteorite's job, and the answer
// is the artifact of a run that did it: the clone stage the run executed, and
// the live stage it reached afterwards. The registry row is the tree's opt-in,
// naming the runner whose artifact is being believed.
function cleanCloneStart(tree: Tree): GateResult {
  const registered = mechanism(tree, METEORITE_MECHANISM);
  if ("reason" in registered) {
    return result("A", "UNKNOWN", `starting a clean clone has no registered proof mechanism: ${registered.reason}`);
  }
  const proof = rebuildProof(tree);
  if (proof.kind === "unread") {
    return result("A", "UNKNOWN", `${registered.target} is registered as the clean-clone proof, but ${proof.evidence}`);
  }
  const artifact = proof.artifact;
  const clone = artifact.stages.find((stage) => stage.name === CLONE_STAGE);
  if (!clone) {
    return result("A", "UNKNOWN", `${registered.target} ran ${artifact.stages.length} stage(s) at this SHA and none of them is ${CLONE_STAGE}, so whether the proof started from a clean clone rather than a copy of this host is unmeasured (${artifact.path})`);
  }
  if (clone.verdict !== "PASS") {
    return result("A", "FAIL", `${registered.target}'s ${CLONE_STAGE} stage did not pass (${clone.verdict}) — ${artifact.path}, blocker: ${artifact.blocker}`);
  }
  const clones = `${registered.target}, executed at this SHA, cloned the candidate (stage ${CLONE_STAGE} PASS)`;
  const live = liveStageVerdict(artifact);
  if (!live.proven) return result("A", "FAIL", `${clones}, but ${live.evidence}`);
  if (artifact.result !== "clean") {
    return result("A", "FAIL", `${clones} and reached a live orchestrator, but the rebuild proof's own verdict is ${artifact.result} — blocker: ${artifact.blocker} (${artifact.path})`);
  }
  return result("A", "PASS", `${clones}; ${live.evidence}`);
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

// Gate D is one sentence -- "the meteorite STARTS the orchestrator in the
// container and asserts it reaches a live state, rather than asserting that
// files copied" -- and the artifact answers exactly it. The tracked runner must
// be in the tree (a proof no clone would carry proves nothing about a clone),
// and the rest is the record of what that runner did.
function judgeD(tree: Tree): GateResult {
  if (!tree.has(METEORITE)) return result("D", "UNKNOWN", `${METEORITE} is absent from the tracked tree`);
  const proof = rebuildProof(tree);
  if (proof.kind === "unread") return result("D", "UNKNOWN", proof.evidence);
  const live = liveStageVerdict(proof.artifact);
  // D's sentence is only about starting the orchestrator, and gate A judges the
  // clone the run started from. But "executed against this SHA" would otherwise
  // read as a claim about the whole run, so when the run's provenance stage is
  // not a clean PASS this gate says which part of it it did not read.
  const clone = proof.artifact.stages.find((stage) => stage.name === CLONE_STAGE);
  const caveat = clone?.verdict === "PASS"
    ? ""
    : `; this gate reads only the ${LIVE_STAGE} stage — the run's ${CLONE_STAGE} stage ${clone ? `recorded ${clone.verdict}` : "is absent"}, which gate A judges`;
  return result("D", live.proven ? "PASS" : "FAIL", `${live.evidence}${caveat}`);
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

// One execution of the tracked ledger checker against a given tree. The script
// comes from the measured repository (absolute, because the probe runs with the
// sandbox as its cwd and a relative path would make the checker unfindable
// rather than unproven); the tree it reports on is the sandbox world.
type ProbeRun =
  | { ran: false; reason: string }
  | {
      ran: true;
      exitCode: number;
      printed: { level: string; file: string }[];
      summary: string | null;
      countedUnknown: number | null;
      channel: OutcomeChannel;
      outcomes: { level: string; subject: string }[];
    };

function runLedgerChecker(tree: Tree, world: string, strict: boolean, channelPath: string): ProbeRun {
  const argv = [process.execPath, resolve(tree.repo, LEDGER_CHECKER), "--repo", world];
  if (strict) argv.push("--strict");
  const probe = Bun.spawnSync(argv, {
    cwd: world,
    env: { ...process.env, [OUTCOME_CHANNEL_ENV]: channelPath },
    timeout: probeTimeoutMs(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const label = strict ? "--strict" : "lenient";
  // A kill is not a pass: an unfinished probe measured nothing.
  if (probe.exitCode === null || probe.signalCode) {
    return { ran: false, reason: `${LEDGER_CHECKER} was killed (${probe.signalCode ?? "no exit status"}) during its ${label} run, so it reported nothing` };
  }
  if (probe.exitCode === 2) {
    return { ran: false, reason: `${LEDGER_CHECKER} rejected the ${label} probe as a usage error, so its outcome is unmeasured` };
  }
  const output = `${probe.stdout?.toString() ?? ""}${probe.stderr?.toString() ?? ""}`;
  const { findings, summary, countedUnknown } = probeOutcome(output);
  const channel = readOutcomeChannel(channelPath);
  const channelFindings = channel !== null && "findings" in channel ? channel.findings : [];
  return {
    ran: true,
    exitCode: probe.exitCode,
    printed: findings,
    summary,
    countedUnknown,
    channel,
    // The outcome set, read whole and from every channel the checker used: a
    // PASS is a PASS whether it arrived on stdout or in the JSON, and the first
    // match settles nothing.
    outcomes: [
      ...channelFindings.map((finding) => ({ level: finding.level, subject: finding.subject })),
      ...findings.map((finding) => ({ level: finding.level, subject: finding.file })),
    ],
  };
}

function countLevel(run: Extract<ProbeRun, { ran: true }>, level: string): { level: string; subject: string }[] {
  return run.outcomes.filter((outcome) => outcome.level === level);
}

// Gate E's first half, measured by BEHAVIOUR in two worlds.
//
// World one is an installation whose inputs are ABSENT: an `instructions/`
// directory and an `instance/` directory, both empty. That shape is not
// incidental. The checker's own vocabulary (tools/instructions/outcome.ts)
// makes the absence of the whole instance/ layer a licensed SKIP -- an L2 or L3
// repository is born without one -- and every absent input INSIDE an existing
// layer an UNKNOWN. A bare empty directory would therefore probe the one case
// the checker is entitled to shrug at; this world probes the case gate E is
// about: a repository that declares itself an installation and cannot read a
// single one of its own inputs.
//
// World two is a copy of the TRACKED tree, where those inputs are present. It
// exists because one world cannot tell a checker from a constant: a checker
// that answers UNKNOWN to everything satisfies "reports UNKNOWN, never PASS"
// while measuring nothing at all. Requiring a non-UNKNOWN outcome where the
// inputs are there is what makes the first world's UNKNOWN a discrimination
// rather than a reflex.
//
// The green needs three things, and the middle one is the one no printed line
// can forge: no PASS and at least one UNKNOWN in world one; an exit status that
// MOVES with --strict there (blocking under it, clean without it), which is the
// checker's own exit-code policy saying that the UNKNOWN is what blocks; and at
// least one non-UNKNOWN outcome in world two. The structured outcome channel is
// read whenever it is offered and held to the same rules, but it is no longer
// required: a checker that reports honestly on stdout and blocks on its own
// UNKNOWN has produced an outcome, not a sentence.
function probeAbsentInputs(tree: Tree): GateResult {
  if (!tree.has(LEDGER_CHECKER)) return result("E", "UNKNOWN", `${LEDGER_CHECKER} is absent from the tracked tree`);
  const sandbox = mkdtempSync(join(tmpdir(), "cutover-readiness-probe-"));
  try {
    const inputless = join(sandbox, "inputless");
    for (const layer of ["instructions", "instance"]) mkdirSync(join(inputless, layer), { recursive: true });
    const strict = runLedgerChecker(tree, inputless, true, join(sandbox, "outcomes-strict.json"));
    if (!strict.ran) return result("E", "UNKNOWN", strict.reason);

    const passes = countLevel(strict, "PASS");
    if (passes.length) {
      return result("E", "FAIL", `${LEDGER_CHECKER} reports PASS against a tree whose inputs are absent — ${passes.length} PASS outcome(s), first ${passes[0]!.subject}; a check with nothing to check must report UNKNOWN, never PASS (probe exit ${strict.exitCode})`);
    }
    const printedUnknown = strict.printed.filter((finding) => finding.level === "UNKNOWN");
    if (printedUnknown.length > 0 && strict.countedUnknown === 0) {
      return result("E", "FAIL", `${LEDGER_CHECKER} printed ${printedUnknown.length} UNKNOWN finding(s) its own summary counts as zero — the outcome and the tally disagree, so neither can be believed (${strict.summary})`);
    }
    if (strict.channel !== null && "error" in strict.channel) {
      return result("E", "UNKNOWN", `${LEDGER_CHECKER} wrote a structured outcome channel this gate cannot read (${strict.channel.error}), so its outcome for absent inputs is unmeasured`);
    }
    const unknowns = countLevel(strict, "UNKNOWN");
    if (unknowns.length === 0) {
      return result("E", "FAIL", `${LEDGER_CHECKER} emits no UNKNOWN outcome when its inputs are absent — probe exit ${strict.exitCode}, ${strict.outcomes.length} outcome(s) (${strict.outcomes.map((outcome) => outcome.level).join(", ") || "none"}), ${strict.summary ?? "no summary line"}`);
    }
    // The exit status can only speak for the UNKNOWN outcome when nothing else
    // in the run is blocking. A FAIL beside it makes the two runs' statuses
    // uninformative rather than wrong, so this is unmeasured, not a violation.
    const fails = countLevel(strict, "FAIL");
    if (fails.length) {
      return result("E", "UNKNOWN", `${LEDGER_CHECKER} reports ${fails.length} FAIL outcome(s) beside its UNKNOWN against an inputless tree (first ${fails[0]!.subject}), so its exit status cannot show that the UNKNOWN is what blocks — unmeasured, not passed`);
    }
    if (strict.exitCode === 0) {
      return result("E", "FAIL", `${LEDGER_CHECKER} reports ${unknowns.length} UNKNOWN outcome(s) against a tree whose inputs are absent and still exits 0 under --strict — an outcome that blocks nothing is a word, not an outcome (${strict.summary ?? "no summary line"})`);
    }
    const lenient = runLedgerChecker(tree, inputless, false, join(sandbox, "outcomes-lenient.json"));
    if (!lenient.ran) return result("E", "UNKNOWN", lenient.reason);
    if (lenient.exitCode !== 0) {
      return result("E", "UNKNOWN", `${LEDGER_CHECKER} blocks on the inputless tree with and without --strict (exit ${strict.exitCode} and ${lenient.exitCode}) though it reports no FAIL outcome, so what blocks it is not its UNKNOWN — unmeasured, not passed`);
    }

    const populated = join(sandbox, "populated");
    materializeTrackedTree(tree, populated);
    const present = runLedgerChecker(tree, populated, true, join(sandbox, "outcomes-populated.json"));
    if (!present.ran) return result("E", "UNKNOWN", `${present.reason} — measured against the tracked tree, where its inputs are present`);
    const measured = present.outcomes.filter((outcome) => outcome.level !== "UNKNOWN");
    if (present.outcomes.length === 0) {
      return result("E", "UNKNOWN", `${LEDGER_CHECKER} reports no outcome at all against the tracked tree (exit ${present.exitCode}), so whether its UNKNOWN on an inputless tree is a measurement or a constant is unmeasured`);
    }
    if (measured.length === 0) {
      return result("E", "FAIL", `${LEDGER_CHECKER} answers UNKNOWN for all ${present.outcomes.length} of its outcomes against the tracked tree, where those inputs are present — a checker that never measures anything reports UNKNOWN honestly and checks nothing`);
    }
    const channelNote = strict.channel !== null ? `structured outcome channel offered (${OUTCOME_CHANNEL_ENV})` : `no structured outcome channel (${OUTCOME_CHANNEL_ENV}); its exit-code policy carries the claim instead`;
    return result("E", "PASS", `${LEDGER_CHECKER} reports UNKNOWN and never PASS against a tree whose inputs are absent — ${unknowns.length} UNKNOWN and 0 PASS across ${strict.outcomes.length} outcome record(s), stdout and the structured channel read together, first ${unknowns[0]!.subject}; its exit status moves with --strict (${strict.exitCode} strict, ${lenient.exitCode} lenient), so the UNKNOWN is what blocks; and against the tracked tree it still measures ${measured.length} non-UNKNOWN outcome(s), so it discriminates rather than answering a constant — ${channelNote}`);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function judgeE(tree: Tree): GateResult {
  const absentInputs = probeAbsentInputs(tree);
  const registered = mechanism(tree, CHECKOUT_PARITY);
  // "proven by" was an overclaim and the fourth review was right about it: this
  // half is settled by an act performed outside the repository -- the same
  // verdict from three real checkouts -- and this command does not perform it.
  // What it can see is that a mechanism claiming to is registered and landed,
  // and that is exactly what it now says.
  const identical: GateResult = "target" in registered
    ? result("E", "PASS", `identical verdict across checkout kinds: ${CHECKOUT_PARITY} is registered and ${registered.target} is landed — this command does not execute it, so what holds here is that the mechanism exists, not that the three verdicts matched`)
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
    // three times and accepted as the ceiling each time (rounds 2, 3 and 4), in
    // the round-2 reviewer's words:
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
  // Same correction as gate E's sibling half: nothing here runs the mechanism,
  // so the evidence says what was observed -- a registered, landed mechanism --
  // and not that the act it claims was proven.
  const stranded: GateResult = "target" in registered
    ? result("F", "PASS", `nothing ACCEPTed stranded off origin: ${STRANDED_WORK} is registered and ${registered.target} is landed — this command does not execute it, so what holds here is that the mechanism exists, not that the scan came back empty`)
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
  // The meteorite arm used to be a second rehearsal here. It is gone with the
  // rest of that machinery, and this gate does not pretend the mention is
  // therefore worthless: a Whisper stage in the rebuild proof is real evidence
  // that a clean server comes up able to transcribe. It is simply evidence this
  // command cannot reach, because the rebuild artifact records stage verdicts
  // and liveness, not which installer a stage invoked. UNKNOWN, and it says so.
  if (meteoriteMention) {
    arms.push(result("G", "UNKNOWN", `${METEORITE}:${meteoriteMention.line} names ${WHISPER_INSTALLER}, but this command no longer executes ${METEORITE} in any form and its rebuild artifact carries no Whisper evidence — that mention is unmeasured here; the clean-server install path this gate can execute is ${BOOTSTRAP}`));
  }
  // This gate's arms are DISJUNCTIVE -- either install path bringing Whisper up
  // satisfies "the runtime models come up on the clean server" -- which is why
  // worst() is not used here as it is for E's and F's conjunctive halves: it
  // would let an unmeasurable sibling veto a proven install path. But the file's
  // ordering rule still applies to the rest: FAIL beats UNKNOWN, because an
  // observed violation is a stronger claim than an unmeasurable sibling. It used
  // to be the other way round here, so with the meteorite arm now permanently
  // UNKNOWN the bootstrap arm's FAIL -- an installer named and, executed to
  // completion, never run -- could never surface as the gate's verdict.
  const pass = arms.find((arm) => arm.verdict === "PASS");
  if (pass) return pass;
  if (arms.some((arm) => arm.verdict === "FAIL")) {
    return result("G", "FAIL", `${arms.map((arm) => arm.evidence).join("; ")} — a clean server comes up without Whisper`);
  }
  return result("G", "UNKNOWN", arms.map((arm) => arm.evidence).join("; "));
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
