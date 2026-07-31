// Tests for the human-facing /status summary (HR-150).
//
// The honesty cases are the load-bearing ones: a dead orchestrator, a stale
// heartbeat, and a timed-out git must all render as labeled «невідомо» /
// blockers — never as a fabricated "all good" and never as a crash.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countActiveLanes, type ActiveLanes, type ShRunner } from './status';
import {
  HEARTBEAT_FRESH_MS,
  HUMAN_STATUS_PREFIX,
  MAX_HUMAN_STATUS_LENGTH,
  parseHeartbeat,
  readLastLanded,
  renderHumanStatus,
  renderHumanStatusMessage,
  uaAge,
  uaPlural,
  type LastLanded,
  type StatusSummaryDeps,
} from './status-summary';

const NOW = 1_800_000_000_000;

const HEALTHY_LANES: ActiveLanes = {
  verified: true,
  count: 2,
  lanes: [
    { path: '/home/bpa-shell/.cache/infra-lanes/status-human', branch: 'ag-status-human', ahead: 3 },
    { path: '/home/bpa-shell/.cache/infra-lanes/voice-media', branch: 'ag-voice-media', ahead: 0 },
  ],
};

const HEALTHY_LANDED: LastLanded = {
  verified: true,
  entries: [
    { subject: '[ORCH] land lane ag-ci-coverage', ageMs: 2 * 3_600_000 },
    { subject: '[ORCH] land lane ag-voice-media', ageMs: 5 * 3_600_000 },
    { subject: '[CODER] daemon: honest /status fields', ageMs: 3 * 24 * 3_600_000 },
  ],
};

function healthyDeps(): StatusSummaryDeps {
  return {
    orchestrator: {
      tmuxConfigured: true,
      tmuxAlive: true,
      model: 'Codex (gpt-5.5)',
    },
    heartbeat: { status: 'ok', ageMs: 2 * 60_000 },
    lanes: HEALTHY_LANES,
    lastLanded: HEALTHY_LANDED,
    mission: {
      present: true,
      mission: { status: 'running', desc: 'W-14: зробити /status людяним' },
      updatedAt: NOW - 5 * 60_000,
    },
    now: NOW,
  };
}

test('healthy: renders the exact human lines, no raw JSON, short', () => {
  const lines = renderHumanStatus(healthyDeps());
  expect(lines).toEqual([
    'Оркестратор: живий (серцебиття 2 хв тому, модель: Codex (gpt-5.5))',
    'Місія: W-14: зробити /status людяним [running]',
    'Зараз в роботі: 2 лейни:',
    '  • ag-status-human — 3 коміти',
    '  • ag-voice-media — ще без комітів',
    'Останнє приземлене:',
    '  • [ORCH] land lane ag-ci-coverage (2 год тому)',
    '  • [ORCH] land lane ag-voice-media (5 год тому)',
    '  • [CODER] daemon: honest /status fields (3 дн тому)',
    'Блокери: немає',
  ]);
  expect(lines.length).toBeLessThanOrEqual(10);
  for (const line of lines) {
    expect(line).not.toContain('{');
    expect(line).not.toContain('"');
  }
});

test('HONESTY: orchestrator-dead renders as not running and a blocker, never OK', () => {
  const deps = healthyDeps();
  deps.orchestrator.tmuxAlive = false;
  deps.heartbeat = { status: 'absent' };
  deps.lanes = {
    verified: true,
    count: 1,
    lanes: [{ path: '/x/status-human', branch: 'ag-status-human', ahead: 0 }],
  };
  deps.lastLanded = { verified: true, entries: HEALTHY_LANDED.entries.slice(0, 1) };
  deps.mission = { present: true, mission: null };
  const lines = renderHumanStatus(deps);
  expect(lines).toEqual([
    'Оркестратор: не запущений (tmux-сесії немає)',
    'Місія: не задана',
    'Зараз в роботі: 1 лейн:',
    '  • ag-status-human — ще без комітів',
    'Останнє приземлене:',
    '  • [ORCH] land lane ag-ci-coverage (2 год тому)',
    'Блокери: оркестратор не запущений',
  ]);
});

