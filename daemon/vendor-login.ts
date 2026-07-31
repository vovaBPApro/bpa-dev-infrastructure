// Vendor re-login detection for /status.
//
// WHY THIS EXISTS
// The parity audit against the old daemon found this the single highest-impact
// loss of the migration. The live system detected an expired vendor login and
// rendered «сесія протермінована — треба перелогінитись» in /status. After the
// migration the field was simply gone, so an expired Codex or Claude login
// presented as a generic stall: every dispatched lane failed, quota read as
// unavailable, and nothing said why. A whole-fleet outage with no diagnostic.
//
// WHAT WAS PORTED, AND FROM WHERE
// Provenance is this repository's own history, commit ffe05409:
//   tools/claude-telegram-daemon/vendor-quota-scraper.ts   (types, event shape)
//   tools/claude-telegram-daemon/status-collector.ts       (the reader half)
// The history copy of vendor-quota-scraper.ts is byte-identical to the live
// copy in /root/orch-mailbox/live-daemon-src (md5 1a3a034df22e5ea3b745a69e6545
// 1cd6), so the history version is current and no divergence had to be
// reconciled.
//
// Ported here: the local quota-latest.jsonl reading and parsing path — snapshot
// selection (last parseable line wins), the vendor-quota normalisers, the
// login-state read, and both staleness signals.
//
// DELIBERATELY NOT PORTED: the browser half. Live drove headless Playwright
// against the vendor dashboards (runVendorQuotaScraper, scrapeSingleDashboard,
// resolvePlaywrightRuntime) and matched logged-out HTML (isCodexLoggedOut /
// isClaudeLoggedOut against '/auth/login', 'sign in to…', 'continue with
// google'). That needs a logged-in browser profile, which is a credential
// question, and the operator's standing rule is subscriptions-only with no API
// keys.
//
// Detection still works without it, and this is the load-bearing fact: the
// HTML matchers only ever ran in the PRODUCER. Their result was serialised into
// the snapshot as `vendor_quotas.<vendor>.loginState`, and the /status renderer
// — the thing that actually printed the warning — never touched HTML. It read
// that field. So the consumer half is fully portable; only a producer needs a
// browser.
//
// THE WRITER GAP (state contract)
// This repository has NO producer for quota-latest.jsonl, and that is declared,
// not hidden: see KNOWN_GAPS['quota-latest.jsonl'] in tools/state-contract/
// check.ts. The consequence is designed for rather than papered over — with no
// producer, or a stopped one, every verdict below degrades to `unknown` with a
// reason. That is why the tri-state and the two staleness signals are not
// garnish here; they are the entire correctness story. A stale "authenticated"
// is a false "your login is fine", which is worse than a blank field, because
// it is the field the operator trusts at exactly the moment it matters.
//
// DIVERGENCE FROM LIVE, ON PURPOSE
// Live read `raw.loginState === 'authenticated' ? 'authenticated' :
// 'relogin-needed'`. That binary coercion turns a truncated write or a schema
// change into a re-login alarm the operator cannot act on, and it reports a
// week-old snapshot as current. Both directions are lies. Here an unrecognised
// or unverifiable reading is `unknown`, and an expired reading is `unknown`
// rather than a confident OK.

import { ageFromObservedTimestamp } from './observed-time';

// Basename of the vendor quota snapshot this module parses. Declared in the
// state-contract registry; see the writer-gap note above.
export const VENDOR_QUOTA_SNAPSHOT_BASENAME = 'quota-latest.jsonl';

// Operator-facing token, preserved byte-for-byte from the live daemon
// (status-collector.ts:1336/1602/2236) so the operator recognises the same
// sentence the old system printed. English elsewhere per CLAUDE.md rule 17;
// this string is Human-facing chat output and instance/params.yaml declares
// operator.language: uk.
export const RELOGIN_WARNING = 'сесія протермінована — треба перелогінитись';

// How long a snapshot may describe the present. Beyond this the reading is
// evidence about the past only. The live scrape cadence was driven by a timer
// outside the daemon sources, so this is a stated default rather than a
// recovered constant; callers override it.
export const VENDOR_SNAPSHOT_FRESHNESS_MS = 30 * 60 * 1000;

// How far into the future an observation timestamp may sit before it stops
// being clock skew and becomes an implausible reading. Producer and consumer
// run on the same host today, so this only has to absorb small NTP drift; a
// genuinely future-dated record (the review's 2099 probe) is not evidence and
// must degrade to `unknown`, never authenticate.
export const VENDOR_TIMESTAMP_SKEW_MS = 2 * 60 * 1000;

