import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotApiClient, FileInboundStore, TelegramAdapter } from './telegram';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('TelegramAdapter durable inbound regression lock', () => {
  test('REGRESSION sends the idempotency key across the HTTP boundary', async () => {
    let request: Request | undefined;
    const api = new BotApiClient({
      baseUrl: 'http://fake.invalid', token: 'test',
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }));
      },
    });
    await api.sendMessage('7', 'done', 'reply-7');
    expect(request?.headers.get('idempotency-key')).toBe('reply-7');
    expect(await request?.json()).toMatchObject({ idempotency_key: 'reply-7' });
  });

  test('persists an inbound update before acknowledgement and deduplicates replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-telegram-inbox-'));
    dirs.push(dir);
    const path = join(dir, 'inbox.json');
    const update = { update_id: 41, message: { message_id: 9, chat: { id: 7 }, text: 'hello' } };
    let polls = 0;
    const fakeFetch = async () =>
      new Response(JSON.stringify({ ok: true, result: polls++ === 0 ? [update] : [update] }), {
        headers: { 'content-type': 'application/json' },
      });
    const acknowledgements: number[] = [];
    const adapter = new TelegramAdapter(
      new BotApiClient({ baseUrl: 'http://fake.invalid', token: 'test', fetch: fakeFetch }),
      new FileInboundStore(path),
      async (received) => {
        const durable = JSON.parse(await readFile(path, 'utf8')) as Array<{ update_id: number }>;
        expect(durable.some((item) => item.update_id === received.update_id)).toBe(true);
        acknowledgements.push(received.update_id);
      },
    );

    await adapter.receiveOnce();
    await adapter.receiveOnce();
    expect(acknowledgements).toEqual([41]);
    expect(await new FileInboundStore(path).count()).toBe(1);
  });

  test('does not acknowledge when durable persistence fails', async () => {
    let acknowledged = false;
    const adapter = new TelegramAdapter(
      new BotApiClient({
        baseUrl: 'http://fake.invalid',
        token: 'test',
        fetch: async () => new Response(JSON.stringify({ ok: true, result: [{ update_id: 1 }] })),
      }),
      { putIfAbsent: async () => { throw new Error('disk full'); }, count: async () => 0 },
      async () => { acknowledged = true; },
    );
    await expect(adapter.receiveOnce()).rejects.toThrow('disk full');
    expect(acknowledged).toBe(false);
  });

  test('REGRESSION concurrent inbound writes preserve every unique update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v3-telegram-inbox-concurrent-'));
    dirs.push(dir);
    const path = join(dir, 'inbox.json');
    const stores = Array.from({ length: 40 }, () => new FileInboundStore(path));
    const inserted = await Promise.all(stores.map((store, update_id) => store.putIfAbsent({ update_id })));
    expect(inserted.every(Boolean)).toBe(true);
    expect(await new FileInboundStore(path).count()).toBe(40);
  });
});
