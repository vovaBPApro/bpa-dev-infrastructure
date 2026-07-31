import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createNotifyHandler } from './notify-handler';

test('internal /notify reaches the orchestrator and never the Human relay', async () => {
  const internal: string[] = [];
  const human: string[] = [];
  const server = createServer(
    createNotifyHandler({
      notifyChatId: () => 'human-chat',
      relayInternal: async (text) => {
        internal.push(text);
      },
      relayHuman: (_chat, text) => human.push(text),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    const response = await fetch(`http://127.0.0.1:${address.port}/notify`, {
      method: 'POST',
      headers: { 'X-BPA-Alarm-Audience': 'internal' },
      body: 'classifier alarm',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('queued');
    expect(internal).toEqual(['classifier alarm']);
    expect(human).toEqual([]);
  } finally {
    server.close();
  }
});

test('internal /notify fails closed when orchestrator delivery fails', async () => {
  const human: string[] = [];
  const server = createServer(
    createNotifyHandler({
      notifyChatId: () => 'human-chat',
      relayInternal: async () => {
        throw new Error('orchestrator unavailable');
      },
      relayHuman: (_chat, text) => human.push(text),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    const response = await fetch(`http://127.0.0.1:${address.port}/notify`, {
      method: 'POST',
      headers: { 'X-BPA-Alarm-Audience': 'internal' },
      body: 'classifier alarm',
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('orchestrator unavailable');
    expect(human).toEqual([]);
  } finally {
    server.close();
  }
});
