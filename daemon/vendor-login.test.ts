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
// 5. Trust boundary: adversarial snapshots never authenticate.
//
// quota-latest.jsonl is written by another program (currently: by nothing —
// see the writer gap). Everything read from it is untrusted input, and the
// Tier-A review proved the original port would return a confident
// "authenticated" from three inputs no complete, honest producer emits:
// a partial vendor record, an unrelated event type, and a future-dated
// snapshot. Each of these must degrade to `unknown` with a reason.
// ---------------------------------------------------------------------------

// Probe 1: a partial vendor record. A bare {loginState:"authenticated"} is a
// truncated or forged write, not a producer snapshot; it must not authenticate.
for (const vendor of ['codex', 'claude'] as VendorId[]) {
  test(`${vendor}: a partial vendor record — bare {loginState:"authenticated"} — is unknown, never authenticated`, () => {
    const line = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-30T11:55:00.000Z',
      payload: {
        type: 'vendor_quota_snapshot',
        vendor_quotas: { [vendor]: { loginState: 'authenticated' } },
      },
    });
    const verdict = readVendorLogin(vendor, source(line), { now: NOW });

    expect(verdict.state).toBe('unknown');
    // The rendered line carries the reason, not a confident value.
    expect(formatVendorLoginLine(verdict)).toContain('unknown (');
  });
}

// Probe 2: the event/payload type discriminators. A line of some other event
// kind that happens to carry a vendor_quotas-shaped blob is not a vendor quota
// snapshot, and neither is a payload without its own discriminator.
test('an unrelated or undiscriminated event type never authenticates, even if it smuggles vendor_quotas', () => {
  const timestamp = '2026-07-30T11:55:00.000Z';
  const impostors = [
    // unrelated event kind, well-formed vendor blob inside
    {
      type: 'lease_heartbeat',
      timestamp,
      payload: {
        type: 'lease_heartbeat',
        vendor_quotas: { codex: authedCodex() },
      },
    },
    // right envelope, payload discriminator missing
    {
      type: 'event_msg',
      timestamp,
      payload: { vendor_quotas: { codex: authedCodex() } },
    },
    // right payload discriminator, envelope discriminator missing
    {
      timestamp,
      payload: {
        type: 'vendor_quota_snapshot',
        vendor_quotas: { codex: authedCodex() },
      },
    },
  ];

  for (const impostor of impostors) {
    const verdict = readVendorLogin(
      'codex',
      source(JSON.stringify(impostor)),
      { now: NOW },
    );
    expect(verdict.state).toBe('unknown');
    expect(formatVendorLoginLine(verdict)).toContain('unknown (');
  }
});

// Probe 3: a future-dated snapshot. "Observed at 2099" is not evidence about
// now; clamping its negative age to zero and authenticating from it was the
// reviewer's sharpest counterexample.
test('a future-dated snapshot is unknown with a reason — a 2099 timestamp never authenticates', () => {
  const future = '2099-01-01T00:00:00.000Z';
  const verdict = readVendorLogin(
    'codex',
    source(
      snapshotLine({
        timestamp: future,
        codex: authedCodex({ fetchedAt: future }),
      }),
    ),
    { now: NOW },
  );

  expect(verdict.state).toBe('unknown');
  expect(formatVendorLoginLine(verdict)).toContain('unknown (');
  expect(formatVendorLoginLine(verdict)).toContain('future');
});

// Probe 3b: the vendor's own observation time is the trust anchor for
// "authenticated". A record without one must not silently borrow the envelope
// timestamp and authenticate from it.
test('an authenticated record with no vendor fetchedAt is unknown — no silent envelope-timestamp fallback', () => {
  for (const missing of [null, '   ', 'not-a-date']) {
    const verdict = readVendorLogin(
      'codex',
      source(snapshotLine({ codex: authedCodex({ fetchedAt: missing }) })),
      { now: NOW },
    );
    expect(verdict.state).toBe('unknown');
    expect(formatVendorLoginLine(verdict)).toContain('unknown (');
  }
});

// The gates above are about trusting "authenticated". They must NOT suppress
// the alarm direction: an explicit relogin-needed in a partial or oddly-dated
// record still warns, because losing a true warning is the original failure
// this module exists to prevent.
test('a partial or future-dated record with an explicit relogin-needed still warns', () => {
  const partial = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-07-30T11:55:00.000Z',
    payload: {
      type: 'vendor_quota_snapshot',
      vendor_quotas: { claude: { loginState: 'relogin-needed' } },
    },
  });
  expect(
    readVendorLogin('claude', source(partial), { now: NOW }).state,
  ).toBe('relogin-needed');

  const future = '2099-01-01T00:00:00.000Z';
  const futureLine = snapshotLine({
    timestamp: future,
    claude: authedClaude({ loginState: 'relogin-needed', fetchedAt: future }),
  });
  expect(
    readVendorLogin('claude', source(futureLine), { now: NOW }).state,
  ).toBe('relogin-needed');
});

