import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
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

  test('REGRESSION pending without an error is degraded, never healthy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-telegram-pending-'));
    dirs.push(dir);
    const outbox = new DurableOutbox(join(dir, 'outbox.json'), async () => ({ message_id: 1 }));
    await outbox.enqueue({ id: 'pending-1', chatId: '7', text: 'wait' });
    expect(await telegramChannelStatus(new FileInboundStore(join(dir, 'inbox.json')), outbox)).toMatchObject({
      state: 'degraded', pendingCount: 1,
    });
  });

  test('REGRESSION success-before-local-commit reconciles by idempotency key without a duplicate send', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-telegram-reconcile-'));
    dirs.push(dir);
    const path = join(dir, 'outbox.json');
    await Bun.write(path, JSON.stringify({ version: 1, items: [{
      id: 'reply-crash', chatId: '7', text: 'done', state: 'sending', attempts: 1,
      attemptedEpochs: ['dead-epoch'],
    }] }));
    let sends = 0;
    const recovered = new DurableOutbox(
      path,
      async () => ({ message_id: ++sends }),
      'recovery-epoch',
      async (key) => key === 'reply-crash' ? { message_id: 91 } : null,
    );
    await recovered.flush();
    expect(sends).toBe(0);
    expect(await recovered.items()).toEqual([
      expect.objectContaining({ id: 'reply-crash', state: 'delivered', deliveredMessageId: 91 }),
    ]);
  });

  test('REGRESSION concurrent enqueue and flush do not lose or duplicate items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-telegram-outbox-concurrent-'));
    dirs.push(dir);
    const path = join(dir, 'outbox.json');
    const sent = new Set<string>();
    const boxes = Array.from({ length: 30 }, (_, index) => new DurableOutbox(
      path,
      async (_chat, _text, key) => { sent.add(key); return { message_id: index + 1 }; },
      `epoch-${index}`,
    ));
    await Promise.all(boxes.map((box, index) => box.enqueue({ id: `item-${index}`, chatId: '7', text: 'done' })));
    await Promise.all(boxes.map((box) => box.flush()));
    const items = await boxes[0]!.items();
    expect(items).toHaveLength(30);
    expect(items.every((item) => item.state === 'delivered')).toBe(true);
    expect(sent.size).toBe(30);
  });

  test('REGRESSION dead-owner lock is taken over without waiting for timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-telegram-stale-lock-'));
    dirs.push(dir);
    const path = join(dir, 'outbox.json');
    await mkdir(`${path}.lock`);
    await writeFile(`${path}.lock/owner.json`, JSON.stringify({
      token: 'dead-owner', pid: 999_999_999, hostname: hostname(), leaseExpiresAt: Date.now() + 60_000,
    }));
    const started = Date.now();
    const outbox = new DurableOutbox(path, async () => ({ message_id: 1 }));
    expect(await outbox.enqueue({ id: 'after-crash', chatId: '7', text: 'ok' })).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
