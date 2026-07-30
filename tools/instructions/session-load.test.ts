import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  SESSION_LOAD_FAIL_LINES,
  SESSION_LOAD_WARN_LINES,
  collectSessionLoad,
  renderSessionLoad,
  runSessionLoadCheck,
} from "./session-load.ts";

const temporaryDirectories: string[] = [];

// `durableStateProbe` resolves INFRA_STATE_DB > ORCH_STATE_DB > <root>/runtime/
// state.db. Run from the operator's own orchestrator process tree this suite
// inherits ORCH_STATE_DB and reads the LIVE lease database instead of its
// fixture, so the mission/lane assertions below fail for reasons that have
// nothing to do with the code under test. Both pointers are cleared for the
// whole file and restored afterwards.
const savedStateDbEnv = {
  infra: process.env.INFRA_STATE_DB,
  orch: process.env.ORCH_STATE_DB,
};
delete process.env.INFRA_STATE_DB;
delete process.env.ORCH_STATE_DB;

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (savedStateDbEnv.infra === undefined) delete process.env.INFRA_STATE_DB;
  else process.env.INFRA_STATE_DB = savedStateDbEnv.infra;
  if (savedStateDbEnv.orch === undefined) delete process.env.ORCH_STATE_DB;
  else process.env.ORCH_STATE_DB = savedStateDbEnv.orch;
});

// Builds a fixture repo. `docs` maps instructions/<name>.md -> contents;
// `decisions` maps instance/decisions/<name> -> contents; `params` is the
// instance/params.yaml body; `inbox`/`triage` are raw jsonl if given.
function repo(opts: {
  params?: string;
  docs?: Record<string, string>;
  decisions?: Record<string, string>;
  inbox?: string;
  triage?: string;
  handoffs?: Record<string, string>;
  state?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), "session-"));
  temporaryDirectories.push(root);
  mkdirSync(join(root, "instance", "decisions"), { recursive: true });
  mkdirSync(join(root, "instructions"), { recursive: true });
  if (opts.params !== undefined) {
    writeFileSync(join(root, "instance", "params.yaml"), opts.params);
  }
  for (const [name, contents] of Object.entries(opts.docs ?? {})) {
    writeFileSync(join(root, "instructions", name), contents);
  }
  for (const [name, contents] of Object.entries(opts.decisions ?? {})) {
    writeFileSync(join(root, "instance", "decisions", name), contents);
  }
  if (opts.inbox !== undefined) writeFileSync(join(root, "instance", "decisions", "inbox.jsonl"), opts.inbox);
  if (opts.triage !== undefined) writeFileSync(join(root, "instance", "decisions", "triage.jsonl"), opts.triage);
  if (opts.handoffs) {
    const dir = join(root, "orchestrator", "runtime", "handoffs");
    mkdirSync(dir, { recursive: true });
    for (const [name, contents] of Object.entries(opts.handoffs)) writeFileSync(join(dir, name), contents);
  }
  if (opts.state) seedState(root);
  return root;
}

function initializeGit(root: string): string {
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "session-load@test.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Session Load Test"]);
  writeFileSync(join(root, "tracked.txt"), "clean\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function seedState(root: string): void {
  mkdirSync(join(root, "runtime"), { recursive: true });
  const db = new Database(join(root, "runtime", "state.db"));
  db.exec(`
    CREATE TABLE missions (id TEXT, correlation_id TEXT, state TEXT);
    CREATE TABLE lanes (id TEXT, mission_id TEXT, state TEXT);
    CREATE TABLE leases (lease_key TEXT, owner TEXT, fencing_token INTEGER, expires_at INTEGER, released_at INTEGER);
  `);
  db.query("INSERT INTO missions VALUES (?, ?, ?)").run("mission-live", "corr-live", "running");
  db.query("INSERT INTO lanes VALUES (?, ?, ?)").run("lane-live", "mission-live", "running");
  db.query("INSERT INTO leases VALUES (?, ?, ?, ?, NULL)").run("lane-live", "coder-a", 7, Date.now() + 60_000);
  db.close();
}

