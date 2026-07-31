import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const checker = join(import.meta.dir, "check.ts");
const generator = join(import.meta.dir, "index.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

// Builds a throwaway repo with an instructions/ dir populated from a map of
// relative filename -> file contents. Returns the repo root.
function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "instr-check-"));
  temporaryDirectories.push(repo);
  const root = join(repo, "instructions");
  mkdirSync(root, { recursive: true });
  const gate = join(repo, "gate");
  mkdirSync(gate, { recursive: true });
  writeFileSync(join(gate, "land-lib.sh"), readFileSync(join(import.meta.dir, "../../gate/land-lib.sh")));
  for (const [name, contents] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return repo;
}

function doc(front: Record<string, string>, body = "Body.\n"): string {
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

function runCheck(repo: string, extra: string[] = []) {
  return spawnSync("bun", [checker, "--repo", repo, ...extra], { encoding: "utf8" });
}

function runIndex(repo: string, extra: string[] = []) {
  return spawnSync("bun", [generator, "--repo", repo, ...extra], { encoding: "utf8" });
}

const VALID = {
  id: "valid-doc",
  layer: "L1",
  status: "binding",
  audience: "all",
  tags: "[hygiene]",
  summary: "A valid instruction doc.",
};

describe("check.ts", () => {
  test("a valid doc passes and exits zero", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    const result = runCheck(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS valid-doc.md [schema]");
    expect(result.stdout).toContain("0 FAIL");
  });

  test("missing frontmatter is WARN by default, FAIL under --strict", () => {
    const repo = repoWith({ "bare.md": "# No frontmatter\n\nJust prose.\n" });

    const lenient = runCheck(repo);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("WARN bare.md [frontmatter]");

    const strict = runCheck(repo, ["--strict"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("FAIL bare.md [frontmatter]");
  });

  test("duplicate id fails", () => {
    const repo = repoWith({
      "a.md": doc({ ...VALID, id: "same-id" }),
      "b.md": doc({ ...VALID, id: "same-id" }),
    });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("id-uniqueness");
    expect(result.stdout).toContain("'same-id'");
  });

  test("bad enum value fails schema", () => {
    const repo = repoWith({ "x.md": doc({ ...VALID, layer: "L9" }) });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL x.md [schema]");
    expect(result.stdout).toContain("layer must be one of");
  });

  test("bad id (not kebab-case) fails schema", () => {
    const repo = repoWith({ "x.md": doc({ ...VALID, id: "Not_Kebab" }) });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("kebab-case");
  });

  test("dangling decision reference is reported as FAIL", () => {
    const repo = repoWith({
      "x.md": doc({ ...VALID, id: "referrer", decision: "[hr-does-not-exist]" }),
    });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("decision-reference");
    expect(result.stdout).toContain("hr-does-not-exist");
  });

  test("resolvable decision reference passes; cross-tree id is only a WARN", () => {
    const repo = repoWith({
      "target.md": doc({ ...VALID, id: "target-doc" }),
      "referrer.md": doc({ ...VALID, id: "referrer-doc", decision: "[target-doc, l2:framework-rule]" }),
    });
    const result = runCheck(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WARN referrer.md [decision-reference]");
    expect(result.stdout).toContain("l2:framework-rule");
    // No FAIL findings (the summary line's "0 FAIL" count is not a finding line).
    expect(result.stdout).not.toContain("FAIL referrer.md");
    expect(result.stdout).toContain("0 FAIL");
  });

  test("decision: reference resolves against the instance/decisions ledger", () => {
    const repo = repoWith({
      "x.md": doc({ ...VALID, id: "referrer", decision: "[hr-9999]" }),
    });
    // Without the ledger entry, hr-9999 is a dangling FAIL.
    const before = runCheck(repo);
    expect(before.status).toBe(1);
    expect(before.stdout).toContain("decision-reference");

    // Add the ledger file; the reference now resolves and the check is clean.
    const ledger = join(repo, "instance", "decisions");
    mkdirSync(ledger, { recursive: true });
    writeFileSync(join(ledger, "HR-9999.md"), doc({ ...VALID, id: "hr-9999" }));
    const after = runCheck(repo);
    expect(after.status).toBe(0);
    expect(after.stdout).toContain("0 FAIL");
  });

  test("hand-written index (no marker) is SKIP, not FAIL", () => {
    const repo = repoWith({
      "valid-doc.md": doc(VALID),
      "README.md": "# Instructions\n\n- hand written\n",
    });
    const result = runCheck(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP README.md [index-freshness]");
  });

  test("index-freshness: PASS after generation, FAIL when a doc is added", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });

    // Generate the marked index, then the checker should see it fresh.
    expect(runIndex(repo).status).toBe(0);
    const fresh = runCheck(repo);
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toContain("PASS README.md [index-freshness]");

    // Add a doc without regenerating -> stale index is a FAIL.
    writeFileSync(join(repo, "instructions", "second.md"), doc({ ...VALID, id: "second-doc" }));
    const stale = runCheck(repo);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("FAIL README.md [index-freshness]");
  });

  test("missing instructions/ directory fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "instr-empty-"));
    temporaryDirectories.push(repo);
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("root");
  });

  test("[cmd-exists] passes for existing bun tools and bash gate command paths", () => {
    const repo = repoWith({
      "valid-doc.md": doc(VALID, "Run `bun tools/instructions/demo.ts --strict` and `bash gate/demo.sh arg`.\n"),
    });
    mkdirSync(join(repo, "tools", "instructions"), { recursive: true });
    mkdirSync(join(repo, "gate"), { recursive: true });
    writeFileSync(join(repo, "tools", "instructions", "demo.ts"), "");
    writeFileSync(join(repo, "gate", "demo.sh"), "");
    const result = runCheck(repo);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS valid-doc.md [cmd-exists]");
  });

  test("[cmd-exists] fails with the document and exact missing command", () => {
    const repo = repoWith({
      "binding.md": doc(VALID, "Mandatory: `bun tools/instructions/absent.ts --strict`.\n"),
      "informational.md": doc({ ...VALID, id: "info", status: "informational" }, "`bash gate/also-absent.sh`\n"),
    });
    const result = runCheck(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL binding.md [cmd-exists]");
    expect(result.stdout).toContain("bun tools/instructions/absent.ts --strict");
    expect(result.stdout).not.toContain("also-absent.sh");
  });
});

// Fixed clock for deterministic aging via the LEDGER_NOW_MS test seam.
const LEDGER_NOW = Date.parse("2026-07-29T12:00:00.000Z");

function runCheckAt(repo: string, nowMs: number, extra: string[] = []) {
  return spawnSync("bun", [checker, "--repo", repo, ...extra], {
    encoding: "utf8",
    env: { ...process.env, LEDGER_NOW_MS: String(nowMs) },
  });
}

// Writes files under instance/decisions/ of an existing check-repo.
function writeDecision(repo: string, name: string, contents: string): void {
  const dir = join(repo, "instance", "decisions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
}

const hoursAgoIso = (h: number) => new Date(LEDGER_NOW - h * 3600_000).toISOString();
const daysAgoDate = (d: number) =>
  new Date(LEDGER_NOW - d * 86_400_000).toISOString().slice(0, 10);

describe("check.ts ledger aging", () => {
  test("capture.mode=manual keeps a missing inbox as a clear SKIP", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    mkdirSync(join(repo, "instance"), { recursive: true });
    writeFileSync(join(repo, "instance", "params.yaml"), "capture:\n  mode: manual\n");
    const result = runCheckAt(repo, LEDGER_NOW);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("SKIP instance/decisions/inbox.jsonl [ledger]");
    expect(result.stdout).toContain("capture.mode=manual — inbox not expected yet");
  });

  test("capture.mode=daemon makes a missing inbox a FAIL in all checker modes", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    mkdirSync(join(repo, "instance"), { recursive: true });
    writeFileSync(join(repo, "instance", "params.yaml"), "capture:\n  mode: daemon\n");
    for (const extra of [[], ["--strict"]]) {
      const result = runCheckAt(repo, LEDGER_NOW, extra);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("FAIL instance/decisions/inbox.jsonl [ledger]");
      expect(result.stdout).toContain("capture.mode=daemon");
    }
  });

  test("an aged, untriaged inbox row FAILs under --strict, WARNs otherwise", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    writeDecision(
      repo,
      "inbox.jsonl",
      JSON.stringify({ msg_id: 700, chat_id: 1, ts: hoursAgoIso(30), text: "aged" }) + "\n",
    );
    const strict = runCheckAt(repo, LEDGER_NOW, ["--strict"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("[ledger]");
    expect(strict.stdout).toContain("700");

    const lenient = runCheckAt(repo, LEDGER_NOW);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("WARN inbox.jsonl:msg 700 [ledger]");
  });

  test("a triaged-chatter row does not age", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    writeDecision(
      repo,
      "inbox.jsonl",
      JSON.stringify({ msg_id: 701, chat_id: 1, ts: hoursAgoIso(48), text: "hey" }) + "\n",
    );
    writeDecision(
      repo,
      "triage.jsonl",
      JSON.stringify({
        msg_id: 701,
        verdict: "chatter",
        category: "channel-check",
        reason: "liveness-ping",
        quote: "hey",
        triaged_by: "orchestrator",
        triaged_at: "2026-07-29",
      }) + "\n",
    );
    const result = runCheckAt(repo, LEDGER_NOW, ["--strict"]);
    expect(result.status).toBe(0);
  });

  test("a pending HR older than 72h FAILs", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    writeDecision(
      repo,
      "HR-702.md",
      doc({ ...VALID, id: "hr-702" }).replace(
        "summary: A valid instruction doc.",
        `summary: A valid instruction doc.\nstate: pending\ndate: ${daysAgoDate(5)}`,
      ),
    );
    const result = runCheckAt(repo, LEDGER_NOW);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAIL instance/decisions/HR-702.md [ledger]");
    expect(result.stdout).toContain("pending >72h");
  });

  test("a pending HR parked with a future review-by is clean", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    writeDecision(
      repo,
      "HR-703.md",
      doc({ ...VALID, id: "hr-703" }).replace(
        "summary: A valid instruction doc.",
        `summary: A valid instruction doc.\nstate: pending\ndate: ${daysAgoDate(10)}\nparked: waiting\nreview-by: 2026-09-01`,
      ),
    );
    const result = runCheckAt(repo, LEDGER_NOW);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS instance/decisions/HR-703.md [ledger]");
  });

  test("a parked HR past its review-by re-reddens", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    writeDecision(
      repo,
      "HR-704.md",
      doc({ ...VALID, id: "hr-704" }).replace(
        "summary: A valid instruction doc.",
        `summary: A valid instruction doc.\nstate: pending\ndate: ${daysAgoDate(10)}\nparked: waiting\nreview-by: ${daysAgoDate(1)}`,
      ),
    );
    const result = runCheckAt(repo, LEDGER_NOW);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("past its review-by");
  });
});

