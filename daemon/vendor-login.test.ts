// Does the vendor re-login detector actually tell the operator the truth?
//
// The migration lost the live warning entirely (see vendor-login.ts header), so
// an expired Codex or Claude login presented as a generic fleet stall. These
// tests pin the two things that make the restored field worth trusting:
//
//   1. an expired login IS flagged, per vendor;
//   2. a reading that cannot be trusted degrades to `unknown` and NEVER to a
//      confident "logged in". A false green here is worse than a blank field,
//      because it is the field the operator consults at exactly the moment the
//      fleet is failing.
//
// Rule 2 is what separates this from the live implementation, which coerced
// every non-'authenticated' value to 'relogin-needed' and reported a
// week-old snapshot as current.

import { expect, test } from 'bun:test';
import {
  RELOGIN_WARNING,
  VENDOR_SNAPSHOT_FRESHNESS_MS,
  formatVendorLoginLine,
  hasExpiredRateLimitWindow,
  parseLatestVendorQuotaSnapshot,
  readVendorLogin,
  type SnapshotSource,
  type VendorId,
} from './vendor-login';

// This module is pure and reads no environment. The suite still scrubs the
// whole ORCH_*/TELEGRAM_*/INFRA_* surface before handing an env to a child,
// because a coder lane runs inside the operator's own orchestrator process tree
// and therefore inherits the LIVE pointers (ORCH_STATE_DB, ORCH_LEASE_FILE,
// ORCH_INSTANCE_LOCK_FILE, ORCH_HEARTBEAT_FILE ...). Six lanes have been bitten
// by that inheritance. Copied from daemon/restart-armed.test.ts.
function isolatedEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('ORCH_')) continue;
    if (key.startsWith('TELEGRAM_')) continue;
    if (key.startsWith('INFRA_')) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

const NOW = Date.parse('2026-07-30T12:00:00.000Z');

// A synthetic snapshot line in the exact shape the live scraper appended to
// quota-latest.jsonl. Percentages only, no session data, no credentials.
function snapshotLine(opts: {
  timestamp?: string;
  codex?: Record<string, unknown> | null;
  claude?: Record<string, unknown> | null;
  rateLimits?: Record<string, unknown> | null;
}): string {
  const payload: Record<string, unknown> = {
    type: 'vendor_quota_snapshot',
    vendor_quotas: {
      ...(opts.codex === null ? {} : { codex: opts.codex ?? authedCodex() }),
      ...(opts.claude === null ? {} : { claude: opts.claude ?? authedClaude() }),
    },
  };
  if (opts.rateLimits) payload.rate_limits = opts.rateLimits;
  return JSON.stringify({
    type: 'event_msg',
    timestamp: opts.timestamp ?? '2026-07-30T11:55:00.000Z',
    payload,
  });
}

function authedCodex(over: Record<string, unknown> = {}) {
  return {
    creditsLabel: '$42.50',
    fetchedAt: '2026-07-30T11:55:00.000Z',
    loginState: 'authenticated',
    primaryUsedPercent: 80,
    secondaryUsedPercent: 92,
    sparkPrimaryUsedPercent: 77,
    sparkSecondaryUsedPercent: 87,
    ...over,
  };
}

function authedClaude(over: Record<string, unknown> = {}) {
  return {
    creditsLabel: '$17.00',
    fableUsedPercent: 36,
    fetchedAt: '2026-07-30T11:55:00.000Z',
    loginState: 'authenticated',
    sessionUsedPercent: 30,
    weeklyUsedPercent: 27,
    ...over,
  };
}

function source(contents: string): SnapshotSource {
  return { present: true, contents: `${contents}\n` };
}

// ---------------------------------------------------------------------------
// 1. The payload: an expired vendor login is detected, per vendor.
// ---------------------------------------------------------------------------

