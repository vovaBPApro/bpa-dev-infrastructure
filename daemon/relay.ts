#!/usr/bin/env bun

import { normalizeRelayPayload } from './reliability';

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function main() {
  const port = process.env.TELEGRAM_DAEMON_PORT ?? '4822';
  const echoOnly = process.env.ORCH_RELAY_ECHO === '1';
  const raw = await readStdin();
  if (!raw.trim()) {
    throw new Error('stdin payload required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('malformed JSON payload');
  }
  const normalized = normalizeRelayPayload(parsed);
  if (!normalized) {
    throw new Error('unsupported hook payload');
  }

  if (echoOnly) {
    process.stdout.write(JSON.stringify(normalized));
    return;
  }
  if (process.env.ORCH_TELEGRAM_RELAY !== '1') {
    process.stdout.write('ignored_unmarked');
    return;
  }
  if (!port) {
    throw new Error('TELEGRAM_DAEMON_PORT is required');
  }

  const res = await fetch(`http://127.0.0.1:${port}/orchestrator/turn-end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(normalized),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`daemon rejected relay: HTTP ${res.status} ${body}`.trim());
  }
  process.stdout.write(await res.text());
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[orchestrator-turnend-relay] ${msg}\n`);
  process.exit(1);
});
