import type { IncomingMessage, ServerResponse } from 'node:http';

type NotifyDependencies = {
  notifyChatId: () => string | null;
  relayInternal: (text: string) => Promise<void>;
  relayHuman: (chatId: string, text: string) => void;
};

export function classifyNotifyAudience(
  audience: string | string[] | undefined,
): 'internal' | 'human' {
  return audience === 'internal' ? 'internal' : 'human';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createNotifyHandler(deps: NotifyDependencies) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/notify') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const raw = await readBody(req);
    let text = '';
    try {
      text = String((JSON.parse(raw) as { text?: unknown }).text ?? '');
    } catch {
      text = raw;
    }
    if (!text.trim()) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('missing text');
      return;
    }
    try {
      if (
        classifyNotifyAudience(req.headers['x-bpa-alarm-audience']) ===
        'internal'
      ) {
        await deps.relayInternal(text);
      } else {
        const chat = deps.notifyChatId();
        if (!chat) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('missing chat');
          return;
        }
        deps.relayHuman(chat, text);
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('queued');
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`send_failed: ${err instanceof Error ? err.message : err}`);
    }
  };
}

export function createNotifyFetchHandler(deps: NotifyDependencies) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method !== 'POST' || url.pathname !== '/notify') return new Response('not found', { status: 404 });
    const raw = await req.text();
    let text = '';
    try {
      text = String((JSON.parse(raw) as { text?: unknown }).text ?? '');
    } catch {
      text = raw;
    }
    if (!text.trim()) return new Response('missing text', { status: 400 });
    try {
      if (classifyNotifyAudience(req.headers.get('x-bpa-alarm-audience') ?? undefined) === 'internal') {
        await deps.relayInternal(text);
      } else {
        const chat = deps.notifyChatId();
        if (!chat) return new Response('missing chat', { status: 400 });
        deps.relayHuman(chat, text);
      }
      return new Response('queued');
    } catch (err) {
      return new Response(`send_failed: ${err instanceof Error ? err.message : err}`, { status: 502 });
    }
  };
}
