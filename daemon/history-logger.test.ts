import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyOutboundHistory,
  contentFingerprint,
  flushHistoryLogger,
  logHistory,
  logInbound,
  type HistoryEntry,
} from './history-logger';

const dirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-history-'));
  dirs.push(dir);
  process.env.TELEGRAM_STATE_DIR = dir;
  return dir;
}

function entries(dir: string): HistoryEntry[] {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return readFileSync(join(dir, 'history', `messages-${ym}.jsonl`), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

afterEach(async () => {
  await flushHistoryLogger();
  delete process.env.TELEGRAM_STATE_DIR;
  delete process.env.TELEGRAM_HISTORY_MAX_BYTES;
  delete process.env.TELEGRAM_HISTORY_RETENTION_DAYS;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('inbound history records receipt metadata but never secret content', async () => {
  const dir = stateDir();
  const secret = 'credential-value-that-must-not-be-logged';
  logInbound({
    ts: '2026-07-31T08:00:00.000Z', chat_id: '7', user: 'operator',
    message_id: 41, type: 'text', kind: 'update', ...contentFingerprint(secret),
  });
  await new Promise((resolve) => queueMicrotask(resolve));
  await flushHistoryLogger();
  const raw = JSON.stringify(entries(dir));
  expect(raw).not.toContain(secret);
  expect(entries(dir)[0]).toMatchObject({ direction: 'in', outcome: 'received', content_length: secret.length });
});

test('successful outbound delivery is logged after Telegram returns', async () => {
  const events: string[] = [];
  const captured: HistoryEntry[] = [];
  const result = await applyOutboundHistory(
    async () => { events.push('sent'); return { message_id: 77 }; },
    'sendMessage', { chat_id: 9, text: 'delivered secret', reply_parameters: { message_id: 3 } }, undefined,
    { now: () => '2026-07-31T08:01:00.000Z', log: (entry) => { events.push('logged'); captured.push(entry); } },
  );
  expect(result).toEqual({ message_id: 77 });
  expect(events).toEqual(['sent', 'logged']);
  expect(captured[0]).toMatchObject({ direction: 'out', outcome: 'delivered', message_id: 77, reply_to: 3 });
  expect(JSON.stringify(captured)).not.toContain('delivered secret');
});

test('failed outbound delivery records failure without Telegram error material', async () => {
  const captured: HistoryEntry[] = [];
  const errorSecret = 'API error includes credential';
  await expect(applyOutboundHistory(
    async () => { throw new Error(errorSecret); },
    'sendDocument', { chat_id: '9', caption: 'document secret' }, undefined,
    { log: (entry) => captured.push(entry) },
  )).rejects.toThrow(errorSecret);
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ direction: 'out', outcome: 'failed', type: 'document' });
  expect(JSON.stringify(captured)).not.toContain('secret');
  expect(JSON.stringify(captured)).not.toContain('credential');
});

test('history file growth is capped by removing oldest complete records', async () => {
  const dir = stateDir();
  process.env.TELEGRAM_HISTORY_MAX_BYTES = '500';
  for (let index = 0; index < 12; index += 1) {
    logHistory({
      ts: new Date().toISOString(), direction: 'in', outcome: 'received', chat_id: '1', user: 'u',
      message_id: index, type: 'text', content_length: 80, content_sha256: `${index}`.padStart(64, '0'),
    });
  }
  await flushHistoryLogger();
  const kept = entries(dir);
  const rawBytes = Buffer.byteLength(JSON.stringify(kept).replace(/^\[|\]$/g, '').replace(/\},\{/g, '}\n{') + '\n');
  expect(rawBytes).toBeLessThanOrEqual(500);
  expect(kept.at(-1)?.message_id).toBe(11);
  expect(kept[0]!.message_id).toBeGreaterThan(0);
});

test('a cap smaller than one record skips it instead of exceeding the cap', async () => {
  const dir = stateDir();
  process.env.TELEGRAM_HISTORY_MAX_BYTES = '1';
  logHistory({
    ts: new Date().toISOString(), direction: 'in', outcome: 'received', chat_id: '1',
    user: 'u', type: 'text', content_length: 0,
  });
  await flushHistoryLogger();
  expect(() => entries(dir)).toThrow();
});

test('retention removes expired monthly files but preserves recent history', async () => {
  const dir = stateDir();
  const historyDir = join(dir, 'history');
  mkdirSync(historyDir);
  const expired = join(historyDir, 'messages-2020-01.jsonl');
  const recent = join(historyDir, 'messages-2020-02.jsonl');
  writeFileSync(expired, '{"old":true}\n');
  writeFileSync(recent, '{"recent":true}\n');
  const now = Date.now();
  utimesSync(expired, new Date(now - 3 * 86_400_000), new Date(now - 3 * 86_400_000));
  utimesSync(recent, new Date(now), new Date(now));
  process.env.TELEGRAM_HISTORY_RETENTION_DAYS = '2';

  logHistory({
    ts: new Date(now).toISOString(), direction: 'in', outcome: 'received', chat_id: '1',
    user: 'u', type: 'text', content_length: 0,
  });
  await flushHistoryLogger();

  expect(() => readFileSync(expired)).toThrow();
  expect(readFileSync(recent, 'utf8')).toContain('recent');
});