test('HONESTY: stale heartbeat with live tmux is labeled with its age and blocks', () => {
  const deps = healthyDeps();
  deps.heartbeat = { status: 'ok', ageMs: 45 * 60_000 };
  const lines = renderHumanStatus(deps);
  expect(lines[0]).toBe(
    'Оркестратор: tmux активний, але серцебиття застаріле (45 хв тому) — стан невідомий',
  );
  expect(lines.at(-1)).toBe(
    'Блокери: серцебиття оркестратора застаріле (45 хв тому)',
  );
  // Never claims alive on a stale heartbeat.
  expect(lines[0]).not.toContain('живий');
});

test('HONESTY: absent heartbeat with live tmux is unknown, not alive', () => {
  const deps = healthyDeps();
  deps.heartbeat = { status: 'absent' };
  const lines = renderHumanStatus(deps);
  expect(lines[0]).toBe(
    'Оркестратор: tmux активний, серцебиття відсутнє — стан невідомий',
  );
  expect(lines.at(-1)).toBe('Блокери: серцебиття оркестратора відсутнє');
});

test('no-lanes: an empty verified census renders as none, not unknown', () => {
  const deps = healthyDeps();
  deps.lanes = { verified: true, count: 0, lanes: [] };
  const lines = renderHumanStatus(deps);
  expect(lines).toContain('Зараз в роботі: лейнів немає');
  expect(lines.at(-1)).toBe('Блокери: немає');
});

test('HONESTY: git-timeout renders lanes and landed as unknown, each with its blocker', () => {
  const deps = healthyDeps();
  deps.lanes = { verified: false, reason: 'git timeout' };
  deps.lastLanded = { verified: false, reason: 'git timeout' };
  const lines = renderHumanStatus(deps);
  expect(lines).toContain('Зараз в роботі: невідомо (немає перевірених даних git)');
  expect(lines).toContain('Останнє приземлене: невідомо (немає перевірених даних git)');
  const blockers = lines.at(-1)!;
  expect(blockers).toContain('стан лейнів невідомий');
  expect(blockers).toContain('останні приземлені невідомі');
  expect(blockers).not.toContain('Блокери: немає');
});

test('HONESTY: missing mission source is unknown AND a blocker, reason kept generic', () => {
  const deps = healthyDeps();
  deps.mission = { present: false, reason: 'no state DB at /x/state.db' };
  const lines = renderHumanStatus(deps);
  expect(lines[1]).toBe('Місія: невідомо (джерело місії недоступне)');
  expect(lines.at(-1)).toContain('стан місії невідомий');
});

test('stale mission rows are labeled with their age', () => {
  const deps = healthyDeps();
  deps.mission = {
    present: true,
    mission: { status: 'running', desc: 'W-14' },
    updatedAt: NOW - 3 * 3_600_000,
  };
  const lines = renderHumanStatus(deps);
  expect(lines[1]).toBe('Місія: W-14 [running] (оновлено 3 год тому)');
});

test('unknown tmux probe degrades to unknown, not to dead', () => {
  const deps = healthyDeps();
  deps.orchestrator.tmuxAlive = null;
  const lines = renderHumanStatus(deps);
  expect(lines[0]).toBe('Оркестратор: невідомо (не вдалося перевірити tmux)');
  expect(lines.at(-1)).toBe('Блокери: стан оркестратора невідомий');
});

test('many lanes are capped with an overflow line', () => {
  const deps = healthyDeps();
  const lanes = Array.from({ length: 6 }, (_, i) => ({
    path: `/x/l${i}`,
    branch: `ag-l${i}`,
    ahead: 1,
  }));
  deps.lanes = { verified: true, count: 6, lanes };
  const lines = renderHumanStatus(deps);
  expect(lines).toContain('Зараз в роботі: 6 лейнів:');
  expect(lines).toContain('  • … і ще 2');
});

