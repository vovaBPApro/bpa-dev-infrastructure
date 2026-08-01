import { expect, test } from 'bun:test';
import { deliverTerminalAlert } from './terminal-alert-delivery';
import {
  formatTerminalAlert,
  TERMINAL_ALERT_EVIDENCE_LIMIT,
} from './terminal-alert';

test('REGRESSION W-37: delivery has one out-of-band journal edge and no session edge', () => {
  const frame = formatTerminalAlert(
    {
      kind: 'fatal',
      line: 'fatal error: payload must remain journal-only',
      session: 'ag-w37',
    },
    () => '123e4567-e89b-12d3-a456-426614174000',
  );
  const journal: string[] = [];

  deliverTerminalAlert(frame, {
    journal: (text) => journal.push(text),
  });

  expect(journal).toEqual([frame]);
});

test('REGRESSION W-37: journal failure propagates so HTTP delivery cannot false-green', () => {
  const frame = formatTerminalAlert(
    { kind: 'network', line: 'network error', session: 'ag-w37' },
    () => '123e4567-e89b-12d3-a456-426614174000',
  );

  expect(() =>
    deliverTerminalAlert(frame, {
      journal: () => {
        throw new Error('journal unavailable');
      },
    }),
  ).toThrow('journal unavailable');
});

test('REGRESSION W-37: retained journal evidence is bounded and single-line', () => {
  const evidence = Array.from(
    { length: TERMINAL_ALERT_EVIDENCE_LIMIT + 1_000 },
    (_, index) => (index % 2 === 0 ? 'x' : '\n'),
  ).join('');
  const frame = formatTerminalAlert(
    { kind: 'fatal', line: evidence, session: 'ag-w37\nforged-session' },
    () => '123e4567-e89b-12d3-a456-426614174000',
  );
  const payloadLines = frame
    .split('\n')
    .filter((line) => line.startsWith('[internal terminal failure payload] '));

  expect(payloadLines).toHaveLength(1);
  expect(payloadLines[0]!.length).toBeLessThanOrEqual(
    '[internal terminal failure payload] '.length +
      TERMINAL_ALERT_EVIDENCE_LIMIT +
      1,
  );
  expect(frame).toContain('Session: ag-w37 forged-session');
});
