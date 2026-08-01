import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const serverSource = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8');
const productionModule = join(import.meta.dir, 'terminal-alert-notify.ts');
const forbidden: string[] = [];

if (existsSync(productionModule)) {
  const { createProductionTerminalAlertNotifyHandler } = await import(
    './terminal-alert-notify'
  );
  const events = new EventEmitter();
  const journal = Object.assign(events, {
    write(_line: string, callback: (error?: Error | null) => void): boolean {
      callback();
      return true;
    },
  });
  const handler = createProductionTerminalAlertNotifyHandler({
    journal,
    notifyChatId: () => null,
    relayHuman: () => forbidden.push('human'),
  });
  const request = new Request('http://127.0.0.1/notify', {
    method: 'POST',
    headers: { 'X-BPA-Alarm-Audience': 'internal' },
    body: 'fatal error: behavioral red-before',
  });
  const response = await new Promise<{ status: number }>((resolve) => {
    const headers = new Headers(request.headers);
    const req = Object.assign(request.body!, {
      method: request.method,
      url: '/notify',
      headers: Object.fromEntries(headers),
    });
    const res = {
      status: 0,
      writeHead(status: number) {
        this.status = status;
      },
      end() {
        resolve({ status: this.status });
      },
    };
    void handler(req as any, res as any);
  });
  if (response.status !== 200) throw new Error(`notify returned ${response.status}`);
} else {
  const marker = 'relayInternal: async (text) => {';
  const bodyStart = serverSource.indexOf(marker);
  const bodyEnd = serverSource.indexOf('\n  },\n});', bodyStart);
  if (bodyStart < 0 || bodyEnd < 0) {
    throw new Error('could not locate production relayInternal body');
  }
  const body = serverSource.slice(bodyStart + marker.length, bodyEnd);
  const runLegacyProductionBody = new Function(
    'text',
    'serializeTelegramChannel',
    'TMUX_SESSION',
    'tmuxAlive',
    'tmuxPasteText',
    'activeServer',
    `return (async () => {${body}})()`,
  );
  await runLegacyProductionBody(
    'fatal error: behavioral red-before',
    (text: string) => text,
    'watched',
    async () => true,
    async () => {
      forbidden.push('tmux');
      return true;
    },
    {
      notification: async () => forbidden.push('mcp'),
    },
  );
}

if (forbidden.length > 0) {
  throw new Error(
    `REGRESSION W-37: production delivered into watched session via ${forbidden.join(',')}`,
  );
}

console.log('PASS W-37 production delivery has no watched-session edge');
