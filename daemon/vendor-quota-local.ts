import { closeSync, openSync, readSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export const LOCAL_QUOTA_MAX_FILES = 64;
export const LOCAL_QUOTA_MAX_BYTES_PER_FILE = 1024 * 1024;
const LOCAL_QUOTA_FRESHNESS_MS = 30 * 60 * 1000;
const LOCAL_QUOTA_FUTURE_SKEW_MS = 2 * 60 * 1000;

export type QuotaField =
  | { state: 'known'; usedPercent: number; resetsAt: number | null }
  | { state: 'unknown'; reason: string };

export type LocalVendorQuota = {
  codex5h: QuotaField;
  codex7d: QuotaField;
  codexCredits: string | null;
  claudeWeekly: QuotaField;
  claudeCredits: string | null;
  claudeLogin: 'authenticated' | 'relogin-needed' | 'unknown';
  claudeReason: string;
};

const unknown = (reason: string): QuotaField => ({ state: 'unknown', reason });

type Candidate = { timestamp: number; limits: Record<string, unknown> };

export function parseCodexQuotaJsonl(contents: readonly string[]): Pick<LocalVendorQuota, 'codex5h' | 'codex7d' | 'codexCredits'> {
  let latest: Candidate | null = null;
  for (const content of contents) {
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, any>;
        const limits = event?.payload?.rate_limits;
        const timestamp = Date.parse(event?.timestamp);
        if (event?.type === 'event_msg' && event?.payload?.type === 'token_count' && limits && Number.isFinite(timestamp) && (!latest || timestamp > latest.timestamp)) {
          latest = { timestamp, limits };
        }
      } catch { /* a torn JSONL tail is not a reading */ }
    }
  }
  if (!latest) {
    const reason = 'no local Codex token_count event with rate_limits';
    return { codex5h: unknown(reason), codex7d: unknown(reason), codexCredits: null };
  }
  const windows = [latest.limits.primary, latest.limits.secondary]
    .filter((v): v is Record<string, unknown> => Boolean(v && typeof v === 'object'));
  const window = (minutes: number, label: string): QuotaField => {
    const value = windows.find((v) => v.window_minutes === minutes);
    return value && typeof value.used_percent === 'number'
      ? { state: 'known', usedPercent: value.used_percent, resetsAt: typeof value.resets_at === 'number' ? value.resets_at : null }
      : unknown(`${label} window absent from latest local Codex event`);
  };
  const credits = latest.limits.credits as Record<string, unknown> | undefined;
  return {
    codex5h: window(300, '5h'),
    codex7d: window(10080, '7d'),
    codexCredits: typeof credits?.balance === 'string' ? credits.balance : null,
  };
}

export function parseClaudeQuotaJsonl(contents: readonly string[], now = Date.now()): Pick<LocalVendorQuota, 'claudeWeekly' | 'claudeCredits' | 'claudeLogin' | 'claudeReason'> {
  let latestAuthFailureAt = Number.NEGATIVE_INFINITY;
  let latest: { timestamp: number; quota: Record<string, unknown> } | null = null;
  for (const content of contents) {
    for (const line of content.split('\n')) {
      try {
        const event = JSON.parse(line) as Record<string, any>;
        const error = event?.message?.error ?? event?.error;
        const eventAt = Date.parse(event?.timestamp);
        if (
          typeof error === 'string' &&
          /session expired|re-?login|unauthorized|authentication.+(?:expired|failed)/i.test(error)
        ) latestAuthFailureAt = Number.isFinite(eventAt) ? Math.max(latestAuthFailureAt, eventAt) : Number.POSITIVE_INFINITY;
        const quota = event?.payload?.vendor_quotas?.claude;
        const timestamp = Date.parse(event?.timestamp);
        if (
          event?.type === 'event_msg' &&
          event?.payload?.type === 'vendor_quota_snapshot' &&
          quota &&
          typeof quota === 'object' &&
          Number.isFinite(timestamp) &&
          (!latest || timestamp > latest.timestamp)
        ) {
          latest = { timestamp, quota };
        }
      } catch { /* ignore malformed records */ }
    }
  }
  const weekly = latest?.quota.weeklyUsedPercent;
  const credits = latest?.quota.creditsLabel;
  const loginState = latest?.quota.loginState;
  const noSnapshot = 'no local Claude vendor_quota_snapshot event';
  const required = ['creditsLabel', 'fableUsedPercent', 'fetchedAt', 'loginState', 'sessionUsedPercent', 'weeklyUsedPercent'];
  const complete = Boolean(latest && required.every((key) => key in latest.quota));
  const fetchedAtRaw = latest?.quota.fetchedAt;
  const fetchedAt = typeof fetchedAtRaw === 'string' ? Date.parse(fetchedAtRaw) : Number.NaN;
  const fresh = Boolean(
    latest &&
    complete &&
    Number.isFinite(fetchedAt) &&
    fetchedAt <= now + LOCAL_QUOTA_FUTURE_SKEW_MS &&
    now - fetchedAt <= LOCAL_QUOTA_FRESHNESS_MS,
  );
  const authFailure = loginState === 'relogin-needed' || latestAuthFailureAt > (latest?.timestamp ?? Number.NEGATIVE_INFINITY);
  const unavailable = !latest
    ? noSnapshot
    : !complete
      ? 'latest local Claude snapshot is partial'
      : !Number.isFinite(fetchedAt)
        ? 'latest local Claude snapshot has no valid fetchedAt'
        : fetchedAt > now + LOCAL_QUOTA_FUTURE_SKEW_MS
          ? 'latest local Claude snapshot is future-dated'
          : now - fetchedAt > LOCAL_QUOTA_FRESHNESS_MS
            ? 'latest local Claude snapshot is stale'
            : 'field absent from latest local Claude snapshot';
  return {
    claudeWeekly: fresh && typeof weekly === 'number'
      ? { state: 'known', usedPercent: weekly, resetsAt: null }
      : unknown(unavailable),
    claudeCredits: fresh && typeof credits === 'string' && credits.trim() ? credits.trim() : null,
    claudeLogin: authFailure
      ? 'relogin-needed'
      : fresh && loginState === 'authenticated'
        ? 'authenticated'
        : 'unknown',
    claudeReason: authFailure
      ? 'local Claude JSONL contains an authentication-expired reading'
      : fresh && latest
        ? 'latest fresh local Claude snapshot reports authenticated'
        : unavailable,
  };
}