export type VendorId = 'codex' | 'claude';

// The two vendor payload shapes, from vendor-quota-scraper.ts. `loginState` is
// intentionally widened to `unknown` on read: the file is written by another
// program and its field may be absent, truncated, or renamed.
//
// `complete` records whether the raw object carried every key the producer
// writes (values may be null — the scraper writes nulls for fields it could
// not read, but it always writes the keys). A record missing keys is a
// truncated or foreign write, and its "authenticated" is not accepted; see
// readVendorLogin. The alarm direction is exempt on purpose: an explicit
// relogin-needed still warns even from a partial record, because suppressing
// a true warning is the original failure this module exists to prevent.
export type CodexVendorQuota = {
  complete: boolean;
  creditsLabel: string | null;
  fetchedAt: string | null;
  loginState: VendorLoginState;
  primaryUsedPercent: number | null;
  secondaryUsedPercent: number | null;
  sparkPrimaryUsedPercent: number | null;
  sparkSecondaryUsedPercent: number | null;
};

export type ClaudeVendorQuota = {
  complete: boolean;
  creditsLabel: string | null;
  fableUsedPercent: number | null;
  fetchedAt: string | null;
  loginState: VendorLoginState;
  sessionUsedPercent: number | null;
  weeklyUsedPercent: number | null;
};

export type VendorLoginState = 'authenticated' | 'relogin-needed' | 'unknown';

export type CodexRateLimitWindow = {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
};

export type CodexRateLimits = {
  plan_type?: string;
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
};

export type VendorQuotaSnapshot = {
  capturedAt: string;
  capturedAtMs: number;
  claude: ClaudeVendorQuota | null;
  codex: CodexVendorQuota | null;
  rateLimits: CodexRateLimits | null;
};

// Tri-state, in the shape daemon/status.ts uses: a value, or an explicit
// `unknown` carrying the reason it could not be established.
export type VendorLoginVerdict =
  | {
      vendor: VendorId;
      state: 'authenticated';
      observedAt: string;
      ageMs: number;
    }
  | {
      vendor: VendorId;
      state: 'relogin-needed';
      observedAt: string;
      ageMs: number | null;
      stale: boolean;
    }
  | { vendor: VendorId; state: 'unknown'; reason: string };

// The snapshot file's contents, or the fact that there is no file. Kept as data
// rather than a path so this module opens nothing: the caller that wires it in
// owns the read, and owns declaring that read in the state contract.
export type SnapshotSource =
  | { present: false }
  | { present: true; contents: string };

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// A value we do not recognise is not evidence. Live coerced anything that was
// not 'authenticated' into 'relogin-needed'; that fabricates alarms.
function normalizeLoginState(value: unknown): VendorLoginState {
  if (value === 'authenticated') return 'authenticated';
  if (value === 'relogin-needed') return 'relogin-needed';
  return 'unknown';
}

// Every key the producer writes for each vendor record, from
// vendor-quota-scraper.ts. Key presence (not value truthiness) is the
// completeness test: the scraper writes null values, never absent keys.
const CODEX_RECORD_KEYS = [
  'creditsLabel',
  'fetchedAt',
  'loginState',
  'primaryUsedPercent',
  'secondaryUsedPercent',
  'sparkPrimaryUsedPercent',
  'sparkSecondaryUsedPercent',
] as const;

const CLAUDE_RECORD_KEYS = [
  'creditsLabel',
  'fableUsedPercent',
  'fetchedAt',
  'loginState',
  'sessionUsedPercent',
  'weeklyUsedPercent',
] as const;

function hasAllKeys(
  o: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => key in o);
}

export function normalizeCodexQuota(raw: unknown): CodexVendorQuota | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    complete: hasAllKeys(o, CODEX_RECORD_KEYS),
    creditsLabel: normalizeText(o.creditsLabel),
    fetchedAt: normalizeText(o.fetchedAt),
    loginState: normalizeLoginState(o.loginState),
    primaryUsedPercent: normalizeNumber(o.primaryUsedPercent),
    secondaryUsedPercent: normalizeNumber(o.secondaryUsedPercent),
    sparkPrimaryUsedPercent: normalizeNumber(o.sparkPrimaryUsedPercent),
    sparkSecondaryUsedPercent: normalizeNumber(o.sparkSecondaryUsedPercent),
  };
}