for (const vendor of ['codex', 'claude'] as VendorId[]) {
  test(`${vendor}: an expired login is flagged as relogin-needed`, () => {
    const line = snapshotLine(
      vendor === 'codex'
        ? { codex: authedCodex({ loginState: 'relogin-needed' }) }
        : { claude: authedClaude({ loginState: 'relogin-needed' }) },
    );
    const verdict = readVendorLogin(vendor, source(line), { now: NOW });

    expect(verdict.state).toBe('relogin-needed');
    expect(formatVendorLoginLine(verdict)).toContain(RELOGIN_WARNING);
  });

  test(`${vendor}: a healthy login is NOT flagged`, () => {
    const verdict = readVendorLogin(vendor, source(snapshotLine({})), {
      now: NOW,
    });

    expect(verdict.state).toBe('authenticated');
    expect(formatVendorLoginLine(verdict)).not.toContain(RELOGIN_WARNING);
  });
}

test('the latest line wins, so a fresh re-login clears an older warning', () => {
  const expired = snapshotLine({
    timestamp: '2026-07-30T10:00:00.000Z',
    codex: authedCodex({
      loginState: 'relogin-needed',
      fetchedAt: '2026-07-30T10:00:00.000Z',
    }),
  });
  const healthy = snapshotLine({});
  const verdict = readVendorLogin('codex', source(`${expired}\n${healthy}`), {
    now: NOW,
  });

  expect(verdict.state).toBe('authenticated');
});

// ---------------------------------------------------------------------------
// 2. Honest degradation: everything unverifiable is `unknown`.
// ---------------------------------------------------------------------------

test('a missing snapshot file degrades to unknown, not to "logged in"', () => {
  const verdict = readVendorLogin('codex', { present: false }, { now: NOW });

  expect(verdict.state).toBe('unknown');
  const line = formatVendorLoginLine(verdict);
  expect(line).toContain('unknown');
  expect(line).not.toContain(RELOGIN_WARNING);
});

test('a corrupt snapshot degrades to unknown', () => {
  for (const junk of ['', '   ', '{not json', '{"type":"event_msg"}', 'null']) {
    const verdict = readVendorLogin(
      'claude',
      { present: true, contents: junk },
      { now: NOW },
    );
    expect(verdict.state).toBe('unknown');
  }
});

test('a snapshot with no entry for this vendor is unknown, not authenticated', () => {
  const verdict = readVendorLogin(
    'claude',
    source(snapshotLine({ claude: null })),
    { now: NOW },
  );

  expect(verdict.state).toBe('unknown');
});

// The live implementation read `loginState === 'authenticated' ? ... :
// 'relogin-needed'`, so a truncated write or a schema change fabricated a
// re-login alarm the operator could not act on. A value we do not recognise is
// not evidence of anything.
test('an unrecognised loginState is unknown — no fabricated alarm, no fake OK', () => {
  for (const bogus of [undefined, null, '', 'AUTHENTICATED', 42, {}]) {
    const verdict = readVendorLogin(
      'codex',
      source(snapshotLine({ codex: authedCodex({ loginState: bogus }) })),
      { now: NOW },
    );
    expect(verdict.state).toBe('unknown');
  }
});

// ---------------------------------------------------------------------------
// 3. Staleness. Two independent signals, both ported from live.
// ---------------------------------------------------------------------------

test('an "authenticated" reading older than the freshness window is unknown', () => {
  const old = new Date(NOW - VENDOR_SNAPSHOT_FRESHNESS_MS - 60_000).toISOString();
  const verdict = readVendorLogin(
    'codex',
    source(
      snapshotLine({
        timestamp: old,
        codex: authedCodex({ fetchedAt: old }),
      }),
    ),
    { now: NOW },
  );

  // "You were logged in half a day ago" is not "you are logged in".
  expect(verdict.state).toBe('unknown');
  expect(formatVendorLoginLine(verdict)).toContain('stale');
});

test('a stale re-login warning still warns — an expired login does not heal itself', () => {
  const old = new Date(NOW - VENDOR_SNAPSHOT_FRESHNESS_MS - 60_000).toISOString();
  const verdict = readVendorLogin(
    'claude',
    source(
      snapshotLine({
        timestamp: old,
        claude: authedClaude({ loginState: 'relogin-needed', fetchedAt: old }),
      }),
    ),
    { now: NOW },
  );

  expect(verdict.state).toBe('relogin-needed');
  expect(formatVendorLoginLine(verdict)).toContain(RELOGIN_WARNING);
  expect(formatVendorLoginLine(verdict)).toContain('stale');
});

