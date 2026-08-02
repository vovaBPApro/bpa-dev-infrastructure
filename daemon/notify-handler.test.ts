import { expect, test } from 'bun:test';
import {
  classifyNotifyAudience,
  createNotifyFetchHandler,
} from './notify-handler';

test('internal /notify reaches the orchestrator and never the Human relay', async () => {
  const internal: string[] = [];
  const human: string[] = [];
  const handler = createNotifyFetchHandler({
      notifyChatId: () => 'human-chat',
      relayInternal: async (text) => {
        internal.push(text);
      },
      relayHuman: (_chat, text) => human.push(text),
    });
  {
    const response = await handler(new Request('http://127.0.0.1/notify', { method: 'POST', headers: { 'x-bpa-alarm-audience': 'internal' }, body: 'classifier alarm' }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('queued');
    expect(internal).toEqual(['classifier alarm']);
    expect(human).toEqual([]);
  }
});

test('internal /notify fails closed when orchestrator delivery fails', async () => {
  const human: string[] = [];
  const handler = createNotifyFetchHandler({
      notifyChatId: () => 'human-chat',
      relayInternal: async () => {
        throw new Error('orchestrator unavailable');
      },
      relayHuman: (_chat, text) => human.push(text),
    });
  {
    const response = await handler(new Request('http://127.0.0.1/notify', { method: 'POST', headers: { 'x-bpa-alarm-audience': 'internal' }, body: 'classifier alarm' }));

    expect(response.status).toBe(502);
    expect(await response.text()).toContain('orchestrator unavailable');
    expect(human).toEqual([]);
  }
});

test('REGRESSION ML-1: external /notify invokes the Human sender', async () => {
  expect(classifyNotifyAudience(undefined)).toBe('human');
  const internal: string[] = [];
  const human: Array<{ chat: string; text: string }> = [];
  const handler = createNotifyFetchHandler({
      notifyChatId: () => 'human-chat',
      relayInternal: async (text) => {
        internal.push(text);
      },
      relayHuman: (chat, text) => human.push({ chat, text }),
    });
  {
    const response = await handler(new Request('http://127.0.0.1/notify', { method: 'POST', body: 'operator update' }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('queued');
    expect(internal).toEqual([]);
    expect(human).toEqual([{ chat: 'human-chat', text: 'operator update' }]);
  }
});
