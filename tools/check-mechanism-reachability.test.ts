import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "./check-mechanism-reachability";

const root = join(import.meta.dir, "..");

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "mechanism-reachability-"));
  const archive = Bun.spawnSync(["git", "-C", root, "archive", "HEAD"], { stdout: "pipe" });
  const unpack = Bun.spawnSync(["tar", "-x", "-C", dir], { stdin: archive.stdout });
  if (archive.exitCode !== 0 || unpack.exitCode !== 0) throw new Error("fixture archive failed");
  for (const file of ["instance/expected-mechanisms.tsv", "instance/expected-mechanism-exclusions.tsv", "tools/check-mechanism-reachability.ts", "tools/check-mechanism-reachability.test.ts"])
    writeFileSync(join(dir, file), readFileSync(join(root, file)));
  Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
  Bun.spawnSync(["git", "-C", dir, "add", "."]);
  return dir;
}

test("repository mechanism inventory has only named, bidirectional exclusions", () => {
  expect(check(root)).toEqual([]);
});

test("the 2026-08-01 watchdog is installed but not armed, and a parked caller is unreachable", () => {
  const dir = fixture();
  try {
    const exclusions = join(dir, "instance/expected-mechanism-exclusions.tsv");
    writeFileSync(exclusions, readFileSync(exclusions, "utf8").split("\n").filter((line) => !line.startsWith("unit:bpa-orchestrator-watchdog.timer\t")).join("\n"));
    expect(check(dir)).toContain("unreachable mechanism: unit:bpa-orchestrator-watchdog.timer");
    writeFileSync(join(dir, "instance/parked/future.md"), "systemctl enable --now bpa-orchestrator-watchdog.timer\n");
    Bun.spawnSync(["git", "-C", dir, "add", "instance/parked/future.md"]);
    expect(check(dir)).toContain("unreachable mechanism: unit:bpa-orchestrator-watchdog.timer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an exemption becomes stale when a real arm edge lands", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "bootstrap/arm.sh"), "systemctl enable --now bpa-orchestrator-watchdog.timer\n");
    Bun.spawnSync(["git", "-C", dir, "add", "bootstrap/arm.sh"]);
    expect(check(dir)).toContain("stale exemption: unit:bpa-orchestrator-watchdog.timer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing manifest fails closed", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "instance/expected-mechanisms.tsv"));
    expect(() => check(dir)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing mechanism target fails closed", () => {
  const dir = fixture();
  try {
    rmSync(join(dir, "tools/check-github-ref-protection.sh"));
    expect(() => check(dir)).toThrow("unreadable file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an empty manifest fails closed", () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "instance/expected-mechanisms.tsv"), "# empty is invalid\n");
    expect(() => check(dir)).toThrow("empty manifest");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the checker is collected by the gate's tracked TypeScript test tier", () => {
  expect(readFileSync(join(root, "gate/land-lib.sh"), "utf8")).toContain("*.test.ts");
  expect(import.meta.path).toEndWith(".test.ts");
});
