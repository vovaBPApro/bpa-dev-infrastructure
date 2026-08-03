import { expect, test } from 'bun:test';
import {
  formatVendorQuota,
  parseCodexQuotaJsonl,
  readVendorQuota,
  type VendorQuota,
  type VendorQuotaFs,
} from './vendor-quota';

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

const fakeFs = (mode: 'permission' | 'missing' | 'absent-cli'): VendorQuotaFs => ({
  readdirSync: () => {
    const error = new Error(mode) as NodeJS.ErrnoException;
    error.code = mode === 'permission' ? 'EACCES' : 'ENOENT';
    throw error;
  },
  readFileSync: () => '',
  statSync: () => ({ mtimeMs: 0 }),
});

for (const mode of ['permission', 'missing', 'absent-cli'] as const) {
  test(`REGRESSION ML-6: ${mode} source crosses read/parse boundary as unknown`, () => {
    const rendered = formatVendorQuota(readVendorQuota('/fixture', 0, fakeFs(mode)), 0);
    expect(rendered).toContain('Codex 5h невідомо');
    expect(rendered).toContain('7d невідомо');
    expect(rendered).not.toMatch(/Codex 5h \d/);
  });
}

test('REGRESSION ML-6: shifted event format and missing timestamp are rejected', () => {
  const shifted = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-04T10:00:00Z',
    payload: { type: 'token_count', rateLimits: { primary: { used_percent: 55, window_minutes: 300 } } },
  });
  const missingTimestamp = event('', {
    primary: { used_percent: 55, window_minutes: 300 },
  });
  for (const line of [shifted, missingTimestamp]) {
    expect(parseCodexQuotaJsonl([line]).fiveHour.state).toBe('unknown');
  }
});

test('REGRESSION ML-6: invalid percentage values never render as numbers', () => {
  const values: unknown[] = [-7, 140, Number.NaN, Number.POSITIVE_INFINITY, '55'];
  for (const value of values) {
    const codex = parseCodexQuotaJsonl([
      event('2026-08-04T10:00:00Z', {
        primary: { used_percent: value, window_minutes: 300 },
      }),
    ]);
    const rendered = formatVendorQuota({
      codex,
      claude: { state: 'unknown', reason: 'локально недоступно' },
    });
    expect(rendered).toContain('Codex 5h невідомо');
    expect(rendered).not.toContain(`${String(value)}%`);
  }

  const malformedTypedQuota: VendorQuota = {
    codex: {
      fiveHour: { state: 'known', usedPercent: Number.NaN },
      sevenDay: { state: 'known', usedPercent: Number.POSITIVE_INFINITY },
      observedAt: null,
    },
    claude: { state: 'unknown', reason: 'локально недоступно' },
  };
  expect(formatVendorQuota(malformedTypedQuota)).not.toMatch(/(?:NaN|Infinity)%/);
});

test('REGRESSION ML-6: missing, future, hour-old, and day-old timestamps stay honest', () => {
  const now = Date.parse('2026-08-04T11:00:00Z');
  const quota = (observedAt: number | null): VendorQuota => ({
    codex: {
      fiveHour: { state: 'known', usedPercent: 55 },
      sevenDay: { state: 'known', usedPercent: 88 },
      observedAt,
    },
    claude: { state: 'unknown', reason: 'локально недоступно' },
  });
  expect(formatVendorQuota(quota(null), now)).not.toContain('вік');
  const future = formatVendorQuota(quota(now + 60_000), now);
  expect(future).toContain('час спостереження недійсний');
  expect(future).not.toContain('вік 0хв');
  expect(formatVendorQuota(quota(now - 60 * 60_000), now)).toContain('вік 1г');
  expect(formatVendorQuota(quota(now - 24 * 60 * 60_000), now)).toContain('вік 24г');
});

test('REGRESSION HR-302: long unknown reasons use a bounded whole-message fallback', () => {
  const reason = `початок ${'x'.repeat(700)} кінець`;
  const rendered = formatVendorQuota({
    codex: {
      fiveHour: { state: 'unknown', reason },
      sevenDay: { state: 'unknown', reason },
      observedAt: null,
    },
    claude: { state: 'unknown', reason },
  });
  expect(rendered.length).toBeLessThanOrEqual(600);
  expect(rendered).toBe('Квота: Codex 5h невідомо, 7d невідомо; Claude невідомо');
});
