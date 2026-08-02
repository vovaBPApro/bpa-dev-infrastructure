import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileInboundStore } from './adapters/telegram';
import { DurableOutbox, telegramChannelStatus } from './outbox';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('durable outbound recovery regression lock', () => {
  test('persists failure, reports degraded, and retries exactly once after recovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-telegram-outbox-'));
    dirs.push(dir);
    const path = join(dir, 'outbox.json');
    let sends = 0;
    const first = new DurableOutbox(path, async () => { sends++; throw new Error('fake Bot API unavailable'); }, 'epoch-1');
    expect(await first.enqueue({ id: 'reply-1', chatId: '7', text: 'done' })).toBe(true);
    expect(await first.enqueue({ id: 'reply-1', chatId: '7', text: 'done' })).toBe(false);
    await first.flush();
    await first.flush();
    expect(sends).toBe(1);
    expect(await telegramChannelStatus(new FileInboundStore(join(dir, 'inbox.json')), first)).toMatchObject({
      state: 'degraded', pendingCount: 1, lastError: 'fake Bot API unavailable',
    });

    const recovered = new DurableOutbox(path, async () => ({ message_id: ++sends }), 'epoch-2');
    await recovered.flush();
    await recovered.flush();
    expect(sends).toBe(2);
    expect(await recovered.items()).toEqual([
      expect.objectContaining({ id: 'reply-1', state: 'delivered', attempts: 2, deliveredMessageId: 2 }),
    ]);
    expect(await telegramChannelStatus(new FileInboundStore(join(dir, 'inbox.json')), recovered)).toMatchObject({
      state: 'healthy', pendingCount: 0, deliveredCount: 1,
    });
  });

  test('storage corruption is unknown, never healthy', async () => {
    const status = await telegramChannelStatus(
      { putIfAbsent: async () => true, count: async () => { throw new Error('unreadable'); } },
      new DurableOutbox('/unused', async () => ({ message_id: 1 })),
    );
    expect(status.state).toBe('unknown');
  });
});