// ── heartbeat parsing ────────────────────────────────────────────────────────

test('parseHeartbeat: absent / invalid / future / fresh / stale', () => {
  expect(parseHeartbeat(null, NOW)).toEqual({ status: 'absent' });
  expect(parseHeartbeat('garbage', NOW)).toEqual({ status: 'invalid' });
  // A heartbeat far in the future is a broken clock, not liveness evidence.
  expect(
    parseHeartbeat(String(Math.floor(NOW / 1000) + 3600), NOW).status,
  ).toBe('invalid');
  const fresh = parseHeartbeat(String(Math.floor(NOW / 1000) - 120), NOW);
  expect(fresh).toEqual({ status: 'ok', ageMs: 120_000 });
  const stale = parseHeartbeat(
    String(Math.floor((NOW - HEARTBEAT_FRESH_MS) / 1000) - 60),
    NOW,
  );
  expect(stale.status).toBe('ok');
  if (stale.status === 'ok') expect(stale.ageMs).toBeGreaterThan(HEARTBEAT_FRESH_MS);
});

// ── last-landed probe ────────────────────────────────────────────────────────

test('readLastLanded parses subjects and relative ages from git log output', () => {
  const runner: ShRunner = (cmd) => {
    expect(cmd).toContain("log 'origin/main' -3");
    return {
      out: [
        `[ORCH] land lane ag-a\t${Math.floor(NOW / 1000) - 7200}`,
        `[CODER] fix\t${Math.floor(NOW / 1000) - 60}`,
      ].join('\n'),
      ok: true,
    };
  };
  const res = readLastLanded('/repo', runner, { now: NOW });
  expect(res).toEqual({
    verified: true,
    entries: [
      { subject: '[ORCH] land lane ag-a', ageMs: 7_200_000 },
      { subject: '[CODER] fix', ageMs: 60_000 },
    ],
  });
});

test('HONESTY: readLastLanded degrades on timeout and on failure', () => {
  const timeout: ShRunner = () => ({ out: '', ok: false, timedOut: true });
  expect(readLastLanded('/repo', timeout)).toEqual({
    verified: false,
    reason: 'git timeout',
  });
  const broken: ShRunner = () => ({ out: 'fatal: not a git repo', ok: false });
  const res = readLastLanded('/repo', broken);
  expect(res.verified).toBe(false);
  if (!res.verified) expect(res.reason).toContain('git log failed');
});

// ── adversarial honesty rows ─────────────────────────────────────────────────
// Every row here injects one degraded/hostile source into an otherwise healthy
// status and asserts the all-good line «Блокери: немає» is ABSENT. These are
// the review-rejection cases: absence of evidence must never render as OK.

const ALL_GOOD = 'Блокери: немає';

test('ADVERSARIAL: missing mission source, otherwise healthy → never «Блокери: немає»', () => {
  const deps = healthyDeps();
  deps.mission = { present: false, reason: 'no state DB at /x/state.db' };
  const lines = renderHumanStatus(deps);
  expect(lines.join('\n')).not.toContain(ALL_GOOD);
  // The raw reason (a filesystem path) must not leak into the human summary.
  expect(lines.join('\n')).not.toContain('/x/state.db');
});

test('ADVERSARIAL: empty git-log output is unknown, not «нічого не знайдено»', () => {
  const runner: ShRunner = () => ({ out: '', ok: true });
  const res = readLastLanded('/repo', runner, { now: NOW });
  expect(res.verified).toBe(false);
  const deps = healthyDeps();
  deps.lastLanded = res;
  const lines = renderHumanStatus(deps);
  expect(lines.join('\n')).not.toContain(ALL_GOOD);
  expect(lines.join('\n')).not.toContain('нічого не знайдено');
});

