import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_OPS_JOURNAL_RELATIVE,
  appendOverrideJournal,
  hasComposeMarker,
  resolveOpsJournalPath,
} from "./dispatch-check.ts";
import { PACK_MARKER_PREFIX } from "./compose.ts";

const CLI = join(import.meta.dir, "dispatch-check.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "dispatch-"));
  temporaryDirectories.push(root);
  return root;
}

const MARKER_LINE = `${PACK_MARKER_PREFIX} role=coder l1=abc12345 -->`;

// Runs the CLI, returning {status, stdout, stderr}. spawnSync never throws on a
// non-zero exit, so both stdout and stderr are captured on every path.
function runCli(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("hasComposeMarker", () => {
  test("true when the first non-blank line is the marker", () => {
    expect(hasComposeMarker(MARKER_LINE + "\n\nrest of pack")).toBe(true);
  });

  test("true with leading blank lines before the marker", () => {
    expect(hasComposeMarker("\n\n  " + MARKER_LINE + "\n")).toBe(true);
  });

  test("false when the marker only appears deeper in the body (no spoofing)", () => {
    expect(hasComposeMarker("some hand-written intro\n" + MARKER_LINE + "\n")).toBe(false);
  });

  test("false for forged or incomplete marker lookalikes", () => {
    expect(hasComposeMarker("<!-- compose.ts pack v1 forged -->\n")).toBe(false);
    expect(hasComposeMarker("<!-- compose.ts pack v1 role=coder -->\n")).toBe(false);
    expect(hasComposeMarker("<!-- compose.ts pack v1 l1=abc12345 -->\n")).toBe(false);
    expect(hasComposeMarker("<!-- compose.ts pack v1 role=attacker l1=abc12345 -->\n")).toBe(false);
    expect(hasComposeMarker(MARKER_LINE + " junk\n")).toBe(false);
  });

  test("false for a marker-less prompt", () => {
    expect(hasComposeMarker("please implement item 6\n")).toBe(false);
  });

  test("false for an empty / whitespace-only file", () => {
    expect(hasComposeMarker("")).toBe(false);
    expect(hasComposeMarker("\n   \n")).toBe(false);
  });
});

describe("resolveOpsJournalPath", () => {
  test("defaults under the repo's orchestrator/runtime/", () => {
    expect(resolveOpsJournalPath("/repo", undefined)).toBe(join("/repo", DEFAULT_OPS_JOURNAL_RELATIVE));
  });
  test("an absolute override wins", () => {
    expect(resolveOpsJournalPath("/repo", "/abs/journal.log")).toBe("/abs/journal.log");
  });
  test("a relative override is taken from the repo root", () => {
    expect(resolveOpsJournalPath("/repo", "sub/j.log")).toBe(join("/repo", "sub", "j.log"));
  });
});

describe("appendOverrideJournal", () => {
  test("appends one escaped line and creates the parent dir", () => {
    const repo = tempRepo();
    const path = appendOverrideJournal(repo, {
      promptPath: "/x/p.txt",
      reason: "line1\nline2",
      ts: "2026-07-29T00:00:00.000Z",
    });
    expect(existsSync(path)).toBe(true);
    const contents = readFileSync(path, "utf8");
    // Exactly one physical line (the embedded newline is JSON-escaped).
    expect(contents.split("\n").filter((l) => l !== "")).toHaveLength(1);
    expect(contents).toContain("DISPATCH_OVERRIDE");
    expect(contents).toContain('reason="line1\\nline2"');
  });

  test("is append-only across calls", () => {
    const repo = tempRepo();
    appendOverrideJournal(repo, { promptPath: "/a", reason: "r1", ts: "2026-07-29T00:00:00.000Z" });
    const path = appendOverrideJournal(repo, { promptPath: "/b", reason: "r2", ts: "2026-07-29T00:00:01.000Z" });
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
  });
});

describe("dispatch-check CLI", () => {
  test("exit 0 for a prompt with the compose marker", () => {
    const repo = tempRepo();
    const prompt = join(repo, "good.txt");
    writeFileSync(prompt, MARKER_LINE + "\n\npack body\n");
    const result = runCli([prompt, "--repo", repo]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  test("exit 3 (refusal) for a marker-less prompt, and NOTHING is journaled", () => {
    const repo = tempRepo();
    const prompt = join(repo, "bad.txt");
    writeFileSync(prompt, "hand-written prompt, no marker\n");
    const result = runCli([prompt, "--repo", repo]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("REFUSED");
    expect(existsSync(join(repo, DEFAULT_OPS_JOURNAL_RELATIVE))).toBe(false);
  });

  test("exit 3 for a forged compose-marker lookalike", () => {
    const repo = tempRepo();
    const prompt = join(repo, "forged.txt");
    writeFileSync(prompt, "<!-- compose.ts pack v1 forged -->\nhand-written prompt\n");
    const result = runCli([prompt, "--repo", repo]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("REFUSED");
  });

  test("DISPATCH_OVERRIDE with a reason forces exit 0 and journals the override", () => {
    const repo = tempRepo();
    const prompt = join(repo, "bad.txt");
    writeFileSync(prompt, "no marker here\n");
    const result = runCli([prompt, "--repo", repo], { DISPATCH_OVERRIDE: "repairing compose tooling" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("OVERRIDE accepted");
    const journal = readFileSync(join(repo, DEFAULT_OPS_JOURNAL_RELATIVE), "utf8");
    expect(journal).toContain("DISPATCH_OVERRIDE");
    expect(journal).toContain("repairing compose tooling");
  });

  test("an empty DISPATCH_OVERRIDE is rejected (exit 2), journals nothing", () => {
    const repo = tempRepo();
    const prompt = join(repo, "bad.txt");
    writeFileSync(prompt, "no marker\n");
    const result = runCli([prompt, "--repo", repo], { DISPATCH_OVERRIDE: "   " });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("MUST carry a reason");
    expect(existsSync(join(repo, DEFAULT_OPS_JOURNAL_RELATIVE))).toBe(false);
  });

  test("DISPATCH_OVERRIDE is refused when its journal is outside runtime", () => {
    const repo = tempRepo();
    const prompt = join(repo, "bad.txt");
    writeFileSync(prompt, "no marker\n");
    const result = runCli([prompt, "--repo", repo], {
      DISPATCH_OVERRIDE: "repairing compose tooling",
      ORCH_OPS_JOURNAL: "/dev/null",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("OVERRIDE refused");
  });

  test("a missing prompt file is a usage error (exit 2)", () => {
    const repo = tempRepo();
    const result = runCli([join(repo, "nope.txt"), "--repo", repo]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not found");
  });

  test("no prompt argument is a usage error (exit 2)", () => {
    const result = runCli(["--repo", tempRepo()]);
    expect(result.status).toBe(2);
  });
});

describe("dispatch-lane.sh wrapper", () => {
  const WRAPPER = join(import.meta.dir, "..", "..", "orchestrator", "dispatch-lane.sh");

  function runWrapper(
    args: string[],
    env: Record<string, string> = {},
  ): { status: number; stdout: string; stderr: string } {
    const result = spawnSync("bash", [WRAPPER, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  test("gate-only: passes a marker prompt, refuses a marker-less one", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-wrap-"));
    temporaryDirectories.push(dir);
    const good = join(dir, "good.txt");
    const bad = join(dir, "bad.txt");
    writeFileSync(good, MARKER_LINE + "\n\nbody\n");
    writeFileSync(bad, "no marker\n");

    const okResult = runWrapper([good]);
    expect(okResult.status).toBe(0);
    expect(okResult.stdout).toContain("gate-only");

    const refused = runWrapper([bad]);
    expect(refused.status).toBe(3);
  });

  test("refuses a marker-less prompt even when ORCH_DISPATCH_CHECK names an always-ok checker", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-wrap-"));
    temporaryDirectories.push(dir);
    const bad = join(dir, "bad.txt");
    const alwaysOk = join(dir, "always-ok.ts");
    writeFileSync(bad, "no marker\n");
    writeFileSync(alwaysOk, "process.exit(0);\n");

    const result = runWrapper([bad], { ORCH_DISPATCH_CHECK: alwaysOk });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("REFUSED");
  });

  test("with a launcher tail, the launcher receives the prompt path", () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-wrap-"));
    temporaryDirectories.push(dir);
    const good = join(dir, "good.txt");
    const out = join(dir, "launched.txt");
    writeFileSync(good, MARKER_LINE + "\n\nbody\n");
    // A trivial launcher: `sh -c 'printf %s "$1" > out' _` — the prompt path is
    // appended as the final arg by the wrapper.
    const result = runWrapper([good, "--", "sh", "-c", `printf '%s' "$1" > '${out}'`, "_"]);
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(good);
  });
});