// The alarm direction remains lenient, but unusable dating must not be
// laundered into a fresh "checked 0m ago" reading.
test('relogin-needed with future vendor and envelope timestamps warns without claiming freshness', () => {
  const future = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
  const verdict = readVendorLogin(
    'claude',
    source(
      snapshotLine({
        timestamp: future,
        claude: authedClaude({
          loginState: 'relogin-needed',
          fetchedAt: future,
        }),
      }),
    ),
    { now: NOW },
  );

  expect(verdict.state).toBe('relogin-needed');
  if (verdict.state !== 'relogin-needed') return;
  expect(verdict.stale).toBe(true);
  expect(verdict.ageMs).toBeNull();
  const rendered = formatVendorLoginLine(verdict);
  expect(rendered).toContain(RELOGIN_WARNING);
  expect(rendered).not.toContain('checked 0m ago');
});

test('relogin-needed falls back from a future fetchedAt to a valid past envelope', () => {
  const pastEnvelope = new Date(NOW - 5 * 60 * 1000).toISOString();
  const futureFetch = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
  const verdict = readVendorLogin(
    'codex',
    source(
      snapshotLine({
        timestamp: pastEnvelope,
        codex: authedCodex({
          loginState: 'relogin-needed',
          fetchedAt: futureFetch,
        }),
      }),
    ),
    { now: NOW },
  );

  expect(verdict.state).toBe('relogin-needed');
  if (verdict.state !== 'relogin-needed') return;
  expect(verdict.observedAt).toBe(pastEnvelope);
  expect(verdict.ageMs).toBe(5 * 60 * 1000);
  expect(verdict.stale).toBe(false);
  expect(formatVendorLoginLine(verdict)).not.toContain('checked 0m ago');
});

test('relogin-needed with a normal past timestamp keeps its true fresh age', () => {
  const past = new Date(NOW - 5 * 60 * 1000).toISOString();
  const verdict = readVendorLogin(
    'claude',
    source(
      snapshotLine({
        timestamp: past,
        claude: authedClaude({
          loginState: 'relogin-needed',
          fetchedAt: past,
        }),
      }),
    ),
    { now: NOW },
  );

  expect(verdict.state).toBe('relogin-needed');
  if (verdict.state !== 'relogin-needed') return;
  expect(verdict.ageMs).toBe(5 * 60 * 1000);
  expect(verdict.stale).toBe(false);
});

test('authenticated preserves the sanctioned two-minute clock-skew allowance', () => {
  const future = new Date(NOW + 90 * 1000).toISOString();
  const verdict = readVendorLogin(
    'codex',
    source(
      snapshotLine({
        timestamp: future,
        codex: authedCodex({ fetchedAt: future }),
      }),
    ),
    { now: NOW },
  );

  expect(verdict.state).toBe('authenticated');
  if (verdict.state !== 'authenticated') return;
  expect(verdict.ageMs).toBe(0);
});

test('authenticated remains unknown beyond the two-minute clock-skew allowance', () => {
  const future = new Date(NOW + 5 * 60 * 1000).toISOString();
  const verdict = readVendorLogin(
    'codex',
    source(
      snapshotLine({
        timestamp: future,
        codex: authedCodex({ fetchedAt: future }),
      }),
    ),
    { now: NOW },
  );

  expect(verdict.state).toBe('unknown');
  expect(formatVendorLoginLine(verdict)).toContain('future');
});

test('authenticated with a normal past timestamp keeps its true age', () => {
  const past = new Date(NOW - 5 * 60 * 1000).toISOString();
  const verdict = readVendorLogin(
    'codex',
    source(
      snapshotLine({
        timestamp: past,
        codex: authedCodex({ fetchedAt: past }),
      }),
    ),
    { now: NOW },
  );

  expect(verdict.state).toBe('authenticated');
  if (verdict.state !== 'authenticated') return;
  expect(verdict.ageMs).toBe(5 * 60 * 1000);
});

test('authenticated degrades to unknown when its computed age is non-finite', () => {
  const verdict = readVendorLogin(
    'codex',
    source(snapshotLine({ codex: authedCodex() })),
    { now: Number.NaN },
  );

  expect(verdict.state).toBe('unknown');
  expect(formatVendorLoginLine(verdict)).toContain('non-finite');
});

// ---------------------------------------------------------------------------
// 6. No environment surface.
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
