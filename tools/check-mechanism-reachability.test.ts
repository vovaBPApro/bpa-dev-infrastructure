import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, classify } from "./check-mechanism-reachability";
import { stripHeredocs, stripShellComments } from "./invocation-graph";

const root = join(import.meta.dir, "..");

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "mechanism-reachability-"));
  const archive = Bun.spawnSync(["git", "-C", root, "archive", "HEAD"], { stdout: "pipe" });
  const unpack = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout });
  if (archive.exitCode !== 0 || unpack.exitCode !== 0) throw new Error("fixture archive failed");
  for (const file of ["instance/expected-mechanisms.tsv", "instance/required-mechanisms.tsv", "instance/expected-mechanism-exclusions.tsv", "tools/invocation-graph.ts", "tools/check-mechanism-reachability.ts", "tools/check-mechanism-reachability.test.ts"])
    writeFileSync(join(dir, file), readFileSync(join(root, file)));
  Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
  Bun.spawnSync(["git", "-C", dir, "add", "."]);
  return dir;
}

function stage(dir: string): void {
  Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
}

function named(errors: string[], prefix: string): string[] {
  return errors.filter((error) => error.startsWith(prefix));
}

// Replace the single line of `file` that invokes `needle`, and return the text
// that was removed, so a lock can assert it really was the invocation.
function cutInvocation(dir: string, file: string, needle: string, replacement: (line: string) => string): string {
  const path = join(dir, file);
  const text = readFileSync(path, "utf8");
  const line = text.split("\n").find((candidate) => candidate.includes(needle) && !candidate.trimStart().startsWith("#"));
  if (!line) throw new Error(`no invocation of ${needle} in ${file}`);
  writeFileSync(path, text.replace(line, replacement(line)));
  return line;
}

// The three tests below classify the REAL repository rather than a fixture, so
// each one walks every tracked source. That takes 2-4s on an idle host and more
// under load, which put them over bun's 5s default; they carry the same explicit
// 30s budget as every fixture test in this file. The budget is plumbing, not the
// assertion -- a checker that actually hung would still fail here.
test("repository mechanism inventory has only named, bidirectional exclusions", () => {
  expect(check(root)).toEqual([]);
}, 30_000);

// The accounting artifact for V3-0.28's reopening. Every mechanism's verdict is
// pinned WITH the class it rests on, so a mechanism that quietly drops from a
// production caller to a fixture-only test cannot keep reading as reachable.
// `fixture-only` rows are the two the substring rule used to call reachable.
test("every mechanism's reachability class is pinned and says where", () => {
  const { results } = classify(root);
  expect([...results.values()].map((result) => `${result.id}\t${result.cls}`)).toEqual([
    "unit:bpa-orchestrator.service\tnone",
    "unit:bpa-orchestrator-watchdog.service\tnone",
    "unit:bpa-orchestrator-watchdog.timer\tnone",
    "unit:bpa-telegram-daemon.service\tnone",
    "unit:bpa-full-suite.service\tnone",
    "unit:bpa-full-suite.timer\tnone",
    "unit:bpa-meteorite.service\tnone",
    "unit:bpa-meteorite.timer\tnone",
    "unit:bpa-deploy-drift-guard.service\tnone",
    "unit:bpa-deploy-drift-guard.timer\tnone",
    "unit:orch-morning-report.service\tnone",
    "unit:orch-morning-report.timer\tnone",
    "unit:agentic-bpa-db-grants.service\tnone",
    "unit:agentic-bpa-db-grants.timer\tnone",
    "unit:agentic-bpa-staleness.service\tnone",
    "unit:agentic-bpa-staleness.timer\tnone",
    "unit:agentic-bpa-stand-verifier.service\tnone",
    "checker:decision-ledger\ttest-real",
    "checker:github-ref-protection\tfixture-only",
    "checker:shared-stash\tfixture-only",
    "checker:mechanism-reachability\ttest-real",
    "checker:documented-mission-cli\tproduction",
    "checker:retained-branches\tproduction",
    "cron:reap\tproduction",
    "tier:shell\tgate-collected",
    "gate:landing\tdocumented-entry",
    "runner:meteorite\tproduction",
  ]);
  for (const result of results.values()) expect(result.where.length, `${result.id} states no evidence`).toBeGreaterThan(0);
}, 30_000);

