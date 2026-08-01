import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('REGRESSION terminal-tool-error: a benign non-zero tool result does not alert', () => {
  expect(classifyTerminalFailure('Error: Exit code 2')).toBeNull();
  expect(
    classifyTerminalFailure(
      "sed: can't read /tmp/missing: No such file or directory",
    ),
  ).toBeNull();
});

test.each([
  ['ERROR orchestrator-provider-exited provider=codex session=fixture', 'exited'],
  ['Provider failed permanently', 'failed'],
  ['Worker exited unexpectedly', 'exited'],
  ['Watchdog stalled awaiting heartbeat', 'stalled'],
  ['Runtime fatal signal 11', 'fatal'],
  ['Provider error: unavailable', 'failed'],
] as const)(
  'REGRESSION review-terminal-failure: classifies %s as %s',
  (line, expected) => {
    expect(classifyTerminalFailure(line)).toBe(expected);
  },
);

test('REGRESSION terminal-alert-self-echo: pure rendered echo does not alert', () => {
  const banner = formatTerminalAlert({
    kind: 'unknown',
    line: 'Provider terminal failure: strange new condition',
    session: 'orchestrator',
  });
  expect(classifyTerminalFailure(banner)).toBeNull();
});

test('REGRESSION terminal-alert-self-echo: a real failure quoting the banner alerts', () => {
  expect(
    classifyTerminalFailure(
      '[internal terminal failure alert] Type: fatal Session: quoted Runtime fatal signal 11',
    ),
  ).toBe('fatal');
});

test('REGRESSION terminal-alert-self-echo: 2026-08-01 09:14 loop transcript does not alert', () => {
  const transcript =
    '\u001b[33m2026-08-01 09:14 [internal terminal failure alert]\u001b[0m\n' +
    'Type: fatal\nSession: orchestrator\n\nRuntime fatal signal 11';
  expect(classifyTerminalFailure(transcript)).toBeNull();
});

test('REGRESSION terminal-alert-self-echo: a failure after a valid multiline banner alerts', () => {
  const chunk =
    formatTerminalAlert({
      kind: 'unknown',
      line: 'Provider terminal failure: strange new condition',
      session: 'orchestrator',
    }) + '\nRuntime fatal signal 11';
  expect(classifyTerminalFailure(chunk)).toBe('fatal');
});

test('REGRESSION ML-1: an unclassified terminal failure remains actionable', () => {
  expect(
    classifyTerminalFailure(
      'Provider terminal failure: strange new condition',
    ),
  ).toBe('unknown');
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

test('REGRESSION ML-1: classifier proves process readiness to its launcher', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'terminal-alert-ready-'));
  const readyFile = join(scratch, 'ready');
  const child = Bun.spawn(
    [process.execPath, 'terminal-alert.ts', '--session', 'fixture', '--ready-file', readyFile],
    { cwd: import.meta.dir, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' },
  );
  try {
    const deadline = Date.now() + 2_000;
    while (!existsSync(readyFile) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(existsSync(readyFile)).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    rmSync(scratch, { recursive: true, force: true });
  }
});
