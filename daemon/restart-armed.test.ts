import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const children: ReturnType<typeof Bun.spawn>[] = [];

// This suite spawns a real daemon. Run from the operator's own orchestrator
// process tree it inherits that orchestrator's live ORCH_* pointers
// (ORCH_INSTANCE_LOCK_FILE, ORCH_STATE_DB, ORCH_LEASE_FILE, ORCH_HEARTBEAT_FILE
// ...), so the fixture daemon aims at live state instead of its scratch
// directory — the test then fails, and worse, the daemon under test is one
// wrong branch away from writing to it. Every ORCH_* is dropped here and the
// suite passes back only what it means to set.
function isolatedEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ORCH_')) continue;
    if (key.startsWith('TELEGRAM_')) continue;
    if (key.startsWith('INFRA_')) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

test('bound chat restart passes chat id to the launcher', () => {
  const source = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8');
  const restartBranch = source.match(
    /if \(cmd === '\/restart'\) \{([\s\S]*?)\n  \}\n\n  return false;/,
  )?.[1];
  expect(restartBranch).toBeDefined();
  expect(restartBranch).toContain('await stopOrchestratorSession();');
  expect(restartBranch).toContain('launchProvider(provider, chat_id)');
});

async function waitForHttp(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error('daemon HTTP server did not start');
}

test('restart after dead tmux reaps stale ownership and fully arms bound instance', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'restart-armed-'));
  const stateDir = join(scratch, 'state');
  const runtimeDir = join(stateDir, 'daemon', 'runtime');
  const installRoot = join(scratch, 'install');
  const binDir = join(scratch, 'bin');
  const homeDir = join(scratch, 'home');
  const sessionFile = join(scratch, 'tmux-alive');
  const leaseFile = join(scratch, 'orchestrator.lease');
  const chatId = '424242';
  const instanceLock = join(
    homeDir,
    '.claude',
    `orchestrator-chat-${chatId}.lock`,
  );
  const bindingFile = join(runtimeDir, 'orchestrator-binding.json');
  const callsFile = join(scratch, 'launcher.calls');
  // OS-assigned free port (blind random picks collided in review — see the
  // freePort note in watchdog-turnend-a1.test.ts).
  const port = (() => {
    const probe = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    });
    const p = probe.port;
    probe.stop(true);
    return p;
  })();

  mkdirSync(join(installRoot, 'orchestrator'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(homeDir, '.claude'), { recursive: true });
  writeFileSync(
    bindingFile,
    JSON.stringify({
      provider: 'codex',
      session_id: 'old-session',
      bound_chat_id: chatId,
      tmux_session: 'bound-orchestrator',
      bound_at: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:00:00.000Z',
      state_version: 1,
    }),
  );
  writeFileSync(leaseFile, 'owner=dead-owner\ntoken=7\n');
  writeFileSync(instanceLock, '{"pid":999999,"pid_started_at":"stale"}\n');

  const launcher = join(installRoot, 'orchestrator', 'launch.sh');
  writeFileSync(
    launcher,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1 lock=\${ORCH_INSTANCE_LOCK_FILE:-}" >> "\${TEST_CALLS_FILE:?}"
case "$1" in
  stop)
    rm -f "\${TEST_SESSION_FILE:?}" "\${TEST_LEASE_FILE:?}" "\${TEST_INSTANCE_LOCK:?}"
    ;;
  start)
    [[ ! -e "\${TEST_LEASE_FILE:?}" && ! -e "\${TEST_INSTANCE_LOCK:?}" ]] || exit 73
    [[ "\${ORCH_INSTANCE_LOCK_FILE:-}" == "\${TEST_INSTANCE_LOCK:?}" ]] || exit 74
    printf 'owner=new-owner\\ntoken=8\\n' > "\${TEST_LEASE_FILE:?}"
    printf '{"pid":12345,"pid_started_at":"fresh"}\\n' > "\${ORCH_INSTANCE_LOCK_FILE}"
    : > "\${TEST_SESSION_FILE:?}"
    ;;
esac
`,
  );
  chmodSync(launcher, 0o755);

  const tmux = join(binDir, 'tmux');
  writeFileSync(
    tmux,
    `#!/usr/bin/env bash
[[ "$1" == has-session && -e "\${TEST_SESSION_FILE:?}" ]]
`,
  );
  chmodSync(tmux, 0o755);

  // A coder lane (and the nightly sweep) runs inside the orchestrator's own
  // process tree, so `process.env` carries the LIVE ORCH_*/TELEGRAM_* surface:
  // ORCH_INSTANCE_LOCK_FILE points at the operator's real instance lock,
  // ORCH_PROVIDER/ORCH_SESSION at the running session, ORCH_STATE_DB at the
  // real lease database. Spreading that into the daemon under test made it
  // compute the live instance lock instead of this scratch one — the assertion
  // below caught it, but only because the launcher here is a shim. Scrub the
  // whole prefix and re-add exactly what the test owns.
  const child = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: isolatedEnv({
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TELEGRAM_BOT_TOKEN: '123456:test-token',
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_DAEMON_PORT: String(port),
      ORCH_INSTALL_ROOT: installRoot,
      ORCH_SESSION: 'bound-orchestrator',
      TEST_CALLS_FILE: callsFile,
      TEST_SESSION_FILE: sessionFile,
      TEST_LEASE_FILE: leaseFile,
      TEST_INSTANCE_LOCK: instanceLock,
      OUTBOX_POLL_MS: '600000',
    }),
    stdout: 'ignore',
    stderr: 'inherit',
  });
  children.push(child);

  try {
    await waitForHttp(port);
    const response = await fetch(
      `http://127.0.0.1:${port}/orchestrator/restart`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('restarted');
    expect(readFileSync(callsFile, 'utf8').split('\n').slice(0, 2)).toEqual([
      'stop lock=',
      `start lock=${instanceLock}`,
    ]);
    expect(existsSync(instanceLock)).toBe(true);
    expect(readFileSync(instanceLock, 'utf8')).toContain('"pid":12345');
    expect(readFileSync(leaseFile, 'utf8')).toBe(
      'owner=new-owner\ntoken=8\n',
    );
    const binding = JSON.parse(readFileSync(bindingFile, 'utf8'));
    expect(binding.bound_chat_id).toBe(chatId);
    expect(binding.provider).toBe('codex');
    expect(binding.tmux_session).toBe('bound-orchestrator');
  } finally {
    child.kill();
    await child.exited;
    rmSync(scratch, { recursive: true, force: true });
  }
});
