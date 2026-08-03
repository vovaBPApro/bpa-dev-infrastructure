import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export type QuotaWindow =
  | { state: 'known'; usedPercent: number }
  | { state: 'unknown'; reason: string };

export type VendorQuota = {
  codex: { fiveHour: QuotaWindow; sevenDay: QuotaWindow; observedAt: number | null };
  claude: { state: 'unknown'; reason: string };
};

type RateLimitWindow = {
  observedAt: number;
  usedPercent: number;
};

const unknown = (reason: string): QuotaWindow => ({ state: 'unknown', reason });

export function parseCodexQuotaJsonl(contents: readonly string[]): VendorQuota['codex'] {
  const latestByMinutes = new Map<number, RateLimitWindow>();
  for (const content of contents) {
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, any>;
        const observedAt = Date.parse(event.timestamp);
        const rateLimits = event?.payload?.rate_limits;
        if (
          event.type === 'event_msg' &&
          event?.payload?.type === 'token_count' &&
          rateLimits &&
          typeof rateLimits === 'object' &&
          Number.isFinite(observedAt)
        ) {
          for (const value of [rateLimits.primary, rateLimits.secondary]) {
            if (!value || typeof value !== 'object') continue;
            const window = value as Record<string, unknown>;
            if (
              typeof window.window_minutes !== 'number' ||
              typeof window.used_percent !== 'number'
            ) continue;
            const previous = latestByMinutes.get(window.window_minutes);
            if (!previous || observedAt > previous.observedAt) {
              latestByMinutes.set(window.window_minutes, {
                observedAt,
                usedPercent: window.used_percent,
              });
            }
          }
        }
      } catch {
        // A partially written JSONL tail is not a quota observation.
      }
    }
  }

  if (latestByMinutes.size === 0) {
    const reason = 'немає локального rate_limits';
    return { fiveHour: unknown(reason), sevenDay: unknown(reason), observedAt: null };
  }

  const window = (minutes: number, label: string): QuotaWindow => {
    const value = latestByMinutes.get(minutes);
    return value
      ? { state: 'known', usedPercent: value.usedPercent }
      : unknown(`немає вікна ${label}`);
  };

  const observedTimes = [latestByMinutes.get(300), latestByMinutes.get(10080)]
    .filter((value): value is RateLimitWindow => value !== undefined)
    .map((value) => value.observedAt);

  return {
    fiveHour: window(300, '5h'),
    sevenDay: window(10080, '7d'),
    // Label the oldest displayed value so a fresh window cannot disguise a stale one.
    observedAt: observedTimes.length ? Math.min(...observedTimes) : null,
  };
}

function collectRecentJsonl(root: string, cutoff: number, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) collectRecentJsonl(path, cutoff, out, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        if (statSync(path).mtimeMs >= cutoff) out.push(readFileSync(path, 'utf8'));
      } catch {
        // The CLI may rotate a session while /status reads it.
      }
    }
  }
}

export function readVendorQuota(home: string, now = Date.now()): VendorQuota {
  const codexJsonl: string[] = [];
  collectRecentJsonl(join(home, '.codex', 'sessions'), now - 14 * 24 * 60 * 60 * 1000, codexJsonl);
  return {
    codex: parseCodexQuotaJsonl(codexJsonl),
    claude: {
      state: 'unknown',
      reason: 'Claude CLI не надає квоту локально',
    },
  };
}

function formatWindow(window: QuotaWindow): string {
  return window.state === 'known' ? `${window.usedPercent}%` : `невідомо (${window.reason})`;
}

function formatAge(observedAt: number | null, now: number): string {
  if (observedAt === null) return '';
  const minutes = Math.max(0, Math.floor((now - observedAt) / 60_000));
  return `, вік ${minutes < 60 ? `${minutes}хв` : `${Math.floor(minutes / 60)}г`}`;
}

export function formatVendorQuota(quota: VendorQuota, now = Date.now()): string {
  return `Квота: Codex 5h ${formatWindow(quota.codex.fiveHour)}, 7d ${formatWindow(quota.codex.sevenDay)}${formatAge(quota.codex.observedAt, now)}; Claude невідомо (${quota.claude.reason})`;
}
