import { expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import { createProductionTerminalAlertNotifyHandler } from './terminal-alert-notify';
import { formatTerminalAlert } from './terminal-alert';
import { createServer } from 'node:http';

test('REGRESSION W-37: production composition has one journal edge and no session edge', async () => {
  const frame = formatTerminalAlert(
    {
      kind: 'fatal',
      line: 'fatal error: payload must remain journal-only',
      session: 'ag-w37',
    },
    () => '123e4567-e89b-12d3-a456-426614174000',
  );
  const journal: string[] = [];
  const forbiddenInBandCalls: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      journal.push(String(chunk));
      callback();
    },
  });
  const handler = createProductionTerminalAlertNotifyHandler({
    journal: sink,
    notifyChatId: () => null,
    relayHuman: () => forbiddenInBandCalls.push('human'),
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing port');
    const response = await fetch(`http://127.0.0.1:${address.port}/notify`, {
      method: 'POST',
      headers: { 'X-BPA-Alarm-Audience': 'internal' },
      body: frame,
    });
    expect(response.status).toBe(200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  expect(journal).toHaveLength(1);
  expect(JSON.parse(journal[0].slice('[terminal-alert] '.length))).toBe(frame);
  expect(forbiddenInBandCalls).toEqual([]);
});
