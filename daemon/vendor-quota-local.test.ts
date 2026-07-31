import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatLocalVendorQuota, parseClaudeQuotaJsonl, parseCodexQuotaJsonl, readLocalVendorQuota } from './vendor-quota-local';

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

test('REGRESSION ML-6: local snapshot exposes Claude weekly/credits and re-login warning', () => {
  const snapshot = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-07-31T12:00:00Z',
    payload: {
      type: 'vendor_quota_snapshot',
      vendor_quotas: {
        claude: {
          weeklyUsedPercent: 61,
          creditsLabel: '$17.00',
          loginState: 'relogin-needed',
        },
      },
    },
  });
  const claude = parseClaudeQuotaJsonl([snapshot]);
  expect(claude.claudeLogin).toBe('relogin-needed');
  expect(claude.claudeWeekly).toEqual({ state: 'known', usedPercent: 61, resetsAt: null });
  expect(claude.claudeCredits).toBe('$17.00');
  const lines = formatLocalVendorQuota({
    ...parseCodexQuotaJsonl([]),
    ...claude,
  });
  expect(lines.join('\n')).toContain('сесія протермінована — треба перелогінитись');
  expect(lines.join('\n')).toContain('weekly=61% used, credits=$17.00');
});

test('Claude fields are unknown with a concrete reason when no local snapshot exists', () => {
  const claude = parseClaudeQuotaJsonl([]);
  expect(claude.claudeWeekly).toEqual({ state: 'unknown', reason: 'no local Claude vendor_quota_snapshot event' });
  expect(claude.claudeCredits).toBeNull();
  expect(claude.claudeLogin).toBe('unknown');
});

test('the reader consumes only the local quota snapshot path, with no browser or API dependency', () => {
  const home = mkdtempSync(join(tmpdir(), 'ml6-local-quota-'));
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'quota-latest.jsonl'), JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: {
        type: 'vendor_quota_snapshot',
        vendor_quotas: { claude: { weeklyUsedPercent: 44, creditsLabel: '12 left', loginState: 'authenticated' } },
      },
    }));

    const quota = readLocalVendorQuota(home);
    expect(quota.claudeWeekly).toEqual({ state: 'known', usedPercent: 44, resetsAt: null });
    expect(quota.claudeCredits).toBe('12 left');
    expect(quota.claudeLogin).toBe('authenticated');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
