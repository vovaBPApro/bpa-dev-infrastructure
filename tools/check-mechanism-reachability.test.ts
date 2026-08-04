import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, classify } from "./check-mechanism-reachability";

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

test("repository mechanism inventory has only named, bidirectional exclusions", () => {
  expect(check(root)).toEqual([]);
});

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
});

test("the production executor each reachable mechanism rests on is named exactly", () => {
  const { results } = classify(root);
  expect(results.get("checker:retained-branches")!.where).toContain("gate/land.sh:416");
  expect(results.get("cron:reap")!.where).toContain("bootstrap/install.sh:258");
  expect(results.get("runner:meteorite")!.where).toContain("meteorite/prove-candidate.sh");
  expect(results.get("checker:decision-ledger")!.where).toContain("tools/check-decision-ledger-drift.test.ts");
});

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

test("runner:meteorite is not satisfied by docker/whisper-proof-run.sh", () => {
  const dir = fixture();
  try {
    // Eight tracked files contain the substring `run.sh`; exactly one invokes
    // meteorite/run.sh. Remove that one and the Hard Floor 5 proof must go red
    // rather than resting on an unrelated Whisper script.
    const cut = cutInvocation(dir, "meteorite/prove-candidate.sh", "meteorite/run.sh", () => "  : # runner call removed");
    expect(cut).toContain("bash");
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
