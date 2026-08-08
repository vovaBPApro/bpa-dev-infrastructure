import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8');

function between(start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `missing production seam: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing production seam after ${start}: ${end}`).toBeGreaterThan(
    startAt,
  );
  return source.slice(startAt, endAt);
}

test('both production tmux-paste paths gate Codex relay startup on their actual result', () => {
  const calls = source.match(/startCodexRelayAfterPaste\s*\(/g) ?? [];
  expect(calls).toHaveLength(2);

  const buffered = between(
    'async function flushBufferedMessagesToTmux()',
    'async function launchProvider(',
  );
  expect(buffered).toMatch(
    /const ok = await tmuxPasteText\([\s\S]*?startCodexRelayAfterPaste\(\s*currentBinding\(\)\?\.provider,\s*ok,\s*msg\.meta\.chat_id,/,
  );

  const inbound = between('async function handleInbound(', "bot.on('message:text'");
  expect(inbound).toMatch(
    /const ok = await tmuxPasteText\(wrapped\);[\s\S]*?if \(ok\) \{\s*startCodexRelayAfterPaste\(\s*currentBinding\(\)\?\.provider,\s*ok,\s*chat_id,/,
  );
});

test('pending registration cannot claim delivery and watchdog skips only a live owner', () => {
  const registration = between(
    'function markPendingInbound(',
    'function markReplied(',
  );
  expect(registration).not.toContain('startCodexFastRelay');
  expect(registration).not.toContain('startCodexRelayAfterPaste');

  const watchdog = between(
    'async function watchdogTick()',
    'setInterval(() =>',
  );
  expect(watchdog).toContain(
    "if (binding.provider === 'codex' && p.fast_relay_started) continue;",
  );
});

test('turn-end ingestion fences both accepted suppress and deliver outcomes', () => {
  const ingest = between(
    'async function ingestTurnEndRelay(',
    'function deliverOrBuffer(',
  );
  expect(ingest.match(/fenceAcceptedTerminalPending\s*\(/g) ?? []).toHaveLength(2);
  expect(ingest).toMatch(
    /if \(decision\.action === 'suppress'\) \{\s*fenceAcceptedTerminalPending\(/,
  );
  expect(ingest).toMatch(
    /persistTurnDeliveries\(\);\s*fenceAcceptedTerminalPending\(/,
  );
});
