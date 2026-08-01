import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyTerminalFailure,
  formatTerminalAlert,
  relayTerminalAlert,
  stripTerminalNoise,
  AlertRateLimiter,
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
    .replace('Type: f·atal', '  Type:\t f·atal  ')
    .replace('Session: orchestrator', '\tSession:   orchestrator  ')
    .replace('in a long', 'in a\r\n    long');
  expect(classifyTerminalFailure(mangled)).toBeNull();
});

test('REGRESSION round-8-doubled-cr-issued-frame: interior newline noise preserves suppression', () => {
  const issued = formatTerminalAlert({
    kind: 'fatal',
    line: 'Runtime fatal signal 11',
    session: 'orchestrator',
  });
  const mangled = issued
    .split('\n')
    .map((line) => `  ${line}\r`)
    .join('\r\n');
  expect(classifyTerminalFailure(mangled)).toBeNull();
});

test('REGRESSION round-8-blank-indented-payload: issued frame tolerates blank lines inside payload region', () => {
  const issued = formatTerminalAlert({
    kind: 'fatal',
    line: 'Runtime fatal signal 11',
    session: 'orchestrator',
  }, () => 'issued-blank-indented-payload');
  const mangled = issued
    .split('\n')
    .map((line) => `\t${line}`)
    .join('\n  \n');
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

test.each([
  '← telegram: [internal terminal failure alert] Nonce: 933bbe0b-232d-4ed2…',
  '  ← telegram: [internal terminal failurealert]Nonce:9d8de352-1780-470c…',
  '←telegrm: [internalterminalfailurealert]Nonce:c13aa3a5-d245-49bd…',
] as const)(
  'REGRESSION round-9-live-truncated-quote: watcher vocabulary alone does not classify: %s',
  (line) => {
    expect(classifyTerminalFailure(line)).toBeNull();
  },
);

test('REGRESSION round-9-live-truncated-quote: mixed TUI quote chunk does not classify', () => {
  const chunk = [
    '────────────────────',
    '⠋ Working',
    '← telegram: [internal terminal failure alert] Nonce: 933bbe0b-232d-4ed2…',
    '❯ Press up to edit queued messages',
    '  ← telegram: [internal terminal failurealert]Nonce:9d8de352-1780-470c…',
    '←telegrm: [internalterminalfailurealert]Nonce:c13aa3a5-d245-49bd…',
    '────────────────────',
  ].join('\n');
  expect(classifyTerminalFailure(chunk)).toBeNull();
});

test('REGRESSION round-9-live-truncated-quote: adjacent genuine failure still classifies', () => {
  const chunk =
    '← telegram: [internal terminal failure alert] Nonce: 933bbe0b-232d-4ed2…' +
    '\nWorker exited unexpectedly';
  expect(classifyTerminalFailure(chunk)).toBe('exited');
});

test.each([
  'usage-limit',
  '429/overload',
  'auth',
  'stalled',
  'failed',
  'exited',
  'network',
  'fatal',
  'unknown',
] as const)(
  'REGRESSION round-10-emitted-vocabulary: %s frame headers and every quoted prefix are classifier-inert',
  (kind) => {
    const issuedNonce = 'round-10-issued';
    const frame = formatTerminalAlert(
      { kind, line: 'diagnostic detail', session: 'orchestrator' },
      () => issuedNonce,
    );
    const unsuppressed = frame.replace(issuedNonce, 'round-10-unissued');

    expect(classifyTerminalFailure(unsuppressed)).toBeNull();
    for (const line of frame.split('\n')) {
      if (line.startsWith('[internal terminal failure payload] ')) continue;
      expect(classifyTerminalFailure(line)).toBeNull();
      for (let end = 0; end <= line.length; end += 1) {
        expect(classifyTerminalFailure(`← telegram: ${line.slice(0, end)}`)).toBeNull();
      }
    }
  },
);

test('REGRESSION round-10-residual: a quote truncated inside verbatim payload remains actionable', () => {
  const frame = formatTerminalAlert(
    {
      kind: 'fatal',
      line: 'Runtime fatal signal 11',
      session: 'orchestrator',
    },
    () => 'round-10-payload-residual',
  );
  const truncatedInsidePayload = frame.slice(
    0,
    frame.indexOf('\n[/internal terminal failure alert]'),
  );
  expect(classifyTerminalFailure(`← telegram: ${truncatedInsidePayload}`)).toBe(
    'fatal',
  );
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
  expect(classifyTerminalFailure('Agent crashed in an unknown state')).toBe(
    'unknown',
  );
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
    'Nonce: format-test-nonce\nType: n·etwork\nSession: orchestrator\n\n' +
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


test('REGRESSION terminal-alert-loop-backstop: emission is rate-capped so a mangled echo cannot self-amplify', () => {
  const limiter = new AlertRateLimiter();
  let t = 1_000_000;
  // Burst of 5 alert-worthy frames inside one window: only the first 3 relay.
  const verdicts = Array.from({ length: 5 }, () => limiter.allow(t));
  expect(verdicts).toEqual([true, true, true, false, false]);
  // Cooldown holds even a minute later (past the burst window, inside cooldown).
  expect(limiter.allow(t + 90_000)).toBe(false);
  // After the full cooldown the limiter recovers and admits again.
  expect(limiter.allow(t + 6 * 60_000)).toBe(true);
});

test('REGRESSION terminal-alert-loop-backstop: a slow trickle of real failures is never throttled', () => {
  const limiter = new AlertRateLimiter();
  let t = 2_000_000;
  // One alert every 30s stays under 3-per-60s forever.
  for (let i = 0; i < 20; i += 1) {
    expect(limiter.allow(t)).toBe(true);
    t += 30_000;
  }
});