test('ADVERSARIAL: malformed git-log output is unknown, never verified-empty', () => {
  const runner: ShRunner = () => ({
    out: 'garbage without tab\nmore garbage',
    ok: true,
  });
  const res = readLastLanded('/repo', runner, { now: NOW });
  expect(res.verified).toBe(false);
  const deps = healthyDeps();
  deps.lastLanded = res;
  const lines = renderHumanStatus(deps);
  expect(lines.join('\n')).not.toContain(ALL_GOOD);
});

test('ADVERSARIAL: a THROWING runner degrades to unknown, not a crash', () => {
  const thrower: ShRunner = () => {
    throw new Error('spawn EAGAIN');
  };
  const res = readLastLanded('/repo', thrower, { now: NOW });
  expect(res.verified).toBe(false);
  const deps = healthyDeps();
  deps.lastLanded = res;
  const lines = renderHumanStatus(deps);
  expect(lines.join('\n')).not.toContain(ALL_GOOD);
});

test('ADVERSARIAL: heartbeat +1s in the future is INVALID and blocks — no grace', () => {
  const plus1s = parseHeartbeat(String(Math.floor(NOW / 1000) + 1), NOW);
  expect(plus1s.status).toBe('invalid');
  const deps = healthyDeps();
  deps.heartbeat = plus1s;
  const lines = renderHumanStatus(deps);
  expect(lines.join('\n')).not.toContain(ALL_GOOD);
  expect(lines[0]).not.toContain('живий');
});

test('ADVERSARIAL: future commit timestamp makes last-landed unknown, no clamp', () => {
  const runner: ShRunner = () => ({
    out: `[ORCH] time traveler\t${Math.floor(NOW / 1000) + 60}`,
    ok: true,
  });
  const res = readLastLanded('/repo', runner, { now: NOW });
  expect(res.verified).toBe(false);
  const deps = healthyDeps();
  deps.lastLanded = res;
  const lines = renderHumanStatus(deps);
  expect(lines.join('\n')).not.toContain(ALL_GOOD);
  expect(lines.join('\n')).not.toContain('щойно)');
});

for (const offsetMs of [1, 60_000]) {
  test(`ADVERSARIAL: future mission timestamp +${offsetMs}ms is invalid and blocks`, () => {
    const deps = healthyDeps();
    deps.mission = {
      present: true,
      mission: { status: 'running', desc: 'W-14' },
      updatedAt: NOW + offsetMs,
    };
    const lines = renderHumanStatus(deps);
    expect(lines.join('\n')).not.toContain(ALL_GOOD);
    expect(lines[1]).toContain('невідомо');
    expect(lines.at(-1)).toContain('місії');
  });
}

const MALFORMED_WORKTREE_OUTPUTS = [
  {
    name: 'reviewer truncated record',
    out: [
      'worktree /home/bpa-shell/.cache/infra-lanes/ag-cut-off',
      'HEAD 1111111111111111111111111111111111111111',
    ].join('\n'),
  },
  { name: 'empty census', out: '' },
  {
    name: 'mid-record cut-off',
    out: 'worktree /home/bpa-shell/.cache/infra-lanes/ag-cut-off',
  },
  {
    name: 'orphan branch',
    out: 'branch refs/heads/ag-orphan',
  },
] as const;

for (const malformed of MALFORMED_WORKTREE_OUTPUTS) {
  test(`ADVERSARIAL: ${malformed.name} worktree porcelain is unknown and blocks`, () => {
    const runner: ShRunner = () => ({ out: malformed.out, ok: true });
    const lanes = countActiveLanes('/repo', runner);
    expect(lanes.verified).toBe(false);
    const deps = healthyDeps();
    deps.lanes = lanes;
    const lines = renderHumanStatus(deps);
    expect(lines.join('\n')).not.toContain(ALL_GOOD);
    expect(lines.at(-1)).toContain('стан лейнів невідомий');
  });
}

test('ADVERSARIAL: unknown lane ahead-state is a blocker, not a silent shrug', () => {
  const deps = healthyDeps();
  deps.lanes = {
    verified: true,
    count: 1,
    lanes: [{ path: '/x/l0', branch: 'ag-l0', ahead: -1 }],
  };
  const lines = renderHumanStatus(deps);
  expect(lines.join('\n')).not.toContain(ALL_GOOD);
});

