#!/usr/bin/env bun
// Deployed watchdog-alert lock: spawn daemon/server.ts and use Telegram HTTP.
// Importing drainOutbox here would reduce this to the rejected library boundary.
import { existsSync } from 'node:fs';
import { test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(process.env.ORCH_DAEMON_ROOT ?? resolve(import.meta.dir, '..'));
const daemonServer = join(root, 'daemon/server.ts');
const daemonTestEnv = join(root, 'daemon/test-env.ts');
if (!existsSync(daemonServer) || !existsSync(daemonTestEnv)) {
  console.log('SKIP: watchdog transport boundary requires daemon/server.ts and daemon/test-env.ts from v3-telegram; integrator must remove this guard after Telegram lands');
  process.exit(0);
}
test('daemon drains watchdog outbox through Telegram HTTP and retries safely', async () => {
const { isolatedTestEnv } = await import(daemonTestEnv);
const scratch = await mkdtemp(join(tmpdir(), 'watchdog-transport-'));
const state = join(scratch, 'state');
const outbox = join(scratch, 'nudges.outbox');
const chatId = '771337';
const alert = 'ALERT orchestrator-recovery-failed session=orchestrator consecutive=3';
let daemon: ReturnType<typeof Bun.spawn> | undefined;
const recordFile = join(scratch, 'telegram-requests.jsonl');
const modeFile = join(scratch, 'telegram-mode');
let fixture: ReturnType<typeof Bun.spawn> | undefined;
await writeFile(modeFile, 'success');
fixture = Bun.spawn(['bun', join(import.meta.dir, 'watchdog-telegram-http.fixture.ts'), recordFile, modeFile], { stdout: 'pipe', stderr: 'inherit' });
const reader = fixture.stdout.getReader();
const first = await reader.read();
const telegramPort = Number(new TextDecoder().decode(first.value).trim());
reader.releaseLock();
if (!Number.isSafeInteger(telegramPort)) throw new Error('Telegram fixture did not report its port');
// Resolve an address from the runtime API rather than depending on the host's
// optional `ip` utility. Both processes remain in the same network namespace.
const telegramHost = Object.values(networkInterfaces()).flat().find((address) =>
  address?.family === 'IPv4' && !address.internal
)?.address ?? '127.0.0.1';
const requestRows = async () => (await readFile(recordFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line) as { path: string; body: { chat_id?: string | number; text?: string } }]; }
  catch { return []; } // the fixture may be between append syscalls
});
const contents = async () => {
  try { return await readFile(outbox, 'utf8'); } catch { return ''; }
};
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 8_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timeout waiting for ${label}; requests=${JSON.stringify(await requestRows())}`);
}

try {
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'access.json'), JSON.stringify({
    dmPolicy: 'allowlist', allowFrom: [chatId], groups: {},
  }));
  await mkdir(join(state, 'daemon/runtime'), { recursive: true });
  await writeFile(join(state, 'daemon/runtime/orchestrator-binding.json'), JSON.stringify({
    provider: 'codex', session_id: 'transport-fixture', bound_chat_id: chatId,
    tmux_session: '', bound_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(), state_version: 1,
  }));
  await writeFile(outbox, `${alert}\n`);
  daemon = Bun.spawn(['bun', daemonServer], {
    cwd: join(root, 'daemon'),
    env: isolatedTestEnv({
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scratch,
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      TELEGRAM_API_ROOT: `http://${telegramHost}:${telegramPort}`,
      TELEGRAM_BOT_TOKEN: '123456:transport-boundary-fixture',
      // Port 0 asks the kernel to allocate and bind atomically. Reserving an
      // ephemeral port, releasing it, then starting the daemon left a TOCTOU
      // window that became visible when the complete suite ran concurrently.
      TELEGRAM_STATE_DIR: state, TELEGRAM_DAEMON_PORT: '0',
      TELEGRAM_ACCESS_MODE: 'static', TELEGRAM_BOUND_CHAT_ID: chatId,
      TELEGRAM_CHAT_ID: chatId, NUDGE_OUTBOX_FILE: outbox,
      MORNING_OUTBOX_FILE: join(scratch, 'morning.outbox'),
      OUTBOX_POLL_MS: '1000', ORCH_STALL_WATCHDOG_TICK_MS: '600000',
      ORCH_FLEET_KEEPALIVE_INTERVAL_MS: '600000', ORCH_INSTALL_ROOT: root,
      ORCH_CANONICAL_REPO_PATH: scratch, ORCH_STATE_DB: join(scratch, 'absent.db'),
    }),
    stdout: 'ignore', stderr: 'inherit',
  });
  await Bun.sleep(200);
  if (daemon.exitCode !== null) throw new Error(`daemon exited during startup: ${daemon.exitCode}`);

  await waitFor(async () => (await requestRows()).some((row) => row.path.endsWith('/sendMessage') && `${row.body.chat_id}:${row.body.text}` === `${chatId}:${alert}`), 'successful send');
  await waitFor(async () => (await contents()) === '', 'success acknowledgement');

  const retryAlert = `${alert} retry-boundary`;
  await writeFile(modeFile, 'reject');
  const before = (await requestRows()).filter((row) => row.path.endsWith('/sendMessage')).length;
  await writeFile(outbox, `${retryAlert}\n`);
  await waitFor(async () => (await requestRows()).filter((row) => row.path.endsWith('/sendMessage')).length > before, 'rejected send');
  await Bun.sleep(120);
  if ((await contents()).trim() !== retryAlert) throw new Error('rejected send was falsely acknowledged');
  await writeFile(modeFile, 'success');
  await waitFor(async () => (await contents()) === '', 'retry after recovery');
  const rows = await requestRows();
  const retries = rows.filter((row) => row.path.endsWith('/sendMessage') && `${row.body.chat_id}:${row.body.text}` === `${chatId}:${retryAlert}`).length;
  if (retries < 2 || retries > 6) throw new Error(`retry attempts were not bounded: ${retries}`);
  const observed = rows.find((row) => row.path.endsWith('/sendMessage') && row.body.text === alert);
  console.log(`watchdog transport request: ${JSON.stringify(observed)}`);
  console.log('watchdog transport boundary: PASS');
} finally {
  if (daemon?.exitCode === null) {
    daemon.kill('SIGTERM');
    await daemon.exited;
  }
  if (fixture?.exitCode === null) fixture.kill('SIGTERM');
  await rm(scratch, { recursive: true, force: true });
}
}, 15_000);
