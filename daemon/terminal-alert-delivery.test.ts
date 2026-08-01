import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  composeTerminalAlertJournalLine,
  deliverTerminalAlert,
} from './terminal-alert-delivery';
import {
  formatTerminalAlert,
  TERMINAL_ALERT_EVIDENCE_LIMIT,
} from './terminal-alert';

function frame(): string {
  return formatTerminalAlert(
    { kind: 'network', line: 'network error', session: 'ag-w37' },
    () => '123e4567-e89b-12d3-a456-426614174000',
  );
}

test('REGRESSION W-37: synchronous journal throw fails delivery', async () => {
  const events = new EventEmitter();
  const journal = Object.assign(events, {
    write(): boolean {
      throw new Error('journal unavailable');
    },
  });
  await expect(deliverTerminalAlert(frame(), { journal })).rejects.toThrow(
    'journal unavailable',
  );
});

test('REGRESSION W-37: backpressure requires callback and drain acceptance', async () => {
  const events = new EventEmitter();
  let callback: ((error?: Error | null) => void) | undefined;
  const journal = Object.assign(events, {
    write(_line: string, done: (error?: Error | null) => void): boolean {
      callback = done;
      return false;
    },
  });
  let accepted = false;
  const delivery = deliverTerminalAlert(frame(), { journal }).then(() => {
    accepted = true;
  });
  callback?.();
  await Bun.sleep(0);
  expect(accepted).toBe(false);
  events.emit('drain');
  await delivery;
  expect(accepted).toBe(true);
});

test('REGRESSION W-37: synchronous callback with backpressure cannot bypass drain', async () => {
  const events = new EventEmitter();
  const journal = Object.assign(events, {
    write(_line: string, done: (error?: Error | null) => void): boolean {
      done();
      return false;
    },
  });

  await expect(
    deliverTerminalAlert(frame(), { journal, acceptanceTimeoutMs: 20 }),
  ).rejects.toThrow('acceptance timed out');
});

test('REGRESSION W-37: synchronous callback with backpressure succeeds after drain', async () => {
  const events = new EventEmitter();
  const journal = Object.assign(events, {
    write(_line: string, done: (error?: Error | null) => void): boolean {
      done();
      return false;
    },
  });

  const delivery = deliverTerminalAlert(frame(), {
    journal,
    acceptanceTimeoutMs: 100,
  });
  queueMicrotask(() => events.emit('drain'));
  await delivery;
});

test('REGRESSION W-37: asynchronous stream error fails delivery', async () => {
  const events = new EventEmitter();
  const journal = Object.assign(events, {
    write(_line: string, done: (error?: Error | null) => void): boolean {
      done();
      queueMicrotask(() => events.emit('error', new Error('disk failed')));
      return true;
    },
  });
  await expect(
    deliverTerminalAlert(frame(), { journal, acceptanceTimeoutMs: 100 }),
  ).rejects.toThrow('disk failed');
});

test('REGRESSION W-37: missing or partial acceptance times out fail-closed', async () => {
  const events = new EventEmitter();
  const journal = Object.assign(events, {
    write(): boolean {
      return true;
    },
  });
  await expect(
    deliverTerminalAlert(frame(), { journal, acceptanceTimeoutMs: 20 }),
  ).rejects.toThrow('acceptance timed out');
});

test('REGRESSION W-37: retained journal frame is complete, bounded, and single-line', () => {
  const evidence = Array.from(
    { length: TERMINAL_ALERT_EVIDENCE_LIMIT + 1_000 },
    (_, index) => (index % 2 === 0 ? 'x' : '\n'),
  ).join('');
  const alert = formatTerminalAlert(
    { kind: 'fatal', line: evidence, session: 'ag-w37\nforged-session' },
    () => '123e4567-e89b-12d3-a456-426614174000',
  );
  const journalLine = composeTerminalAlertJournalLine(alert);

  expect(journalLine.split('\n')).toHaveLength(2);
  expect(journalLine.endsWith('\n')).toBe(true);
  expect(JSON.parse(journalLine.slice('[terminal-alert] '.length))).toBe(alert);
  expect(journalLine.length).toBeLessThan(16_384);
});
