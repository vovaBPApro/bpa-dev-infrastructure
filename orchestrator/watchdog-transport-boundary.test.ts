#!/usr/bin/env bun
// Deployed watchdog-alert lock: spawn daemon/server.ts and use Telegram HTTP.
// Importing drainOutbox here would reduce this to the rejected library boundary.
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(process.env.ORCH_DAEMON_ROOT ?? resolve(import.meta.dir, '..'));
const daemonServer = join(root, 'daemon/server.ts');
const daemonTestEnv = join(root, 'daemon/test-env.ts');
if (!existsSync(daemonServer) || !existsSync(daemonTestEnv)) {
  console.log('SKIP: watchdog transport boundary requires daemon/server.ts and daemon/test-env.ts from v3-telegram; integrator must remove this guard after Telegram lands');
  process.exit(0);
}
const { isolatedTestEnv } = await import(daemonTestEnv);
const scratch = await mkdtemp(join(tmpdir(), 'watchdog-transport-'));
const state = join(scratch, 'state');
const outbox = join(scratch, 'nudges.outbox');
const chatId = '771337';
const alert = 'ALERT orchestrator-recovery-failed session=orchestrator consecutive=3';
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let mode: 'success' | 'reject' = 'success';
const attempts: string[] = [];
const methods: string[] = [];
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
const daemonPort = reservation.port;
reservation.stop(true);
const telegram = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    methods.push(path);
    if (path.endsWith('/getMe')) return Response.json({ ok: true, result: { id: 123456, is_bot: true, first_name: 'fixture', username: 'fixture_bot' } });
    if (path.endsWith('/getUpdates')) return Response.json({ ok: true, result: [] });
    if (path.endsWith('/sendMessage')) {
      const body = await request.json() as { chat_id?: string | number; text?: string };
      attempts.push(`${body.chat_id}:${body.text}`);
      if (mode === 'reject') return Response.json({ ok: false, error_code: 503, description: 'fixture reject' }, { status: 503 });
      return Response.json({ ok: true, result: { message_id: attempts.length, date: 0, chat: { id: Number(chatId), type: 'private' }, text: body.text } });
    }
    return Response.json({ ok: true, result: true });
  },
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
  throw new Error(`timeout waiting for ${label}; methods=${methods.join(',')}`);
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
      TELEGRAM_API_ROOT: `http://127.0.0.1:${telegram.port}`,
      TELEGRAM_BOT_TOKEN: '123456:transport-boundary-fixture',
      TELEGRAM_STATE_DIR: state, TELEGRAM_DAEMON_PORT: String(daemonPort),
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

  await waitFor(() => attempts.includes(`${chatId}:${alert}`), 'successful send');
  await waitFor(async () => (await contents()) === '', 'success acknowledgement');

  const retryAlert = `${alert} retry-boundary`;
  mode = 'reject';
  const before = attempts.length;
  await writeFile(outbox, `${retryAlert}\n`);
  await waitFor(() => attempts.length > before, 'rejected send');
  await Bun.sleep(120);
  if ((await contents()).trim() !== retryAlert) throw new Error('rejected send was falsely acknowledged');
  mode = 'success';
  await waitFor(async () => (await contents()) === '', 'retry after recovery');
  const retries = attempts.filter((entry) => entry === `${chatId}:${retryAlert}`).length;
  if (retries < 2 || retries > 6) throw new Error(`retry attempts were not bounded: ${retries}`);
  console.log('watchdog transport boundary: PASS');
} finally {
  if (daemon?.exitCode === null) {
    daemon.kill('SIGTERM');
    await daemon.exited;
  }
  telegram.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