describe("index.ts", () => {
  test("generates a marked index sorted by id, idempotently", () => {
    const repo = repoWith({
      "zeta.md": doc({ ...VALID, id: "zeta-doc", summary: "Zeta summary." }),
      "alpha.md": doc({ ...VALID, id: "alpha-doc", summary: "Alpha summary." }),
    });
    expect(runIndex(repo).status).toBe(0);
    const first = readFileSync(join(repo, "instructions", "README.md"), "utf8");
    expect(first).toContain("<!-- generated by tools/instructions/index.ts -->");
    // alpha-doc sorts before zeta-doc.
    expect(first.indexOf("alpha.md")).toBeLessThan(first.indexOf("zeta.md"));
    expect(first).toContain("Alpha summary.");

    // Idempotent: a second run yields byte-identical output.
    expect(runIndex(repo).status).toBe(0);
    const second = readFileSync(join(repo, "instructions", "README.md"), "utf8");
    expect(second).toBe(first);
  });

  test("--check prints without writing", () => {
    const repo = repoWith({ "valid-doc.md": doc(VALID) });
    const result = runIndex(repo, ["--check"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("<!-- generated by tools/instructions/index.ts -->");
    // No README written.
    expect(() => readFileSync(join(repo, "instructions", "README.md"), "utf8")).toThrow();
  });
});
