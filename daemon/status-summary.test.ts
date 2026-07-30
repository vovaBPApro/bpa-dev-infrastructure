// Tests for the human-facing /status summary (HR-150).
//
// The honesty cases are the load-bearing ones: a dead orchestrator, a stale
// heartbeat, and a timed-out git must all render as labeled «невідомо» /
// blockers — never as a fabricated "all good" and never as a crash.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveLanes, ShRunner } from './status';
import {
  HEARTBEAT_FRESH_MS,
  parseHeartbeat,
  readLastLanded,
  renderHumanStatus,
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

test('HONESTY: git-timeout renders lanes and landed as unknown with ONE git blocker', () => {
  const deps = healthyDeps();
  deps.lanes = { verified: false, reason: 'git timeout' };
  deps.lastLanded = { verified: false, reason: 'git timeout' };
  const lines = renderHumanStatus(deps);
  expect(lines).toContain('Зараз в роботі: невідомо (git: git timeout)');
  expect(lines).toContain('Останнє приземлене: невідомо (git: git timeout)');
  const blockers = lines.at(-1)!;
  expect(blockers).toContain('git недоступний (git timeout)');
  expect(blockers.split('git недоступний').length - 1).toBe(1);
  expect(blockers).not.toContain('немає');
});

test('HONESTY: missing mission source names its reason instead of faking none', () => {
  const deps = healthyDeps();
  deps.mission = { present: false, reason: 'no state DB at /x/state.db' };
  const lines = renderHumanStatus(deps);
  expect(lines[1]).toBe('Місія: невідомо (no state DB at /x/state.db)');
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
  // Raw path survives, after the human branch, in the same handler.
  const rawDump = block.indexOf('JSON.stringify(daemonHealth)');
  expect(rawDump).toBeGreaterThan(humanCall);
});