function doc(fm: Record<string, string>, body = "Body line.\n"): string {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

describe("collectSessionLoad — composition", () => {
  test("repo SHA is present and the dirty warning appears iff dirty", () => {
    const root = repo({});
    const sha = initializeGit(root);
    expect(collectSessionLoad(root).text).toContain(`repo_sha: ${sha}`);
    expect(collectSessionLoad(root).text).not.toContain("WARNING: working tree dirty at session load");

    writeFileSync(join(root, "tracked.txt"), "dirty\n");
    expect(collectSessionLoad(root).text).toContain("WARNING: working tree dirty at session load");
  });

  test("renders live durable mission, lane, and lease state", () => {
    const root = repo({ state: true });
    const text = collectSessionLoad(root).text;
    expect(text).toContain('missions: [{"id":"mission-live","correlationId":"corr-live","state":"running"}]');
    expect(text).toContain('lanes: [{"id":"lane-live","missionId":"mission-live","state":"running"}]');
    expect(text).toContain('leases: [{"key":"lane-live","owner":"coder-a","fencingToken":7');
  });

  test("startup verdict is ready on a clean healthy load", () => {
    const root = repo({
      state: true,
      handoffs: { "2026-07-30T00-00-00.000Z-a-to-b.json": "{}\n" },
    });
    initializeGit(root);
    expect(collectSessionLoad(root).text).toContain("startup: ready");
  });

  test("startup verdict is degraded with a reason on a seeded probe fault", () => {
    const root = repo({});
    const text = collectSessionLoad(root).text;
    expect(text).toContain("missions: unknown");
    expect(text).toContain("startup: degraded (git state unknown; no handoff found; durable state unknown (state DB absent))");
  });

  test("includes params.yaml verbatim", () => {
    const root = repo({ params: "operator:\n  language: uk\n" });
    const load = collectSessionLoad(root);
    expect(load.text).toContain("instance/params.yaml");
    expect(load.text).toContain("language: uk");
  });

  test("params absent -> an (absent) placeholder, not a crash", () => {
    const root = repo({});
    expect(collectSessionLoad(root).text).toContain("(absent)");
  });

  test("prints the lexically latest handoff in full", () => {
    const root = repo({
      handoffs: {
        "2026-01-01T00-00-00.000Z-a-to-b.json": '{"timestamp":"old"}\n',
        "2026-07-29T12-00-00.000Z-b-to-c.json": '{"timestamp":"LATEST"}\n',
      },
    });
    const text = collectSessionLoad(root).text;
    expect(text).toContain('{"timestamp":"LATEST"}');
    expect(text).not.toContain('{"timestamp":"old"}');
  });

  test("missing handoff emits the exact degraded-start warning", () => {
    const root = repo({});
    expect(collectSessionLoad(root).text).toContain("WARNING: no handoff found — degraded start");
  });

  test("pending HR rows are included in full; routed ones are not", () => {
    const root = repo({
      decisions: {
        "HR-100.md": doc({ id: "hr-100", state: "pending" }, "PENDING DIRECTIVE TEXT\n"),
        "HR-200.md": doc({ id: "hr-200", state: "routed" }, "ROUTED ALREADY\n"),
      },
    });
    const text = collectSessionLoad(root).text;
    expect(text).toContain("PENDING DIRECTIVE TEXT");
    expect(text).not.toContain("ROUTED ALREADY");
  });

  test("untriaged inbox rows are listed; routed/triaged ones are not", () => {
    const root = repo({
      decisions: { "HR-11.md": doc({ id: "hr-11", state: "routed" }, "x\n") },
      inbox:
        [
          JSON.stringify({ msg_id: 11, chat_id: 1, ts: "t", text: "already routed" }),
          JSON.stringify({ msg_id: 12, chat_id: 1, ts: "t", text: "OPEN DIRECTIVE" }),
          JSON.stringify({ msg_id: 13, chat_id: 1, ts: "t", text: "chatter" }),
        ].join("\n") + "\n",
      triage: JSON.stringify({ msg_id: 13, verdict: "chatter" }) + "\n",
    });
    const text = collectSessionLoad(root).text;
    expect(text).toContain("OPEN DIRECTIVE");
    expect(text).not.toContain("already routed");
    expect(text).not.toContain("chatter");
  });

  test("orchestrator + all binding docs appear as summaries; other audiences do not", () => {
    const root = repo({
      docs: {
        "orch.md": doc({ id: "orch-doc", layer: "L1", status: "binding", audience: "orchestrator", tags: "[]", summary: "ORCH SUMMARY" }, "full orch body\n"),
        "all.md": doc({ id: "all-doc", layer: "L1", status: "binding", audience: "all", tags: "[]", summary: "ALL SUMMARY" }, "full all body\n"),
        "coder.md": doc({ id: "coder-doc", layer: "L1", status: "binding", audience: "coder", tags: "[]", summary: "CODER SUMMARY" }, "coder body\n"),
        "info.md": doc({ id: "info-doc", layer: "L1", status: "informational", audience: "orchestrator", tags: "[]", summary: "INFO SUMMARY" }, "info body\n"),
      },
    });
    const text = collectSessionLoad(root).text;
    expect(text).toContain("ORCH SUMMARY");
    expect(text).toContain("ALL SUMMARY");
    // Coder-only + informational are excluded.
    expect(text).not.toContain("CODER SUMMARY");
    expect(text).not.toContain("INFO SUMMARY");
    // Bodies are NOT inlined (index, not full corpus).
    expect(text).not.toContain("full orch body");
  });

  test("lineCount matches the rendered text", () => {
    const root = repo({ params: "a: b\n" });
    const load = collectSessionLoad(root);
    expect(load.lineCount).toBe(load.text.split("\n").length);
    expect(renderSessionLoad(root)).toBe(load.text);
  });
});

describe("runSessionLoadCheck — budget cap", () => {
  test("a small load PASSes", () => {
    const root = repo({ params: "a: b\n" });
    const finding = runSessionLoadCheck(root);
    expect(finding.level).toBe("PASS");
    expect(finding.detail).toContain("lines");
  });

  test("WARN in the head-room band (env-lowered thresholds)", () => {
    const root = repo({ params: "a: b\n".repeat(20) });
    const prev = { fail: process.env.SESSION_LOAD_FAIL_LINES, warn: process.env.SESSION_LOAD_WARN_LINES };
    process.env.SESSION_LOAD_FAIL_LINES = "1000";
    process.env.SESSION_LOAD_WARN_LINES = "5";
    try {
      expect(runSessionLoadCheck(root).level).toBe("WARN");
    } finally {
      restore("SESSION_LOAD_FAIL_LINES", prev.fail);
      restore("SESSION_LOAD_WARN_LINES", prev.warn);
    }
  });

  test("FAIL above the hard cap (env-lowered threshold)", () => {
    const root = repo({ params: "a: b\n".repeat(20) });
    const prev = { fail: process.env.SESSION_LOAD_FAIL_LINES, warn: process.env.SESSION_LOAD_WARN_LINES };
    process.env.SESSION_LOAD_FAIL_LINES = "5";
    process.env.SESSION_LOAD_WARN_LINES = "3";
    try {
      const finding = runSessionLoadCheck(root);
      expect(finding.level).toBe("FAIL");
      expect(finding.detail).toContain("over the 5-line cap");
    } finally {
      restore("SESSION_LOAD_FAIL_LINES", prev.fail);
      restore("SESSION_LOAD_WARN_LINES", prev.warn);
    }
  });

  test("default thresholds are 600/500", () => {
    expect(SESSION_LOAD_FAIL_LINES).toBe(600);
    expect(SESSION_LOAD_WARN_LINES).toBe(500);
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