export function normalizeClaudeQuota(raw: unknown): ClaudeVendorQuota | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    complete: hasAllKeys(o, CLAUDE_RECORD_KEYS),
    creditsLabel: normalizeText(o.creditsLabel),
    fableUsedPercent: normalizeNumber(o.fableUsedPercent),
    fetchedAt: normalizeText(o.fetchedAt),
    loginState: normalizeLoginState(o.loginState),
    sessionUsedPercent: normalizeNumber(o.sessionUsedPercent),
    weeklyUsedPercent: normalizeNumber(o.weeklyUsedPercent),
  };
}

// Ported from status-collector.ts:1725. The file is append-only, so the last
// parseable vendor_quota_snapshot line is the current reading; malformed tail
// lines (a torn append) are skipped rather than failing the whole read.
//
// Both type discriminators are required (Tier-A review): the producer writes
// `type: 'event_msg'` on the envelope and `type: 'vendor_quota_snapshot'` on
// the payload. A line of some other event kind that happens to carry a
// vendor_quotas-shaped blob is not a vendor quota snapshot and is skipped —
// presence of the blob alone is not a claim about login state.
export function parseLatestVendorQuotaSnapshot(
  contents: string,
): VendorQuotaSnapshot | null {
  const lines = contents
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;

    const event = parsed as {
      type?: unknown;
      timestamp?: unknown;
      payload?: {
        type?: unknown;
        rate_limits?: CodexRateLimits;
        vendor_quotas?: { claude?: unknown; codex?: unknown };
      };
    };
    if (event.type !== 'event_msg') continue;
    if (event.payload?.type !== 'vendor_quota_snapshot') continue;
    const quotas = event.payload?.vendor_quotas;
    if (!quotas || typeof quotas !== 'object') continue;
    if (typeof event.timestamp !== 'string') continue;

    const capturedAtMs = Date.parse(event.timestamp);
    if (Number.isNaN(capturedAtMs)) continue;

    return {
      capturedAt: event.timestamp,
      capturedAtMs,
      claude: normalizeClaudeQuota(quotas.claude),
      codex: normalizeCodexQuota(quotas.codex),
      rateLimits: event.payload?.rate_limits ?? null,
    };
  }

  return null;
}

// Staleness signal 2, ported from status-collector.ts:1776 (isCodexSnapshotStale).
// A reading whose rate-limit window has already reset describes a window that
// no longer exists, however recent its timestamp claims to be.
export function hasExpiredRateLimitWindow(
  snapshot: VendorQuotaSnapshot,
  now: number,
): boolean {
  const limits = snapshot.rateLimits;
  if (!limits) return false;
  return [limits.primary, limits.secondary]
    .filter((w): w is CodexRateLimitWindow => Boolean(w))
    .some((w) => typeof w.resets_at === 'number' && now > w.resets_at * 1000);
}

function ageLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// The whole point of the module: what, if anything, do we actually know about
// this vendor's login right now?
export function readVendorLogin(
  vendor: VendorId,
  source: SnapshotSource,
  opts: { now?: number; freshnessMs?: number } = {},
): VendorLoginVerdict {
  const now = opts.now ?? Date.now();
  const freshnessMs = opts.freshnessMs ?? VENDOR_SNAPSHOT_FRESHNESS_MS;
  const unknown = (reason: string): VendorLoginVerdict => ({
    vendor,
    state: 'unknown',
    reason,
  });

  if (!source.present) {
    return unknown(
      `no ${VENDOR_QUOTA_SNAPSHOT_BASENAME} on this host — nothing produces one here`,
    );
  }

  const snapshot = parseLatestVendorQuotaSnapshot(source.contents);
  if (!snapshot) {
    return unknown(
      `no parseable vendor_quota_snapshot line in ${VENDOR_QUOTA_SNAPSHOT_BASENAME}`,
    );
  }

  const quota = vendor === 'codex' ? snapshot.codex : snapshot.claude;
  if (!quota) {
    return unknown(`snapshot carries no ${vendor} entry`);
  }
  if (quota.loginState === 'unknown') {
    return unknown(`snapshot carries no recognisable ${vendor} loginState`);
  }

  // rate_limits describes the Codex plan windows only, so this signal is not
  // evidence about Claude.
  const staleByWindow =
    vendor === 'codex' && hasExpiredRateLimitWindow(snapshot, now);

  if (quota.loginState === 'relogin-needed') {
    // The alarm direction stays lenient on purpose: an explicit
    // relogin-needed warns even from a partial or oddly-dated record, and an
    // expired login does not heal itself while nobody is watching, so a stale
    // warning still warns — it just says how old it is. Dating may fall back
    // to the envelope timestamp here; a mis-dated warning is still a warning.
    let observedAt = quota.fetchedAt ?? snapshot.capturedAt;
    let observedAge = ageFromObservedTimestamp(Date.parse(observedAt), now);
    if (!observedAge.ok && observedAt !== snapshot.capturedAt) {
      observedAt = snapshot.capturedAt;
      observedAge = ageFromObservedTimestamp(snapshot.capturedAtMs, now);
    }
    if (!observedAge.ok) {
      return {
        vendor,
        state: 'relogin-needed',
        observedAt,
        ageMs: null,
        stale: true,
      };
    }
    const ageMs = observedAge.ageMs;
    const stale = ageMs > freshnessMs || staleByWindow;
    return { vendor, state: 'relogin-needed', observedAt, ageMs, stale };
  }

  // From here loginState is 'authenticated' — the trusted-OK direction, and
  // the fail-closed one (Tier-A review). Before accepting it the record must
  // prove itself: a complete producer write, dated by the vendor's own
  // observation time, and that time must plausibly be in the past. Anything
  // less degrades to `unknown` with the reason.

  if (!quota.complete) {
    return unknown(
      `${vendor} record is missing producer fields — a partial or truncated write cannot prove "authenticated"`,
    );
  }

  // The vendor's own fetch time is the trust anchor. No silent fallback to
  // the envelope timestamp: an "authenticated" that cannot be dated by its
  // own observation cannot be aged, so it cannot be trusted.
  if (!quota.fetchedAt) {
    return unknown(
      `${vendor} record carries no fetchedAt — an undatable "authenticated" is not evidence`,
    );
  }
  const observedMs = Date.parse(quota.fetchedAt);
  if (Number.isNaN(observedMs)) {
    return unknown(
      `${vendor} record's fetchedAt is unparseable — an undatable "authenticated" is not evidence`,
    );
  }

  // A future observation is not clock skew past this bound; it is an
  // implausible reading (or a forged one) and must never authenticate.
  if (observedMs > now + VENDOR_TIMESTAMP_SKEW_MS) {
    return unknown(
      `${vendor} record is timestamped in the future (${quota.fetchedAt}) — refusing to trust it`,
    );
  }

  const observedAt = quota.fetchedAt;
  const observedAge = ageFromObservedTimestamp(observedMs, now);
  let ageMs: number;
  if (observedAge.ok) {
    ageMs = observedAge.ageMs;
  } else if (observedAge.reason === 'future') {
    // The gate above proves this is within the sanctioned two-minute clock-skew
    // allowance, so treating only this caller-approved skew as age zero is safe.
    ageMs = 0;
  } else {
    return unknown(
      `${vendor} record's fetchedAt or current time is non-finite — refusing to trust it`,
    );
  }
  const stale = ageMs > freshnessMs || staleByWindow;

  if (stale) {
    // "You were logged in half a day ago" is not "you are logged in".
    return unknown(
      staleByWindow
        ? `stale reading — its rate-limit window already reset (checked ${ageLabel(ageMs)} ago)`
        : `stale reading — last checked ${ageLabel(ageMs)} ago`,
    );
  }

  return { vendor, state: 'authenticated', observedAt, ageMs };
}

// One /status line. Every branch states what it knows and how it knows it;
// nothing renders as a confident value the measurement does not support.
export function formatVendorLoginLine(verdict: VendorLoginVerdict): string {
  const field = `${verdict.vendor}_login`;
  if (verdict.state === 'unknown') {
    return `${field}: unknown (${verdict.reason})`;
  }
  if (verdict.state === 'relogin-needed') {
    if (verdict.ageMs === null) {
      return `${field}: ${RELOGIN_WARNING} (stale reading, observation time unusable)`;
    }
    return verdict.stale
      ? `${field}: ${RELOGIN_WARNING} (stale reading, last known ${ageLabel(verdict.ageMs)} ago)`
      : `${field}: ${RELOGIN_WARNING} (checked ${ageLabel(verdict.ageMs)} ago)`;
  }
  return `${field}: authenticated (checked ${ageLabel(verdict.ageMs)} ago)`;
}