// Live's isCodexSnapshotStale: a reading whose rate-limit window has already
// reset describes a window that no longer exists.
test('a rate-limit window whose resets_at has already passed marks the reading stale', () => {
  const expiredWindows = {
    plan_type: 'pro',
    primary: {
      used_percent: 80,
      window_minutes: 300,
      resets_at: Math.floor((NOW - 60_000) / 1000),
    },
    secondary: {
      used_percent: 92,
      window_minutes: 10080,
      resets_at: Math.floor((NOW + 86_400_000) / 1000),
    },
  };
  const snapshot = parseLatestVendorQuotaSnapshot(
    snapshotLine({ rateLimits: expiredWindows }),
  );
  expect(snapshot).not.toBeNull();
  expect(hasExpiredRateLimitWindow(snapshot!, NOW)).toBe(true);

  // ... and a reading proven to describe a past window cannot support a
  // confident "logged in".
  const verdict = readVendorLogin(
    'codex',
    source(snapshotLine({ rateLimits: expiredWindows })),
    { now: NOW },
  );
  expect(verdict.state).toBe('unknown');
});

test('rate-limit windows still in the future do not mark the reading stale', () => {
  const live = {
    plan_type: 'pro',
    primary: {
      used_percent: 80,
      window_minutes: 300,
      resets_at: Math.floor((NOW + 3_600_000) / 1000),
    },
    secondary: {
      used_percent: 92,
      window_minutes: 10080,
      resets_at: Math.floor((NOW + 86_400_000) / 1000),
    },
  };
  const snapshot = parseLatestVendorQuotaSnapshot(
    snapshotLine({ rateLimits: live }),
  );
  expect(hasExpiredRateLimitWindow(snapshot!, NOW)).toBe(false);
  expect(
    readVendorLogin('codex', source(snapshotLine({ rateLimits: live })), {
      now: NOW,
    }).state,
  ).toBe('authenticated');
});

// ---------------------------------------------------------------------------
// 4. Rendering never lies.
// ---------------------------------------------------------------------------

test('no unknown verdict ever renders as a confident OK or a confident zero', () => {
  const unknowns: SnapshotSource[] = [
    { present: false },
    { present: true, contents: 'garbage' },
    { present: true, contents: `${snapshotLine({ codex: null })}\n` },
  ];

  for (const src of unknowns) {
    const verdict = readVendorLogin('codex', src, { now: NOW });
    expect(verdict.state).toBe('unknown');
    const line = formatVendorLoginLine(verdict);
    expect(line).toContain('unknown');
    // No "ok", no "0%", no re-login claim: the field states that it does not
    // know, and says why.
    expect(line).not.toMatch(/\bok\b/);
    expect(line).not.toMatch(/\b0%/);
    expect(line).not.toContain(RELOGIN_WARNING);
    expect(line.length).toBeGreaterThan('codex_login: unknown'.length);
  }
});

test('the operator-facing warning token is byte-identical to the live one', () => {
  // Preserved verbatim (CLAUDE.md rule 16/17, operator.language: uk) so the
  // operator recognises the same sentence the old daemon printed.
  expect(RELOGIN_WARNING).toBe('сесія протермінована — треба перелогінитись');
});

// ---------------------------------------------------------------------------
// 5. No environment surface.
// ---------------------------------------------------------------------------

test('verdicts are identical under a fully scrubbed ORCH_/TELEGRAM_/INFRA_ env', async () => {
  const driver = `
    const { readVendorLogin } = await import(${JSON.stringify(
      join_(import.meta.dir, 'vendor-login.ts'),
    )});
    const line = ${JSON.stringify(
      snapshotLine({ codex: authedCodex({ loginState: 'relogin-needed' }) }),
    )};
    const v = readVendorLogin('codex', { present: true, contents: line }, { now: ${NOW} });
    console.log(JSON.stringify({ state: v.state }));
  `;
  const child = Bun.spawn(['bun', '-e', driver], {
    env: isolatedEnv({}),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const out = await new Response(child.stdout).text();
  await child.exited;

  expect(JSON.parse(out.trim())).toEqual({ state: 'relogin-needed' });
});

function join_(...parts: string[]): string {
  return parts.join('/');
}
