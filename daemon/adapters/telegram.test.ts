import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotApiClient, FileInboundStore, TelegramAdapter } from './telegram';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe('TelegramAdapter durable inbound regression lock', () => {
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
});