test('SANITIZE: control chars and ANSI in source text never reach the summary', () => {
  const deps = healthyDeps();
  deps.lastLanded = {
    verified: true,
    entries: [{ subject: '[ORCH] ok\u001b[31m evil\u0007\nX', ageMs: 60_000 }],
  };
  deps.mission = {
    present: true,
    mission: { status: 'running', desc: 'W-14\u0000\u202e tricky' },
    updatedAt: NOW,
  };
  const lines = renderHumanStatus(deps);
  const joined = lines.join('|');
  expect(joined).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
});

test('SANITIZE: over-long source text is capped in the summary', () => {
  const deps = healthyDeps();
  deps.lastLanded = {
    verified: true,
    entries: [{ subject: `[ORCH] ${'x'.repeat(500)}`, ageMs: 60_000 }],
  };
  const lines = renderHumanStatus(deps);
  const landed = lines.find((l) => l.includes('[ORCH]'))!;
  expect(landed.length).toBeLessThan(120);
});

test('SECURITY: every free-text sink redacts paths, assignments, and token shapes', () => {
  const path = '/home/operator/private/state.db';
  const envName = 'GITHUB' + '_TOKEN=';
  const vendorToken =
    'gh' + 'p_' + '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
  const opaque =
    'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6';
  const credential = 'credential=' + 'supersecret';
  const deps = healthyDeps();
  deps.orchestrator.model = credential;
  deps.mission = {
    present: true,
    mission: { desc: path, status: `${envName}synthetic` },
    updatedAt: NOW,
  };
  deps.lanes = {
    verified: true,
    count: 1,
    lanes: [{ path: '/not-rendered', branch: opaque, ahead: 1 }],
  };
  deps.lastLanded = {
    verified: true,
    entries: [{ subject: vendorToken, ageMs: 60_000 }],
  };

  const joined = renderHumanStatus(deps).join('\n');
  expect(joined).toContain('<path redacted>');
  expect(joined).toContain('<redacted>');
  for (const leaked of [
    path,
    envName,
    vendorToken,
    opaque,
    opaque.slice(0, 30),
    credential,
  ]) {
    expect(joined).not.toContain(leaked);
  }
});

test('SECURITY: legitimate /status subject, branch, status, and model stay readable', () => {
  const joined = renderHumanStatus(healthyDeps()).join('\n');
  expect(joined).toContain('[CODER] daemon: honest /status fields');
  expect(joined).toContain('ag-status-human');
  expect(joined).toContain('[running]');
  expect(joined).toContain('Codex (gpt-5.5)');
});

test('SECURITY: required path and credential families are visibly redacted', () => {
  const samples = [
    '/etc/operator/private.conf',
    '~/private',
    'C:\\Users\\operator\\private.txt',
    'DEPLOY_ENV=synthetic',
    'password=synthetic',
    'Bearer abcdefghijklmnop',
    'gh' + 'o_abcdefghijklmnopqrstuvwxyz',
    'github' + '_pat_abcdefghijklmnopqrstuvwxyz',
    'sk-' + 'abcdefghijklmnopqrst',
    'xox' + 'b-abcdefghijklmnopqrst',
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'ASIA' + 'ABCDEFGHIJKLMNOP',
    'AIza' + 'abcdefghijklmnopqrstuvwxyz123456789',
    'hf_' + 'abcdefghijklmnopqrst',
    'glpat-' + 'abcdefghijklmnopqrst',
    'npm_' + 'abcdefghijklmnopqrst',
    'dop_v1_' + 'abcdefghijklmnopqrst',
    'SG.' + 'abcdefghijklmnopqrst',
    'abcdefgh.ijklmnop.qrstuvwx',
    'https://user:pass@example.test/private',
    'https://example.test/?token=synthetic',
  ];

  for (const sample of samples) {
    const deps = healthyDeps();
    deps.lastLanded = {
      verified: true,
      entries: [{ subject: sample, ageMs: 60_000 }],
    };
    const joined = renderHumanStatus(deps).join('\n');
    expect(joined).not.toContain(sample);
    expect(joined).toContain('redacted>');
  }
});