test("the production executor each reachable mechanism rests on is named exactly", () => {
  const { results } = classify(root);
  expect(results.get("checker:retained-branches")!.where).toContain("gate/land.sh:416");
  expect(results.get("cron:reap")!.where).toContain("bootstrap/install.sh:258");
  expect(results.get("runner:meteorite")!.where).toContain("meteorite/prove-candidate.sh");
  expect(results.get("checker:decision-ledger")!.where).toContain("tools/check-decision-ledger-drift.test.ts");
}, 30_000);

// --- what "invoked" means, locked one property at a time -------------------
//
// Each lock removes the ONE real invocation of a mechanism and leaves behind
// the kind of mention the substring rule accepted. All of them were green
// before this change: `text.includes(basename)` cannot tell a call from prose.

test("a comment naming a mechanism is not an executor", () => {
  const dir = fixture();
  try {
    const cut = cutInvocation(dir, "gate/land.sh", "check-retained-branches.ts", () => "  : # retained-branch check removed");
    expect(cut).toContain("$BUN_BIN");
    // The exact mutation the reviewer used to reopen V3-0.28: append a comment
    // naming the mechanism to an unrelated tracked script.
    appendFileSync(join(dir, "hygiene/reap.sh"), "\n# see also hygiene/check-retained-branches.ts\n");
    stage(dir);
    expect(named(check(dir), "unreachable mechanism: checker:retained-branches")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("a mechanism named as data to grep, cp or printf is not an executor", () => {
  const dir = fixture();
  try {
    cutInvocation(dir, "gate/land.sh", "check-retained-branches.ts", () => "  : # retained-branch check removed");
    // The last of these is a COMPLETE command line -- inside a string literal
    // that printf writes somewhere. Text about running something is not
    // running it, exactly as an installed-but-unenabled timer is not armed.
    appendFileSync(join(dir, "hygiene/reap.sh"), [
      "",
      "grep -F hygiene/check-retained-branches.ts hygiene/reap.sh",
      "cp hygiene/check-retained-branches.ts /tmp/copy.ts",
      `printf '%s\\n' "9 * * * * bun hygiene/check-retained-branches.ts --repo ."`,
      "",
    ].join("\n"));
    stage(dir);
    expect(named(check(dir), "unreachable mechanism: checker:retained-branches")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("an invocation buried in a shell function nothing calls is not an executor", () => {
  const dir = fixture();
  try {
    cutInvocation(dir, "gate/land.sh", "check-retained-branches.ts", (line) => `retained_branch_check_never_called() {\n${line}\n}`);
    stage(dir);
    expect(named(check(dir), "unreachable mechanism: checker:retained-branches")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// The lock above can only fail while its function name is unique, so it proves
// nothing about a tree with 11 `die`, 10 `usage` and 8 `cleanup` definitions.
// This is the same property with a SHARED name, and it is two-sided on purpose:
// `install_hygiene_cron` is defined and CALLED in bootstrap/install.sh, where it
// carries cron:reap's only production edge. Burying gate/land.sh's invocation in
// a second, never-called function of that same name must kill one and leave the
// other -- keying liveness on the bare name reports both as live.
test("a dead function is not resurrected by a live function of the same name elsewhere", () => {
  const dir = fixture();
  try {
    const callers = readFileSync(join(dir, "bootstrap/install.sh"), "utf8");
    expect(callers).toContain("install_hygiene_cron() {");
    expect(callers.split("\n").some((line) => /^\s*install_hygiene_cron\s*$/.test(line))).toBe(true);
    cutInvocation(dir, "gate/land.sh", "check-retained-branches.ts", (line) => `install_hygiene_cron() {\n${line}\n}`);
    stage(dir);
    const { results } = classify(dir);
    expect(results.get("checker:retained-branches")!.cls).not.toBe("production");
    expect(results.get("cron:reap")!.where).toContain("bootstrap/install.sh");
    expect(named(check(dir), "unreachable mechanism: checker:retained-branches")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// The other side of scoping by file: a library function IS live when the script
// that sources the library calls it. Scoping liveness to the defining file alone
// would be a false negative here, and false negatives are what let an
// exemption's exit condition go unnoticed.
test("a function in a sourced library is live when the sourcing script calls it", () => {
  const dir = fixture();
  try {
    const cut = cutInvocation(dir, "gate/land.sh", "check-retained-branches.ts", () => "  : # retained-branch check removed");
    appendFileSync(join(dir, "gate/land-lib.sh"), `\nzz_lib_helper() {\n${cut}\n  :\n}\n`);
    // Sourced but never called: the invocation is dead, exactly as in its own file.
    stage(dir);
    expect(readFileSync(join(dir, "gate/land.sh"), "utf8")).toContain('source "$script_dir/land-lib.sh"');
    expect(named(check(dir), "unreachable mechanism: checker:retained-branches")).toHaveLength(1);
    // Now the sourcing script calls it, and the same invocation is live again.
    appendFileSync(join(dir, "gate/land.sh"), "\nzz_lib_helper\n");
    stage(dir);
    expect(classify(dir).results.get("checker:retained-branches")!.where).toContain("gate/land-lib.sh");
    expect(named(check(dir), "unreachable mechanism: checker:retained-branches")).toHaveLength(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// A heredoc body is a shell string literal, so the string-literal ruling above
// applies to it unchanged: `cat > file <<EOD ... EOD` writes text, it does not
// run it. Round 1 counted these as invocations while its own header said the
// opposite; all three spellings are locked so neither can drift back.
test("a heredoc body naming a mechanism is not an executor", () => {
  const dir = fixture();
  try {
    cutInvocation(dir, "gate/land.sh", "check-retained-branches.ts", () => "  : # retained-branch check removed");
    appendFileSync(join(dir, "hygiene/reap.sh"), [
      "",
      "cat > /tmp/plain <<EOD",
      'bun hygiene/check-retained-branches.ts --repo "$PWD"',
      "EOD",
      "cat > /tmp/quoted <<'EOD'",
      "bun hygiene/check-retained-branches.ts --repo .",
      "EOD",
      "cat > /tmp/dashed <<-EOD",
      "\tbun hygiene/check-retained-branches.ts --repo .",
      "\tEOD",
      "",
    ].join("\n"));
    stage(dir);
    expect(named(check(dir), "unreachable mechanism: checker:retained-branches")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// A heredoc must not swallow the rest of the file either: a real invocation
// AFTER the terminator is still a real invocation.
test("an invocation after a heredoc terminator is still an executor", () => {
  const dir = fixture();
  try {
    appendFileSync(join(dir, "hygiene/reap.sh"), [
      "",
      "cat > /tmp/plain <<EOD",
      "nothing to see",
      "EOD",
      'bash hygiene/check-shared-stash.sh "$PWD"',
      "",
    ].join("\n"));
    stage(dir);
    expect(named(check(dir), "stale exemption: checker:shared-stash")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// The heredoc stripper fails in BOTH directions, and round 2 proved the dangerous
// one alternates: round 1 was rejected for scanning heredoc bodies (fail-open),
// and its fix was rejected for reading `$(( 1 << 2 ))` as an opener whose tag
// nothing closes, which blanked the rest of the file (fail-closed, silent, and
// unbounded). So every construct is pinned in both directions at once: what the
// stripper must BLANK, and -- the half round 2 lost -- what must SURVIVE below it.
//
// Asserted against `stripHeredocs` directly, because that is where the header's
// guarantee is written and because a `check()` call costs ~4s; the two locks
// after this one bind the guarantee to the harm it exists to prevent.
const KEEP = 'bash hygiene/check-shared-stash.sh "$PWD"';
const BODY = "bun hygiene/check-retained-branches.ts";
const STRIPPER: readonly (readonly [string, string[], string[]])[] = [
  ["plain tag", [`cat > /tmp/x <<EOD`, BODY, "EOD", KEEP], ["cat > /tmp/x <<EOD", KEEP]],
  ["single-quoted tag", [`cat > /tmp/x <<'EOD'`, BODY, "EOD", KEEP], ["cat > /tmp/x <<'EOD'", KEEP]],
  ["double-quoted tag", [`cat > /tmp/x <<"EOD"`, BODY, "EOD", KEEP], ['cat > /tmp/x <<"EOD"', KEEP]],
  ["dash tag, tab-indented terminator", ["cat > /tmp/x <<-EOD", `\t${BODY}`, "\tEOD", KEEP], ["cat > /tmp/x <<-EOD", KEEP]],
  // Not fixed by banning digits: `cat <<2 … 2` is a real, if perverse, heredoc.
  ["numeric tag", ["cat > /tmp/x <<2", BODY, "2", KEEP], ["cat > /tmp/x <<2", KEEP]],
  ["two openers on one line", ["cat <<A <<B", BODY, "A", BODY, "B", KEEP], ["cat <<A <<B", KEEP]],
  ["herestring consumes no body", [`cat <<< "${BODY}"`, KEEP], [`cat <<< "${BODY}"`, KEEP]],
  ["operator inside a quoted word", [`echo "a <<EOD b"`, KEEP], ['echo "a <<EOD b"', KEEP]],
  ["arithmetic shift", ["zz=$(( 1 << 2 ))", KEEP], ["zz=$(( 1 << 2 ))", KEEP]],
  ["arithmetic command", ["(( zz = 1 << 2 ))", KEEP], ["(( zz = 1 << 2 ))", KEEP]],
  ["arithmetic with nested parens", ["zz=$(( (1 + 1) << 2 ))", KEEP], ["zz=$(( (1 + 1) << 2 ))", KEEP]],
  ["deprecated $[ ] arithmetic", ["zz=$[ 1 << 2 ]", KEEP], ["zz=$[ 1 << 2 ]", KEEP]],
  ["arithmetic shifting by a variable", ["zz=$(( 1 << width ))", KEEP], ["zz=$(( 1 << width ))", KEEP]],
  ["arithmetic in a condition", ["if (( 1 << 2 > 3 )); then :; fi", KEEP], ["if (( 1 << 2 > 3 )); then :; fi", KEEP]],
  // Arithmetic must not disarm a genuine heredoc opened later on the same line.
  ["arithmetic then a real opener, one line", ["zz=$(( 1 << 2 )); cat <<EOD", BODY, "EOD", KEEP], ["zz=$(( 1 << 2 )); cat <<EOD", KEEP]],
  // The ruling: an opener with no terminator blanks nothing. Bounded fail-open,
  // deliberately chosen over the unbounded silent blanking it replaces.
  ["unterminated tag at end of file", ["cat > /tmp/x <<NEVERCLOSED", KEEP], ["cat > /tmp/x <<NEVERCLOSED", KEEP]],
];

test("no construct the heredoc stripper handles blinds it to the lines below", () => {
  for (const [name, input, survives] of STRIPPER) {
    const out = stripHeredocs(stripShellComments(input.join("\n"))).split("\n");
    // Line numbers must stay true: bodies are blanked in place, never removed.
    expect(out, `${name}: line count`).toHaveLength(input.length);
    expect(out.map((line) => line.trim()).filter(Boolean), name).toEqual(survives);
  }
});

// The end-to-end lock for the defect round 2 introduced, at the boundary that
// matters: the checker itself. One arithmetic line above a real invocation made
// `checker:shared-stash` read clean instead of stale. `checker:shared-stash` is
// exempt and driven by other tests in this file, so a fixture that degenerated
// to an unused name would stop producing this error entirely and fail here.
test("shell arithmetic does not hide an invocation from the checker", () => {
  const dir = fixture();
  try {
    appendFileSync(join(dir, "hygiene/reap.sh"), `\nzz=$(( 1 << 2 ))\n${KEEP}\n`);
    stage(dir);
    expect(named(check(dir), "stale exemption: checker:shared-stash")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// Same lock for the other way a tag goes unclosed. Whatever misparse produces it,
// the blast radius must stop at the opener rather than reaching end of file.
test("an unterminated heredoc tag does not hide the invocations below it", () => {
  const dir = fixture();
  try {
    appendFileSync(join(dir, "hygiene/reap.sh"), `\ncat > /tmp/x <<NEVERCLOSED\n${KEEP}\n`);
    stage(dir);
    expect(named(check(dir), "stale exemption: checker:shared-stash")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// `timeout 60 bash x.sh` runs x.sh. Round 1 stopped at the wrapper, so a future
// caller written in any of these forms would have satisfied an exemption's exit
// condition ("delete this row once a tracked caller runs it") in silence.
test("a mechanism invoked through a command wrapper is an executor", () => {
  for (const [form, line] of [
    ["timeout", 'timeout 60 bash hygiene/check-shared-stash.sh "$PWD"'],
    ["timeout with --kill-after", 'timeout -k 5 60 bash hygiene/check-shared-stash.sh "$PWD"'],
    ["xargs", "printf . | xargs -n1 bash hygiene/check-shared-stash.sh"],
    ["find -exec", "find . -maxdepth 0 -exec bash hygiene/check-shared-stash.sh {} \\;"],
    ["flock", 'flock /tmp/lock bash hygiene/check-shared-stash.sh "$PWD"'],
  ] as const) {
    const dir = fixture();
    try {
      appendFileSync(join(dir, "hygiene/reap.sh"), `\n${line}\n`);
      stage(dir);
      expect(named(check(dir), "stale exemption: checker:shared-stash"), form).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}, 120_000);

// package.json scripts are how this repository already drives meteorite/run.sh.
// A checker that answers "does anything run this?" while not reading the file
// the repository runs things from is answering a narrower question than it says.
test("a package.json script is an executor", () => {
  const dir = fixture();
  try {
    const path = join(dir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { scripts: Record<string, string> };
    manifest.scripts["zz-shared-stash"] = "bash hygiene/check-shared-stash.sh .";
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    stage(dir);
    const stale = named(check(dir), "stale exemption: checker:shared-stash");
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("package.json script zz-shared-stash");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("runner:meteorite is not satisfied by docker/whisper-proof-run.sh", () => {
  const dir = fixture();
  try {
    // Eight tracked files contain the substring `run.sh`; exactly TWO invoke
    // meteorite/run.sh -- meteorite/prove-candidate.sh and the `test:meteorite`
    // package.json script. Remove both and the Hard Floor 5 proof must go red
    // rather than resting on an unrelated Whisper script. Each removal is
    // asserted on the way through, so an edge that silently stops being seen
    // fails here instead of quietly shrinking what this lock proves.
    const cut = cutInvocation(dir, "meteorite/prove-candidate.sh", "meteorite/run.sh", () => "  : # runner call removed");
    expect(cut).toContain("bash");
    stage(dir);
    expect(classify(dir).results.get("runner:meteorite")!.where).toContain("package.json script test:meteorite");

    const path = join(dir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8")) as { scripts: Record<string, string> };
    expect(manifest.scripts["test:meteorite"]).toContain("meteorite/run.sh");
    // The Whisper runner stays in package.json: it is the decoy, and it must not
    // satisfy `run.sh` on its own.
    expect(manifest.scripts["test:whisper-proof"]).toContain("docker/whisper-proof-run.sh");
    delete manifest.scripts["test:meteorite"];
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    stage(dir);

    const decoys = Bun.spawnSync(["git", "-C", dir, "ls-files"]).stdout.toString().split("\n").filter((file) => file.includes("run.sh"));
    expect(decoys).toContain("docker/whisper-proof-run.sh");
    expect(named(check(dir), "unreachable mechanism: runner:meteorite")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("a test that drives a checker against a mktemp fixture does not make it reachable", () => {
  const dir = fixture();
  try {
    const path = join(dir, "tools/check-decision-ledger-drift.test.ts");
    const text = readFileSync(path, "utf8");
    expect(text).toContain('const repoRoot = join(import.meta.dir, "..");');
    writeFileSync(path, text.replace('const repoRoot = join(import.meta.dir, "..");', 'const repoRoot = mkdtempSync(join(tmpdir(), "ledger-"));'));
    stage(dir);
    const { results } = classify(dir);
    expect(results.get("checker:decision-ledger")!.cls).toBe("fixture-only");
    expect(named(check(dir), "unreachable mechanism: checker:decision-ledger")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// --- exemptions are decisions, and they expire ------------------------------

test("appending a comment does not lift an exemption", () => {
  const dir = fixture();
  try {
    appendFileSync(join(dir, "hygiene/reap.sh"), "\n# see also check-shared-stash.sh\n");
    stage(dir);
    expect(check(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("an exemption goes stale the moment a real caller lands", () => {
  const dir = fixture();
  try {
    appendFileSync(join(dir, "hygiene/reap.sh"), '\nbash "$repo_root/hygiene/check-shared-stash.sh" "$repo_root"\n');
    stage(dir);
    expect(named(check(dir), "stale exemption: checker:shared-stash")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// --- systemd units ----------------------------------------------------------
//
// The checker reads TRACKED TEXT, never host state: it decides whether a
// tracked file arms a unit, not whether this machine has it enabled. The
// 2026-08-01 watchdog incident (a unit installed and never armed) is therefore
// outside its reach by construction, and no document may claim otherwise.

test("a unit with no tracked arm edge is unreachable, and a parked one does not arm it", () => {
  const dir = fixture();
  try {
    const exclusions = join(dir, "instance/expected-mechanism-exclusions.tsv");
    writeFileSync(exclusions, readFileSync(exclusions, "utf8").split("\n").filter((line) => !line.startsWith("unit:bpa-orchestrator-watchdog.timer\t")).join("\n"));
    expect(named(check(dir), "unreachable mechanism: unit:bpa-orchestrator-watchdog.timer")).toHaveLength(1);
    writeFileSync(join(dir, "instance/parked/future.md"), "systemctl enable --now bpa-orchestrator-watchdog.timer\n");
    Bun.spawnSync(["git", "-C", dir, "add", "instance/parked/future.md"]);
    expect(named(check(dir), "unreachable mechanism: unit:bpa-orchestrator-watchdog.timer")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("an exemption becomes stale when a real arm edge lands", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "bootstrap/arm.sh"), "systemctl enable --now bpa-orchestrator-watchdog.timer\n");
    Bun.spawnSync(["git", "-C", dir, "add", "bootstrap/arm.sh"]);
    expect(named(check(dir), "stale exemption: unit:bpa-orchestrator-watchdog.timer")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("an arm edge that is only a comment does not arm a unit", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "bootstrap/arm.sh"), "# systemctl enable --now bpa-orchestrator-watchdog.timer\n");
    Bun.spawnSync(["git", "-C", dir, "add", "bootstrap/arm.sh"]);
    expect(check(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// --- entry points and the gate's own collection ------------------------------

test("the gate entry point goes unreachable when its documented invocation loses a mandatory flag", () => {
  const dir = fixture();
  try {
    const documented = classify(dir).results.get("gate:landing")!.where.split(",")[0]!;
    const path = join(dir, documented.split(":")[0]!);
    const lines = readFileSync(path, "utf8").split("\n");
    // The documented call is a backslash continuation; drop the whole
    // --item-id line so the remaining invocation is one the gate would refuse.
    const index = lines.findIndex((line) => /^\s*--item-id\b/.test(line));
    expect(index).toBeGreaterThan(-1);
    lines.splice(index, 1);
    writeFileSync(path, lines.join("\n"));
    stage(dir);
    expect(named(check(dir), "unreachable mechanism: gate:landing")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("the shell tier goes unreachable when the gate stops collecting TypeScript tests", () => {
  const dir = fixture();
  try {
    const path = join(dir, "gate/land-lib.sh");
    writeFileSync(path, readFileSync(path, "utf8").replace(/\*\.test\.ts\|/g, ""));
    stage(dir);
    expect(named(check(dir), "unreachable mechanism: tier:shell")).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

// --- manifest integrity (unchanged contract) --------------------------------

test("a missing manifest fails closed", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "instance/expected-mechanisms.tsv"));
    expect(() => check(dir)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("a missing mechanism target fails closed", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "tools/check-github-ref-protection.sh"));
    expect(() => check(dir)).toThrow("unreadable file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("deleting a checker and its scan row still fails against the independent required set", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "tools/check-github-ref-protection.sh"));
    const manifest = join(dir, "instance/expected-mechanisms.tsv");
    writeFileSync(manifest, readFileSync(manifest, "utf8").split("\n").filter((line) => !line.startsWith("checker:github-ref-protection\t")).join("\n"));
    stage(dir);
    expect(check(dir)).toContain("mechanism inventory differs from independent required-mechanisms.tsv");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("an empty manifest fails closed", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "instance/expected-mechanisms.tsv"), "# empty is invalid\n");
    expect(() => check(dir)).toThrow("empty manifest");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("the checker is collected by the gate's tracked TypeScript test tier", () => {
  expect(readFileSync(join(root, "gate/land-lib.sh"), "utf8")).toContain("*.test.ts");
  expect(import.meta.path).toEndWith(".test.ts");
});
