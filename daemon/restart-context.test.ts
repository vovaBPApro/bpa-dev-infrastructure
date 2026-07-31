import { describe, expect, test } from 'bun:test';
import {
  RESTART_CONTEXT_MAX_CHARS,
  RESTART_CONTEXT_MAX_MESSAGES,
  buildRestartContext,
} from './restart-context';

const now = Date.parse('2026-07-31T12:00:00.000Z');
const row = (msg_id: number, ts: string, text: string, chat_id = 7) =>
  JSON.stringify({ msg_id, chat_id, ts, text });

describe('restart chat context regression lock (ML-14)', () => {
  test('newest instruction is active and superseded intent stays visible', () => {
    const result = buildRestartContext(
      [
        row(10, '2026-07-31T05:00:00.000Z', 'deploy the old plan'),
        row(11, '2026-07-31T11:00:00.000Z', 'stop deployment; audit only'),
      ].join('\n'),
      now,
    )!;
    expect(result.content).toContain('[SUPERSEDED msg_id=10');
    expect(result.content).toContain('deploy the old plan');
    expect(result.content).toContain('[ACTIVE msg_id=11');
    expect(result.content).toContain('stop deployment; audit only');
  });

  test('excludes stale and future rows and tolerates a damaged append', () => {
    const result = buildRestartContext(
      [
        row(1, '2026-07-30T23:59:59.000Z', 'stale'),
        '{broken',
        row(2, '2026-07-31T10:00:00.000Z', 'current'),
        row(3, '2026-07-31T12:00:01.000Z', 'future'),
      ].join('\n'),
      now,
    )!;
    expect(result.content).toContain('current');
    expect(result.content).not.toContain('stale');
    expect(result.content).not.toContain('future');
  });

  test('bounds both message count and injected characters', () => {
    const lines = Array.from({ length: 100 }, (_, index) =>
      row(index, `2026-07-31T11:${String(index % 60).padStart(2, '0')}:00.000Z`, 'x'.repeat(1000)),
    );
    const result = buildRestartContext(lines.join('\n'), now)!;
    expect(result.messageCount).toBe(RESTART_CONTEXT_MAX_MESSAGES);
    expect(result.content.length).toBeLessThanOrEqual(RESTART_CONTEXT_MAX_CHARS);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('OLDER CONTEXT OMITTED');
  });
});
