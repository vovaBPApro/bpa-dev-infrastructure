import { afterAll, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DaemonProcess = ReturnType<typeof Bun.spawn>;
const temporaryPaths: string[] = [];
const childProcesses: DaemonProcess[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return address.port;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitFor(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Daemon is still starting.
    }
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${url}`);
}

afterAll(async () => {
  for (const process of childProcesses) {
    process.kill();
    await process.exited;
  }
  for (const path of temporaryPaths) rmSync(path, { recursive: true });
});

test('detached Claude MCP raises an alarm and /reply still delivers through Telegram', async () => {
  const deliveries: Array<{ method: string; body: string }> = [];
  const telegramApi = createServer(async (request, response) => {
    const method = request.url?.split('/').pop() ?? '';
    let body = '';
    for await (const chunk of request) body += chunk;
    if (method === 'sendMessage') deliveries.push({ method, body });
    const result =
      method === 'getMe'
        ? { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' }
        : method === 'getUpdates'
          ? []
          : { message_id: 77 };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result }));
  });
  const telegramPort = await listen(telegramApi);
  const daemonPort = await reservePort();
  const stateDirectory = mkdtempSync(join(tmpdir(), 'mcp-detach-lock-'));
  temporaryPaths.push(stateDirectory);
  const runtimeDirectory = join(stateDirectory, 'daemon', 'runtime');
  mkdirSync(runtimeDirectory, { recursive: true });
  writeFileSync(
    join(stateDirectory, 'access.json'),
    JSON.stringify({
      dmPolicy: 'allowlist',
      allowFrom: ['test-chat'],
      groups: {},
      pending: {},
    }),
  );
  writeFileSync(
    join(runtimeDirectory, 'orchestrator-binding.json'),
    JSON.stringify({
      provider: 'claude',
      session_id: 'test-session',
      bound_chat_id: 'test-chat',
      tmux_session: 'test-session',
      bound_at: '2026-07-31T00:00:00.000Z',
      updated_at: '2026-07-31T00:00:00.000Z',
      state_version: 1,
    }),
  );
  const binDirectory = mkdtempSync(join(tmpdir(), 'mcp-detach-bin-'));
  temporaryPaths.push(binDirectory);
  writeFileSync(join(binDirectory, 'tmux'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });

  const daemon = Bun.spawn(['bun', 'server.ts'], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
      TELEGRAM_DAEMON_PORT: String(daemonPort),
      TELEGRAM_STATE_DIR: stateDirectory,
      TELEGRAM_API_ROOT: `http://127.0.0.1:${telegramPort}`,
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_ACCESS_MODE: 'static',
      TELEGRAM_BOUND_CHAT_ID: 'test-chat',
      ORCH_SESSION: 'test-session',
      ORCH_STALL_WATCHDOG_TICK_MS: '600000',
      OUTBOX_POLL_MS: '600000',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  childProcesses.push(daemon);

  const health = (await (await waitFor(
    `http://127.0.0.1:${daemonPort}/health`,
  )).json()) as {
    connected: boolean;
    mcp_detached: boolean;
    direct_reply_endpoint: string;
  };
  expect(health).toMatchObject({
    connected: false,
    mcp_detached: true,
    direct_reply_endpoint: '/reply',
  });
  const rebind = await fetch(`http://127.0.0.1:${daemonPort}/mcp/rebind`, {
    method: 'POST',
  });
  expect(await rebind.json()).toEqual({
    ok: true,
    status: 'reconnect_required',
    sse_endpoint: '/sse',
  });

  const fallback = await fetch(`http://127.0.0.1:${daemonPort}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'fallback reached the Human' }),
  });
  const fallbackBody = await fallback.text();
  expect(fallback.status, fallbackBody).toBe(200);
  expect(JSON.parse(fallbackBody)).toEqual({
    ok: true,
    chat_id: 'test-chat',
    message_ids: [77],
  });
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].method).toBe('sendMessage');
  expect(deliveries[0].body).toContain('fallback reached the Human');

  await new Promise<void>((resolve) => telegramApi.close(() => resolve()));
});