test('SECURITY: final prefixed simultaneous-maxima summary is capped and keeps blockers', () => {
  const deps = healthyDeps();
  deps.orchestrator.model = 'M'.repeat(500);
  deps.mission = {
    present: true,
    mission: {
      status: 'S'.repeat(500),
      desc: 'D'.repeat(500),
    },
    updatedAt: NOW - 999_999_999_999_999,
  };
  deps.lanes = {
    verified: true,
    count: 8,
    lanes: Array.from({ length: 8 }, (_, i) => ({
      path: `/lane/${i}`,
      branch: String.fromCharCode(65 + i).repeat(500),
      ahead: i === 0 ? -1 : 999_999_999_999_999,
    })),
  };
  deps.lastLanded = {
    verified: true,
    entries: Array.from({ length: 6 }, (_, i) => ({
      subject: String.fromCharCode(75 + i).repeat(500),
      ageMs: 999_999_999_999_999,
    })),
  };

  const message = renderHumanStatusMessage(deps);
  expect(message.startsWith(HUMAN_STATUS_PREFIX)).toBe(true);
  expect(message.length).toBeLessThanOrEqual(MAX_HUMAN_STATUS_LENGTH);
  expect(message.length).toBeLessThanOrEqual(4096);
  expect(message).toContain('… (частину деталей приховано)');
  expect(message).toContain('Блокери: стан частини лейнів невідомий');
  expect(message).not.toContain('Блокери: немає');
  expect(message.at(-1)).not.toBe('…');
});

// ── helpers ──────────────────────────────────────────────────────────────────

test('uaAge and uaPlural cover the Ukrainian forms', () => {
  expect(uaAge(10_000)).toBe('щойно');
  expect(uaAge(5 * 60_000)).toBe('5 хв тому');
  expect(uaAge(3 * 3_600_000)).toBe('3 год тому');
  expect(uaAge(72 * 3_600_000)).toBe('3 дн тому');
  expect(uaPlural(1, 'лейн', 'лейни', 'лейнів')).toBe('лейн');
  expect(uaPlural(3, 'лейн', 'лейни', 'лейнів')).toBe('лейни');
  expect(uaPlural(7, 'лейн', 'лейни', 'лейнів')).toBe('лейнів');
  expect(uaPlural(11, 'лейн', 'лейни', 'лейнів')).toBe('лейнів');
  expect(uaPlural(21, 'лейн', 'лейни', 'лейнів')).toBe('лейн');
});

// ── /status routing wiring ───────────────────────────────────────────────────
// The daemon cannot be booted in a unit test, so this locks the handler's
// source structure: /status (no arg) must route to the human renderer and the
// raw JSON dump must stay reachable behind `/status raw` (and /session).

test('WIRING: /status routes to the human renderer, /status raw keeps the old dump', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8');
  expect(src).toContain("from './status-summary'");
  const start = src.indexOf("cmd === '/session' || cmd === '/status'");
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, start + 3000);
  // Human path: guarded on /status without the raw argument.
  const humanGuard = block.indexOf("cmd === '/status' && arg !== 'raw'");
  const humanCall = block.indexOf('buildHumanStatus(');
  expect(humanGuard).toBeGreaterThan(-1);
  expect(humanCall).toBeGreaterThan(humanGuard);
  expect(block).toContain('await sendLong(chat_id, summary)');
  expect(block).not.toContain("lines.join('\\n')");
  // Raw path survives, after the human branch, in the same handler.
  const rawDump = block.indexOf('JSON.stringify(daemonHealth)');
  expect(rawDump).toBeGreaterThan(humanCall);
});
