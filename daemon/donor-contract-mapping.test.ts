import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileInboundStore } from './adapters/telegram';
import { DurableOutbox, telegramChannelStatus } from './outbox';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

test('DONOR-MAPPED mailbox persists unique inbound messages and deduplicates replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'donor-mailbox-map-')); dirs.push(dir);
  const store = new FileInboundStore(join(dir, 'inbox.json'));
  expect(await store.putIfAbsent({ update_id: 17 })).toBe(true);
  expect(await store.putIfAbsent({ update_id: 17 })).toBe(false);
  expect(await store.count()).toBe(1);
});

test('DONOR-MAPPED replay retains pending outbound work and status exposes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'donor-replay-map-')); dirs.push(dir);
  const inbox = new FileInboundStore(join(dir, 'inbox.json'));
  const path = join(dir, 'outbox.json');
  const failed = new DurableOutbox(path, async () => { throw new Error('offline'); }, 'before-restart');
  await failed.enqueue({ id: 'reply-17', chatId: '7', text: 'done' });
  await failed.flush();
  expect(await telegramChannelStatus(inbox, failed)).toMatchObject({ state: 'degraded', pendingCount: 1 });
  const replay = new DurableOutbox(path, async () => ({ message_id: 22 }), 'after-restart');
  await replay.flush();
  expect(await telegramChannelStatus(inbox, replay)).toMatchObject({ state: 'healthy', deliveredCount: 1 });
});
