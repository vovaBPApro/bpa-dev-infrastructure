import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LOCAL_QUOTA_MAX_BYTES_PER_FILE, formatLocalVendorQuota, parseClaudeQuotaJsonl, parseCodexQuotaJsonl, readLocalVendorQuota } from './vendor-quota-local';

const event = (timestamp: string, rate_limits: unknown) => JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', rate_limits } });
const NOW = Date.parse('2026-07-31T12:05:00Z');
const claudeQuota = (over: Record<string, unknown> = {}) => ({
  creditsLabel: '$17.00',
  fableUsedPercent: null,
  fetchedAt: '2026-07-31T12:00:00Z',
  loginState: 'authenticated',
  sessionUsedPercent: 10,
  weeklyUsedPercent: 61,
  ...over,
});
const claudeSnapshot = (quota: Record<string, unknown>, timestamp = '2026-07-31T12:00:00Z') => JSON.stringify({
  type: 'event_msg', timestamp, payload: { type: 'vendor_quota_snapshot', vendor_quotas: { claude: quota } },
});

test('REGRESSION ML-6: local Codex JSONL exposes merged 5h/7d totals without a browser', () => {
  const parsed = parseCodexQuotaJsonl([
    event('2026-07-31T10:00:00Z', { primary: { used_percent: 99, window_minutes: 300 } }),
    event('2026-07-31T12:00:00Z', {
      primary: { used_percent: 14, window_minutes: 10080, resets_at: Math.floor(NOW / 1000) + 604800 },
      secondary: { used_percent: 23, window_minutes: 300, resets_at: Math.floor(NOW / 1000) + 18000 },
      credits: { balance: '0' },
    }),
  ], NOW);
  expect(parsed.codex5h).toEqual({ state: 'known', usedPercent: 23, resetsAt: Math.floor(NOW / 1000) + 18000 });
  expect(parsed.codex7d).toEqual({ state: 'known', usedPercent: 14, resetsAt: Math.floor(NOW / 1000) + 604800 });
  expect(parsed.codexCredits).toBe('0');
});

test('a genuinely absent local window is unknown with a reason, never guessed', () => {
  const parsed = parseCodexQuotaJsonl([event('2026-07-31T12:00:00Z', { primary: { used_percent: 14, window_minutes: 10080 } })], NOW);
  expect(parsed.codex5h).toEqual({ state: 'unknown', reason: '5h window absent from latest local Codex event' });
});

test('REGRESSION ML-6: local snapshot exposes Claude weekly/credits and re-login warning', () => {
  const snapshot = claudeSnapshot(claudeQuota({ loginState: 'relogin-needed' }));
  const claude = parseClaudeQuotaJsonl([snapshot], NOW);
  expect(claude.claudeLogin).toBe('relogin-needed');
  expect(claude.claudeWeekly).toEqual({ state: 'known', usedPercent: 61, resetsAt: null });
  expect(claude.claudeCredits).toBe('$17.00');
  const lines = formatLocalVendorQuota({
    ...parseCodexQuotaJsonl([], NOW),
    ...claude,
  });
  expect(lines.join('\n')).toContain('сесія протермінована — треба перелогінитись');
  expect(lines.join('\n')).toContain('weekly=61% used, credits=$17.00');
});

test('Claude fields are unknown with a concrete reason when no local snapshot exists', () => {
  const claude = parseClaudeQuotaJsonl([], NOW);
  expect(claude.claudeWeekly).toEqual({ state: 'unknown', reason: 'no local Claude vendor_quota_snapshot event' });
  expect(claude.claudeCredits).toBeNull();
  expect(claude.claudeLogin).toBe('unknown');
});

test('a newer authenticated snapshot clears an older session-expired error', () => {
  const expired = JSON.stringify({ timestamp: '2026-07-31T11:00:00Z', error: 'Session expired; re-login required' });
  const claude = parseClaudeQuotaJsonl([expired, claudeSnapshot(claudeQuota())], NOW);
  expect(claude.claudeLogin).toBe('authenticated');
});

test('snapshot envelope time cannot hide an auth error newer than fetchedAt', () => {
  const expired = JSON.stringify({ timestamp: '2026-07-31T12:01:00Z', error: 'Session expired' });
  const snapshot = claudeSnapshot(claudeQuota(), '2026-07-31T12:02:00Z');
  expect(parseClaudeQuotaJsonl([expired, snapshot], NOW).claudeLogin).toBe('relogin-needed');
});

test('stale, future, and reset Codex windows are unknown with reasons', () => {
  const cases = [
    { line: event('2026-07-31T10:00:00Z', { primary: { used_percent: 10, window_minutes: 300 } }), reason: 'stale' },
    { line: event('2099-01-01T00:00:00Z', { primary: { used_percent: 10, window_minutes: 300 } }), reason: 'future-dated' },
    { line: event('2026-07-31T12:00:00Z', { primary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(NOW / 1000) - 1 } }), reason: 'already reset' },
  ];
  for (const { line, reason } of cases) {
    const parsed = parseCodexQuotaJsonl([line], NOW);
    expect(parsed.codex5h.state).toBe('unknown');
    if (parsed.codex5h.state === 'unknown') expect(parsed.codex5h.reason).toContain(reason);
  }
});

test('stale, future, and partial snapshots never report known quota or authenticated', () => {
  const cases = [
    claudeSnapshot(claudeQuota({ fetchedAt: '2026-07-31T10:00:00Z' }), '2026-07-31T10:00:00Z'),
    claudeSnapshot(claudeQuota({ fetchedAt: '2099-01-01T00:00:00Z' }), '2099-01-01T00:00:00Z'),
    claudeSnapshot({ loginState: 'authenticated', weeklyUsedPercent: 61 }),
  ];
  for (const snapshot of cases) {
    const claude = parseClaudeQuotaJsonl([snapshot], NOW);
    expect(claude.claudeWeekly.state).toBe('unknown');
    expect(claude.claudeCredits).toBeNull();
    expect(claude.claudeLogin).toBe('unknown');
    expect(claude.claudeReason).toMatch(/stale|future-dated|partial/);
  }
});

test('the reader consumes only the local quota snapshot path, with no browser or API dependency', () => {
  const home = mkdtempSync(join(tmpdir(), 'ml6-local-quota-'));
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const now = Date.now();
    const snapshot = claudeSnapshot(claudeQuota({
      weeklyUsedPercent: 44,
      creditsLabel: '12 left',
      fetchedAt: new Date(now).toISOString(),
    }), new Date(now).toISOString());
    writeFileSync(
      join(home, '.codex', 'quota-latest.jsonl'),
      `${'discarded-prefix\n'.repeat(Math.ceil(LOCAL_QUOTA_MAX_BYTES_PER_FILE / 17))}${snapshot}\n`,
    );

    const quota = readLocalVendorQuota(home, now);
    expect(quota.claudeWeekly).toEqual({ state: 'known', usedPercent: 44, resetsAt: null });
    expect(quota.claudeCredits).toBe('12 left');
    expect(quota.claudeLogin).toBe('authenticated');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
