// End-to-end lock on the /model round trip: the bytes the daemon writes must
// be the bytes launch.sh resolves. The pure-function tests in
// model-registry.test.ts cannot catch a key-name drift between the two sides —
// this can, because it runs the real launcher against a real pin file.
//
// `launch.sh model` is read-only (no start, no stop, no lock, no state write —
// locked by orchestrator/model-command.test.sh), but the environment is still
// scrubbed of every ORCH_* path: a coder lane runs inside the orchestrator's
// own process tree and inherits its environment, and an inherited
// ORCH_INSTANCE_LOCK_FILE / ORCH_LEASE_FILE / ORCH_HEARTBEAT_FILE / ORCH_STATE_DB
// resolves to the operator's REAL live file.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MODEL_CATALOG,
  PINNABLE_ENV_KEYS,
  parseLauncherModelState,
  upsertEnvAssignment,
} from './model-registry';

const LAUNCHER = join(import.meta.dir, '..', 'orchestrator', 'launch.sh');
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'model-wiring-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Run `launch.sh model` with every live-state path forced into the scratch dir. */
function launcherModel(
  configFile: string,
  provider?: string,
): ReturnType<typeof parseLauncherModelState> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: scratch,
    ORCH_CONFIG_FILE: configFile,
    ORCH_RUNTIME_DIR: join(scratch, 'runtime'),
    ORCH_STATE_DB: join(scratch, 'absent-state.db'),
    ORCH_INSTANCE_LOCK_FILE: join(scratch, 'instance.lock'),
    ORCH_LEASE_FILE: join(scratch, 'orchestrator.lease'),
    ORCH_HEARTBEAT_FILE: join(scratch, 'orchestrator.heartbeat'),
    ORCH_LOCK_FILE: join(scratch, 'launch.lock'),
    ORCH_SINGLETON_LOCK_FILE: join(scratch, 'singleton.lock'),
    ORCH_SESSION: 'model-wiring-test-never-started',
    ORCH_WORK_DIR: scratch,
  };
  if (provider) env.ORCH_PROVIDER = provider;
  // Note the absence of ORCH_MODEL / ORCH_CLAUDE_MODEL / ORCH_CODEX_MODEL:
  // this asserts the pin comes from the FILE, not from an ambient variable.
  const proc = Bun.spawnSync(['bash', LAUNCHER, 'model'], {
    env,
    stderr: 'pipe',
  });
  expect(proc.exitCode).toBe(0);
  return parseLauncherModelState(proc.stdout.toString());
}

test('the launcher resolves defaults with no pin file at all', () => {
  const state = launcherModel(join(scratch, 'absent.env'), 'claude');
  expect(state).not.toBeNull();
  // A fresh clone must not fall through to the account default on EITHER side.
  expect(state!.claudeModel).toBeTruthy();
  expect(state!.codexModel).toBeTruthy();
});

test('every catalog entry round-trips daemon write → launcher read', () => {
  for (const choice of MODEL_CATALOG) {
    const configFile = join(scratch, `pin-${choice.name}.env`);
    // Exactly what handleModelCommand does.
    writeFileSync(configFile, upsertEnvAssignment('', choice.envKey, choice.model));

    const state = launcherModel(configFile, choice.provider);
    expect(state).not.toBeNull();
    const resolved =
      choice.provider === 'codex' ? state!.codexModel : state!.claudeModel;
    expect(resolved).toBe(choice.model);
    // The launcher must report the very file the daemon wrote, or the daemon
    // would be pinning a file nobody sources.
    expect(state!.configFile).toBe(configFile);
  }
});

test('a pin survives a relaunch and repeated re-pinning stays single-valued', () => {
  const configFile = join(scratch, 'sequence.env');
  writeFileSync(configFile, 'ORCH_CODEX_REASONING_EFFORT=high\n');

  let text = readFileSync(configFile, 'utf8');
  for (const model of ['claude-sonnet-5', 'claude-fable-5', 'claude-opus-5']) {
    text = upsertEnvAssignment(text, 'ORCH_CLAUDE_MODEL', model);
    writeFileSync(configFile, text);
    // Fresh launcher process each time — the simulated relaunch.
    expect(launcherModel(configFile, 'claude')!.claudeModel).toBe(model);
  }

  const final = readFileSync(configFile, 'utf8');
  // One live assignment only: a duplicate would silently win at source time.
  expect(final.match(/^ORCH_CLAUDE_MODEL=/gm)).toHaveLength(1);
  // Unrelated host settings are preserved across every re-pin.
  expect(final).toContain('ORCH_CODEX_REASONING_EFFORT=high');
});

test('a claude pin never moves the provider or the codex model', () => {
  const configFile = join(scratch, 'no-hijack.env');
  writeFileSync(
    configFile,
    upsertEnvAssignment('', 'ORCH_CLAUDE_MODEL', 'claude-fable-5'),
  );
  const written = readFileSync(configFile, 'utf8');

  // runtime.env is SOURCED, so anything here overrides the daemon's per-launch
  // `ORCH_PROVIDER='…' launch.sh start`. A provider written by /model would
  // desynchronise binding.provider and decideRelay would reject every turn as
  // provider_mismatch — the operator's only channel goes silent.
  expect(written).not.toMatch(/^ORCH_PROVIDER=/m);
  expect(written).not.toMatch(/^ORCH_MODEL=/m);
  for (const line of written.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const key = line.slice(0, line.indexOf('='));
    expect(PINNABLE_ENV_KEYS).toContain(key as never);
  }

  // Proven against the real launcher: the per-launch provider still wins.
  const asCodex = launcherModel(configFile, 'codex')!;
  expect(asCodex.provider).toBe('codex');
  expect(asCodex.codexModel).not.toBe('claude-fable-5');
  const asClaude = launcherModel(configFile, 'claude')!;
  expect(asClaude.provider).toBe('claude');
  expect(asClaude.claudeModel).toBe('claude-fable-5');
});
