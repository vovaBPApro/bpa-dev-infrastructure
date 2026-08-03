import { expect, test } from 'bun:test';
import { formatVendorQuota, parseCodexQuotaJsonl, type VendorQuota } from './vendor-quota';

const event = (timestamp: string, rateLimits: unknown) =>
  JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: { type: 'token_count', rate_limits: rateLimits },
  });

test('REGRESSION ML-6: renders real per-provider quota and labels its age', () => {
  const codex = parseCodexQuotaJsonl([
    event('2026-08-04T10:00:00Z', {
      primary: { used_percent: 21, window_minutes: 300 },
      secondary: { used_percent: 64, window_minutes: 10080 },
    }),
  ]);
  const quota: VendorQuota = {
    codex,
    claude: { state: 'unknown', reason: 'Claude CLI не надає квоту локально' },
  };
  expect(formatVendorQuota(quota, Date.parse('2026-08-04T10:17:00Z'))).toBe(
    'Квота: Codex 5h 21%, 7d 64%, вік 17хв; Claude невідомо (Claude CLI не надає квоту локально)',
  );
});

test('REGRESSION ML-6: unavailable source is unknown and never zero', () => {
  const quota: VendorQuota = {
    codex: parseCodexQuotaJsonl(['not-json']),
    claude: { state: 'unknown', reason: 'джерело недоступне' },
  };
  const rendered = formatVendorQuota(quota, 0);
  expect(rendered).toContain('Codex 5h невідомо');
  expect(rendered).toContain('Claude невідомо (джерело недоступне)');
  expect(rendered).not.toContain('0%');
});

test('latest observation per window wins without hiding a missing window', () => {
  const codex = parseCodexQuotaJsonl([
    event('2026-08-04T09:00:00Z', {
      primary: { used_percent: 90, window_minutes: 300 },
    }),
    event('2026-08-04T10:00:00Z', {
      primary: { used_percent: 37, window_minutes: 10080 },
    }),
  ]);
  expect(codex.fiveHour).toEqual({ state: 'known', usedPercent: 90 });
  expect(codex.sevenDay).toEqual({ state: 'known', usedPercent: 37 });
});
