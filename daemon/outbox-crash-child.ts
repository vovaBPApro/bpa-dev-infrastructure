import { readFile, writeFile } from 'node:fs/promises';
import { BotApiClient } from './adapters/telegram';
import { createProductionTelegramOutbox } from './outbox';

const [mode, path, ledgerPath] = process.argv.slice(-3);
if (!mode || !path || !ledgerPath) throw new Error('mode, path and ledger required');
const readLedger = async (): Promise<Record<string, { message_id: number }>> => {
  try { return JSON.parse(await readFile(ledgerPath, 'utf8')); } catch { return {}; }
};
const fakeHttp = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.pathname.endsWith('/sendMessage')) {
    const key = request.headers.get('idempotency-key') ?? '';
    if (((await request.json()) as { idempotency_key?: string }).idempotency_key !== key) throw new Error('key mismatch');
    const ledger = await readLedger();
    ledger[key] ??= { message_id: Object.keys(ledger).length + 1 };
    await writeFile(ledgerPath, JSON.stringify(ledger));
    if (mode === 'crash') await new Promise(() => {});
    return Response.json({ ok: true, result: ledger[key] });
  }
  const delivery = (await readLedger())[url.searchParams.get('idempotency_key') ?? ''];
  return delivery ? Response.json({ ok: true, result: delivery }) : new Response('missing', { status: 404 });
};
const api = new BotApiClient({ baseUrl: 'http://fake.invalid', token: 'test', fetch: fakeHttp });
const outbox = createProductionTelegramOutbox(path, api);
if (mode === 'crash') await outbox.enqueue({ id: 'crash-key', chatId: '7', text: 'done' });
await outbox.flush();
