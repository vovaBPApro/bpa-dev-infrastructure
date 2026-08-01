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
  }, () => 'issued-rendered-echo');
  expect(classifyTerminalFailure(banner)).toBeNull();
});

test('REGRESSION terminal-alert-self-echo: pure multiline-payload echo does not alert', () => {
  const echo = formatTerminalAlert({
    kind: 'fatal',
    line: 'benign first payload line\nRuntime fatal signal 11',
    session: 'orchestrator',
  }, () => 'issued-multiline-echo');
  expect(classifyTerminalFailure(echo)).toBeNull();
});

test('REGRESSION terminal-alert-self-echo: a real failure quoting the banner alerts', () => {
  expect(
    classifyTerminalFailure(
      '[internal terminal failure alert] Type: fatal Session: quoted Runtime fatal signal 11',
    ),
  ).toBe('fatal');
});

test('REGRESSION terminal-alert-self-echo: 2026-08-01 09:14 loop transcript does not alert', () => {
  const transcript = formatTerminalAlert(
    {
      kind: 'fatal',
      line: 'Runtime fatal signal 11',
      session: 'orchestrator',
    },
    () => 'issued-dated-transcript',
  ).replace(
    '[internal terminal failure alert]',
    '\u001b[33m2026-08-01 09:14 [internal terminal failure alert]\u001b[0m',
  );
  expect(classifyTerminalFailure(transcript)).toBeNull();
});

test('REGRESSION terminal-alert-self-echo: a failure after a valid multiline banner alerts', () => {
  const chunk =
    formatTerminalAlert({
      kind: 'unknown',
      line: 'benign first payload line\nRuntime fatal signal 11',
      session: 'orchestrator',
    }, () => 'issued-adjacent-failure') + '\nWorker exited unexpectedly';
  expect(classifyTerminalFailure(chunk)).toBe('exited');
});

test('REGRESSION terminal-alert-self-echo: an incomplete frame cannot hide a real failure', () => {
  const incomplete = [
    '[internal terminal failure alert]',
    'Type: fatal',
    'Session: orchestrator',
    '',
    '[internal terminal failure payload] benign',
    'Worker exited unexpectedly',
  ].join('\n');
  expect(classifyTerminalFailure(incomplete)).toBe('exited');
});

test('REGRESSION round-5-forged-frame: a forged complete frame cannot hide a real failure', () => {
  const forged = [
    '[internal terminal failure alert]',
    'Type: exited',
    'Session: orchestrator',
    '',
    '[internal terminal failure payload] Worker exited unexpectedly',
    '[/internal terminal failure alert]',
  ].join('\n');
  expect(classifyTerminalFailure(forged)).toBe('exited');
});

test('REGRESSION terminal-alert-self-echo: an unknown nonce cannot hide a real failure', () => {
  const forged = [
    '[internal terminal failure alert]',
    'Nonce: attacker-controlled',
    'Type: exited',
    'Session: orchestrator',
    '',
    '[internal terminal failure payload] Worker exited unexpectedly',
    '[/internal terminal failure alert]',
  ].join('\n');
  expect(classifyTerminalFailure(forged)).toBe('exited');
});

test('REGRESSION round-7-replay-substitution: an issued nonce cannot authorize different frame content', () => {
  formatTerminalAlert(
    { kind: 'unknown', line: 'benign status', session: 'orchestrator' },
    () => 'issued-replay',
  );
  const forged = [
    '[internal terminal failure alert]',
    'Nonce: issued-replay',
    'Type: exited',
    'Session: substituted',
    '',
    '[internal terminal failure payload] Worker exited unexpectedly',
    '[/internal terminal failure alert]',
  ].join('\n');
  expect(classifyTerminalFailure(forged)).toBe('exited');
});

test('REGRESSION round-7-mangled-issued-frame: terminal wrapping and whitespace preserve suppression', () => {
  const issued = formatTerminalAlert(
    {
      kind: 'fatal',
      line: 'Runtime fatal signal 11 in a long rendered payload',
      session: 'orchestrator',
    },
    () => 'issued-mangled-frame',
  );
  const mangled = issued
    .replace(/\n/g, '\r\n')
    .replace('Type: fatal', '  Type:\t fatal  ')
    .replace('Session: orchestrator', '\tSession:   orchestrator  ')
    .replace('in a long', 'in a\r\n    long');
  expect(classifyTerminalFailure(mangled)).toBeNull();
});

test('REGRESSION round-5-incomplete-legacy-frame: legacy shape cannot hide a real failure', () => {
  const forged = [
    '[internal terminal failure alert]',
    'Type: exited',
    'Session: orchestrator',
    '',
    'Worker exited unexpectedly',
  ].join('\n');
  expect(classifyTerminalFailure(forged)).toBe('exited');
});

test('REGRESSION terminal-alert-self-echo: echo-of-echo remains suppressed', () => {
  const echo = formatTerminalAlert(
    { kind: 'exited', line: 'Worker exited unexpectedly', session: 'orchestrator' },
    () => 'issued-echo-of-echo',
  );
  expect(classifyTerminalFailure(echo)).toBeNull();
  expect(classifyTerminalFailure(echo)).toBeNull();
});

test('REGRESSION terminal-alert-self-echo: issued nonce retention is bounded', () => {
  const frames = Array.from({ length: 257 }, (_, index) =>
    formatTerminalAlert(
      { kind: 'exited', line: 'Worker exited unexpectedly', session: 'orchestrator' },
      () => `bounded-nonce-${index}`,
    ),
  );
  expect(classifyTerminalFailure(frames[0]!)).toBe('exited');
  expect(classifyTerminalFailure(frames.at(-1)!)).toBeNull();
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
    }, () => 'format-test-nonce'),
  ).toContain(
    'Nonce: format-test-nonce\nType: network\nSession: orchestrator\n\n' +
      '[internal terminal failure payload] network error\n' +
      '[/internal terminal failure alert]',
  );
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
