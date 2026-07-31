import { expect, test } from 'bun:test';
import { formatLocalVendorQuota, parseClaudeQuotaJsonl, parseCodexQuotaJsonl } from './vendor-quota-local';

const event = (timestamp: string, rate_limits: unknown) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits } });

test('REGRESSION ML-6: local Codex JSONL exposes merged 5h/7d totals without a browser', () => {
  const parsed = parseCodexQuotaJsonl([
    event('2026-07-31T10:00:00Z', { primary: { used_percent: 99, window_minutes: 300 } }),
    event('2026-07-31T12:00:00Z', {
      primary: { used_percent: 14, window_minutes: 10080, resets_at: 1785917815 },
      secondary: { used_percent: 23, window_minutes: 300, resets_at: 1785400000 },
      credits: { balance: '0' },
    }),
  ]);
  expect(parsed.codex5h).toEqual({ state: 'known', usedPercent: 23, resetsAt: 1785400000 });
  expect(parsed.codex7d).toEqual({ state: 'known', usedPercent: 14, resetsAt: 1785917815 });
  expect(parsed.codexCredits).toBe('0');
});

test('a genuinely absent local window is unknown with a reason, never guessed', () => {
  const parsed = parseCodexQuotaJsonl([event('2026-07-31T12:00:00Z', { primary: { used_percent: 14, window_minutes: 10080 } })]);
  expect(parsed.codex5h).toEqual({ state: 'unknown', reason: '5h window absent from latest local Codex event' });
});

test('Claude local JSONL reports re-login warning but does not invent weekly quota or credits', () => {
  const claude = parseClaudeQuotaJsonl([JSON.stringify({ type: 'assistant', message: { error: 'Session expired; re-login required' } })]);
  expect(claude.claudeLogin).toBe('relogin-needed');
  expect(claude.claudeWeekly.state).toBe('unknown');
  expect(claude.claudeCredits).toBeNull();
  const lines = formatLocalVendorQuota({
    ...parseCodexQuotaJsonl([]),
    ...claude,
  });
  expect(lines.join('\n')).toContain('сесія протермінована — треба перелогінитись');
  expect(lines.join('\n')).toContain('weekly=unknown (Claude local JSONL does not expose subscription weekly usage or credits)');
});