type RecentCandidate = { path: string; mtimeMs: number };

function recentJsonl(root: string, cutoff: number, out: RecentCandidate[], depth = 0): void {
  if (depth > 6) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) recentJsonl(path, cutoff, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const mtimeMs = statSync(path).mtimeMs;
        if (mtimeMs >= cutoff) out.push({ path, mtimeMs });
      } catch { /* raced with session cleanup */ }
    }
  }
}

function recentFile(path: string, cutoff: number, out: RecentCandidate[]): void {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (mtimeMs >= cutoff) out.push({ path, mtimeMs });
  } catch { /* optional local state, or raced with replacement */ }
}

function readBounded(candidates: RecentCandidate[]): string[] {
  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LOCAL_QUOTA_MAX_FILES)
    .flatMap(({ path }) => {
      let fd: number | null = null;
      try {
        const size = statSync(path).size;
        const length = Math.min(size, LOCAL_QUOTA_MAX_BYTES_PER_FILE);
        const buffer = Buffer.alloc(length);
        fd = openSync(path, 'r');
        readSync(fd, buffer, 0, length, Math.max(0, size - length));
        return [buffer.toString('utf8')];
      } catch { return []; }
      finally { if (fd !== null) closeSync(fd); }
    });
}

export function readLocalVendorQuota(home: string, now = Date.now()): LocalVendorQuota {
  const codexCandidates: RecentCandidate[] = [];
  const claudeCandidates: RecentCandidate[] = [];
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;
  recentJsonl(join(home, '.codex', 'sessions'), cutoff, codexCandidates);
  recentFile(join(home, '.codex', 'quota-latest.jsonl'), cutoff, claudeCandidates);
  recentJsonl(join(home, '.claude', 'projects'), cutoff, claudeCandidates);
  return {
    ...parseCodexQuotaJsonl(readBounded(codexCandidates)),
    ...parseClaudeQuotaJsonl(readBounded(claudeCandidates), now),
  };
}

function field(label: string, value: QuotaField): string {
  return value.state === 'known' ? `${label}=${value.usedPercent}% used` : `${label}=unknown (${value.reason})`;
}

export function formatLocalVendorQuota(quota: LocalVendorQuota): string[] {
  return [
    `vendor_quota_codex: ${field('5h', quota.codex5h)}, ${field('7d', quota.codex7d)}, credits=${quota.codexCredits ?? 'unknown (not present locally)'}`,
    `vendor_quota_claude: weekly=${quota.claudeWeekly.state === 'known' ? `${quota.claudeWeekly.usedPercent}% used` : `unknown (${quota.claudeWeekly.reason})`}, credits=${quota.claudeCredits ?? 'unknown (not exposed locally)'}, login=${quota.claudeLogin}${quota.claudeLogin === 'relogin-needed' ? ' — сесія протермінована — треба перелогінитись' : ` (${quota.claudeReason})`}`,
  ];
}
