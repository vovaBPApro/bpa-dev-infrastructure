import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");
const launch = join(import.meta.dir, "launch.sh");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function params(model = "claude-fable-5") {
  return `orchestrator:\n  top_provider: claude\n  top_model: ${model}\n  fallback_provider: codex\n  fallback_model: gpt-5.6-sol\n`;
}

function run(contents: string | null, requested = "claude-fable-5", mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "model-pin-"));
  dirs.push(dir);
  const fixtureOrchestrator = join(dir, "orchestrator");
  const fixtureInstance = join(dir, "instance");
  mkdirSync(fixtureOrchestrator);
  mkdirSync(fixtureInstance);
  for (const name of ["launch.sh", "model-pin.ts", "lib.sh", "proc-identity.sh"]) {
    copyFileSync(join(root, "orchestrator", name), join(fixtureOrchestrator, name));
  }
  const pin = join(fixtureInstance, "params.yaml");
  if (contents !== null) {
    writeFileSync(pin, contents, { mode });
    chmodSync(pin, mode);
  }
  const marker = join(dir, "preflight-reached");
  const preflight = join(dir, "preflight.sh");
  writeFileSync(preflight, `#!/bin/sh\ntouch '${marker}'\nexit 42\n`, { mode: 0o700 });
  const proc = Bun.spawnSync(["bash", join(fixtureOrchestrator, "launch.sh"), "start"], {
    cwd: root,
    env: {
      ...process.env,
      ORCH_PROVIDER: "claude",
      ORCH_CLAUDE_MODEL: requested,
      ORCH_AUTH_PREFLIGHT: preflight,
      ORCH_RUNTIME_DIR: join(dir, "runtime"),
      ORCH_SINGLETON_LOCK_FILE: join(dir, "singleton.lock"),
      ORCH_WORK_DIR: root,
    },
  });
  return { exitCode: proc.exitCode, output: proc.stderr.toString(), marker: Bun.file(marker) };
}

test("runtime environment cannot replace the checker or tracked pin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-pin-bypass-"));
  dirs.push(dir);
  const fakeChecker = join(dir, "accept.ts");
  const fakePin = join(dir, "params.yaml");
  writeFileSync(fakeChecker, "process.exit(0);\n");
  writeFileSync(fakePin, params("claude-sonnet-5"));
  const result = run(params(), "claude-sonnet-5");
  // The exact reviewer bypass inputs are ignored; the repository checker and
  // repository-relative pin still reject before preflight.
  const bypass = Bun.spawnSync(["bash", launch, "start"], {
    cwd: root,
    env: {
      ...process.env,
      ORCH_PROVIDER: "claude",
      ORCH_CLAUDE_MODEL: "claude-sonnet-5",
      ORCH_MODEL_PIN_CHECKER: fakeChecker,
      ORCH_MODEL_PIN_FILE: fakePin,
      ORCH_AUTH_PREFLIGHT: "/bin/false",
      ORCH_RUNTIME_DIR: join(dir, "runtime"),
      ORCH_SINGLETON_LOCK_FILE: join(dir, "singleton.lock"),
      ORCH_WORK_DIR: root,
    },
  });
  expect(result.exitCode).toBe(78);
  expect(bypass.exitCode).toBe(78);
  expect(bypass.stderr.toString()).toContain("cause=mismatch");
});

test("executor refuses a mismatched tracked pin before startup", async () => {
  const result = run(params(), "claude-sonnet-5");
  expect(result.exitCode).toBe(78);
  expect(result.output).toContain("cause=mismatch provider=claude pinned=claude-fable-5 detail=requested-differs");
  expect(await result.marker.exists()).toBe(false);
});

test("matching pin proceeds into the startup path", async () => {
  const result = run(params());
  // launch.sh normalizes an auth-preflight refusal to 2; the marker proves the
  // matching pin crossed the assertion and entered the real startup executor.
  expect(result.exitCode).toBe(2);
  expect(await result.marker.exists()).toBe(true);
});

test.each([
  ["missing", null, 0o600, "cause=missing"],
  ["empty", "", 0o600, "cause=malformed"],
  ["unreadable", params(), 0o000, "cause=unreadable"],
  ["malformed", params("NOT VALID!"), 0o600, "cause=malformed"],
] as const)("%s pin refuses startup", async (_name, contents, mode, cause) => {
  const result = run(contents, "claude-fable-5", mode);
  expect(result.exitCode).toBe(78);
  expect(result.output).toContain(cause);
  expect(await result.marker.exists()).toBe(false);
});

test("malformed request is refused without reflecting its value", () => {
  const requested = "sensitive-fixture-value;token=fixture-secret";
  const result = run(params(), requested);
  expect(result.exitCode).toBe(78);
  expect(result.output).toContain("cause=malformed-request");
  expect(result.output).not.toContain(requested);
});

test("valid mismatched request is refused without reflecting its value", () => {
  const requested = "sensitive-fixture-value";
  const result = run(params(), requested);
  expect(result.exitCode).toBe(78);
  expect(result.output).toContain("cause=mismatch provider=claude pinned=claude-fable-5 detail=requested-differs");
  expect(result.output).not.toContain(requested);
});
