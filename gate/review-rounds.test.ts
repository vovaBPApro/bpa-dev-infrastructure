import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const roots: string[] = [];
const cli = resolve(import.meta.dir, "review-rounds.ts");
function fixture(cap = 3, limit = 3) {
  const root = mkdtempSync(resolve(tmpdir(), "review-rounds-")); roots.push(root);
  const state = resolve(root, "state.json");
  expect(Bun.spawnSync([process.execPath, cli, "init", "--state", state, "--cap", `${cap}`, "--no-progress-limit", `${limit}`]).exitCode).toBe(0);
  return state;
}
function run(state: string, command: string, item = "V3-3.4", extra: string[] = []) {
  return Bun.spawnSync([process.execPath, cli, command, "--state", state, "--item-id", item, ...extra], { stdout: "pipe", stderr: "pipe" });
}
function text(result: ReturnType<typeof Bun.spawnSync>) { return result.stdout.toString() + result.stderr.toString(); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("durable review round enforcement", () => {
  test("refuses a fourth round for the same item after three landed rounds", () => {
    const state = fixture(3, 2);
    for (const digit of ["1", "2", "3"]) {
      expect(run(state, "attempt").exitCode).toBe(0);
      expect(run(state, "landed", "V3-3.4", ["--sha", digit.repeat(40)]).exitCode).toBe(0);
    }
    const fourth = run(state, "attempt");
    expect(fourth.exitCode).toBe(2);
    expect(text(fourth)).toContain("item=V3-3.4 cap=3 parked=cap");
  });

  test("parks no progress distinctly and landed SHAs reset only no-progress", () => {
    const stuck = fixture(5, 2);
    expect(run(stuck, "attempt").exitCode).toBe(0);
    const parked = run(stuck, "attempt");
    expect(text(parked)).toContain("parked=no-progress");

    const moving = fixture(5, 2);
    for (const digit of ["b", "c", "d"]) {
      expect(run(moving, "attempt").exitCode).toBe(0);
      expect(run(moving, "landed", "V3-3.4", ["--sha", digit.repeat(40)]).exitCode).toBe(0);
    }
    const data = JSON.parse(readFileSync(moving, "utf8"));
    expect(data.items["V3-3.4"]).toMatchObject({ rounds: 3, noProgress: 0, park: null, landedSha: "d".repeat(40) });
  });

  test("missing, unreadable, and malformed state fail closed", () => {
    const state = fixture(); rmSync(state);
    expect(text(run(state, "attempt"))).toContain("state-missing");
    writeFileSync(state, "{}\n");
    expect(text(run(state, "attempt"))).toContain("state-malformed");
    chmodSync(state, 0o000);
    expect(text(run(state, "attempt"))).toContain("state-unreadable");

    chmodSync(state, 0o600); rmSync(state); mkdirSync(state);
    expect(text(run(state, "attempt"))).toContain("state-unreadable");
    rmSync(state, { recursive: true }); symlinkSync(`${state}.target`, state);
    expect(text(run(state, "attempt"))).toContain("state-unreadable");
    rmSync(state); expect(Bun.spawnSync(["mkfifo", state]).exitCode).toBe(0);
    expect(text(run(state, "attempt"))).toContain("state-unreadable");
  });

  test("state survives a new process and exposes no self-reset command", () => {
    const state = fixture(1, 3);
    expect(run(state, "attempt", "durable").exitCode).toBe(0);
    expect(run(state, "attempt", "durable").exitCode).toBe(2);
    expect(text(run(state, "override", "durable", ["--reason", "agent self reset"]))).toContain("unknown-command");
    expect(run(state, "attempt", "durable").exitCode).toBe(2);
  });
});
