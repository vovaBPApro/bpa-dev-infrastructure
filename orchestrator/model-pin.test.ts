import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const pin = join(dir, "params.yaml");
  if (contents !== null) {
    writeFileSync(pin, contents, { mode });
    chmodSync(pin, mode);
  }
  const marker = join(dir, "preflight-reached");
  const preflight = join(dir, "preflight.sh");
  writeFileSync(preflight, `#!/bin/sh\ntouch '${marker}'\nexit 42\n`, { mode: 0o700 });
  const proc = Bun.spawnSync(["bash", launch, "start"], {
    cwd: root,
    env: {
      ...process.env,
      ORCH_PROVIDER: "claude",
      ORCH_CLAUDE_MODEL: requested,
      ORCH_MODEL_PIN_FILE: pin,
      ORCH_AUTH_PREFLIGHT: preflight,
      ORCH_RUNTIME_DIR: join(dir, "runtime"),
      ORCH_SINGLETON_LOCK_FILE: join(dir, "singleton.lock"),
      ORCH_WORK_DIR: root,
    },
  });
  return { exitCode: proc.exitCode, output: proc.stderr.toString(), marker: Bun.file(marker) };
}

test("executor refuses a mismatched tracked pin before startup", async () => {
  const result = run(params(), "claude-sonnet-5");
  expect(result.exitCode).toBe(78);
  expect(result.output).toContain("cause=mismatch provider=claude pinned=claude-fable-5 live-request=claude-sonnet-5");
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
