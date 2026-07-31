import { expect, test } from 'bun:test';
import {
  classifyTerminalFailure,
  formatTerminalAlert,
  relayTerminalAlert,
  stripTerminalNoise,
} from './terminal-alert';

test.each([
  ["You've hit your limit · resets 3pm", 'usage-limit'],
  ['API request failed: 429 Too Many Requests', '429/overload'],
  ['Authentication failed: invalid session', 'auth'],
  ['agent stalled: no progress for 600s', 'stalled'],
  ['Agent "worker-2" failed: command returned 1', 'failed'],
  ['[watchdog] Claude exited (code 1)', 'exited'],
  ['network error: ECONNRESET', 'network'],
  ['fatal error: uncaught exception', 'fatal'],
] as const)('classifies %s as %s', (line, expected) => {
  expect(classifyTerminalFailure(line)).toBe(expected);
});

test('REGRESSION ML-1: quota exhaustion is quota and never a stall', () => {
  const line = 'Agent stalled after API quota exceeded; no progress for 600s';
  expect(classifyTerminalFailure(line)).toBe('429/overload');
  expect(classifyTerminalFailure(line)).not.toBe('stalled');
});

test('ignores ordinary terminal output', () => {
  expect(classifyTerminalFailure('Tests: 42 pass, 0 fail')).toBeNull();
});

test('strips terminal control sequences before classification', () => {
  const clean = stripTerminalNoise('\u001b[31musage limit\u001b[0m\r');
  expect(clean).toBe('usage limit');
  expect(classifyTerminalFailure(clean)).toBe('usage-limit');
});

test('formats an internal alert with class and session', () => {
  expect(
    formatTerminalAlert({
      kind: 'network',
      line: 'network error',
      session: 'orchestrator',
    }),
  ).toContain('Type: network\nSession: orchestrator\n\nnetwork error');
});

test('REGRESSION ML-1: a rejected notify response is a delivery failure', async () => {
  const rejectedFetch = async () =>
    new Response('unavailable', { status: 503 });

  await expect(
    relayTerminalAlert(
      { kind: '429/overload', line: 'quota exceeded', session: 'test-orch' },
      '4822',
      rejectedFetch,
    ),
  ).rejects.toThrow('notify returned HTTP 503');
});
