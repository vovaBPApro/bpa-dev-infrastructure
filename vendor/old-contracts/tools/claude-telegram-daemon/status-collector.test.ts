import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  collectStatusSnapshot,
  formatStatusSnapshot,
  type CommandRunner,
} from './status-collector';
import { buildVendorQuotaSnapshotEvent } from './vendor-quota-scraper';

function minutesAgoIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function commandRunner(
  responses: Record<string, { out: string; ok: boolean }>,
): CommandRunner {
  return async (cmd: string) => responses[cmd] ?? { out: '', ok: false };
}

function prepareRuntime(homeDir: string): string {
  const runtimeDir = join(
    homeDir,
    '.claude',
    'channels',
    'telegram',
    'daemon',
    'runtime',
  );
  mkdirSync(join(runtimeDir, 'lane-reports'), { recursive: true });
  mkdirSync(join(runtimeDir, 'manager-missions'), { recursive: true });
  return runtimeDir;
}

function baseStatusCommands(): Record<string, { out: string; ok: boolean }> {
  return {
    "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
      ok: true,
      out: '',
    },
    "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
      ok: true,
      out: '',
    },
    "systemctl --user list-units 'bpa-worker-*' --no-legend --plain": {
      ok: true,
      out: '',
    },
    'tmux list-sessions': {
      ok: true,
      out: '',
    },
  };
}

function renderStatus(snapshot: Awaited<ReturnType<typeof collectStatusSnapshot>>): string {
  return formatStatusSnapshot(snapshot).join('\n');
}

function expectRenderWithoutDebugNoise(rendered: string): void {
  expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  expect(rendered).not.toContain('supervisor — activating');
}

function withStatusDebug<T>(enabled: boolean, run: () => T): T {
  const previous = process.env.STATUS_DEBUG;
  if (enabled) {
    process.env.STATUS_DEBUG = '1';
  } else {
    delete process.env.STATUS_DEBUG;
  }

  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.STATUS_DEBUG;
    } else {
      process.env.STATUS_DEBUG = previous;
    }
  }
}

test('collectStatusSnapshot renders the ultra-minimal default status view', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-'));
  const runtimeDir = prepareRuntime(homeDir);
  const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '07', '10');
  const laneOneStartedAt = minutesAgoIso(90);
  const laneTwoStartedAt = minutesAgoIso(80);
  const directStartedAt = minutesAgoIso(45);

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'latest.jsonl'),
    [
      '{"timestamp":"2026-07-10T09:30:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":14.6,"window_minutes":300,"resets_at":1783679400},"secondary":{"used_percent":7,"window_minutes":10080,"resets_at":1784280600},"plan_type":"pro"}}}',
    ].join('\n'),
  );

  writeFileSync(
    join(runtimeDir, 'manager-missions', 'fq3-structure.md'),
    [
      '---',
      'mission_id: fq3-structure',
      'goal: Закрити B116.1 status tree',
      'status_label: B116.1 статус-дерево',
      'allowed_lanes: 2',
      '---',
      '',
      '## Ordered Work Items',
      '- lane one',
      '- lane two',
    ].join('\n'),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-owned-one.json'),
    JSON.stringify({
      branch: 'ag-owned-one',
      lane: 'ag-owned-one',
      model: 'gpt-5.5',
      mission_id: 'fq3-structure',
      provider: 'codex',
      started_at: laneOneStartedAt,
      status: 'working',
      task_hint: 'owned lane one',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-owned-two.json'),
    JSON.stringify({
      branch: 'ag-owned-two',
      lane: 'ag-owned-two',
      model: 'gpt-5.5',
      mission_id: 'fq3-structure',
      provider: 'codex',
      started_at: laneTwoStartedAt,
      prompt_subject: 'owned lane two',
      status: 'launched',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-direct-one.json'),
    JSON.stringify({
      branch: 'ag-direct-one',
      lane: 'ag-direct-one',
      model: 'gpt-5.5-mini',
      provider: 'codex',
      started_at: directStartedAt,
      status: 'working',
      task_hint: 'direct lane one',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-done-but-still-listed.json'),
    JSON.stringify({
      branch: 'ag-done-but-still-listed',
      lane: 'ag-done-but-still-listed',
      model: 'gpt-5.5',
      provider: 'codex',
      started_at: minutesAgoIso(30),
      status: 'done',
      task_hint: 'should not render',
    }),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-manager-pilot-fq3-structure.service loaded active running manager-pilot',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: [
          'bpa-lane-owned-one.service loaded active running lane',
          'bpa-lane-owned-two.service loaded active running lane',
          'bpa-lane-direct-one.service loaded active running lane',
          'bpa-lane-done-but-still-listed.service loaded active running lane',
        ].join('\n'),
      },
      "systemctl --user list-units 'bpa-worker-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-worker-bill.service loaded active running bill-worker',
      },
      'tmux list-sessions': {
        ok: true,
        out: 'master-orchestrator: 1 windows\nscratch: 1 windows',
      },
    }),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-10T10:00:00.000Z') },
  );

  expect(snapshot.counts).toEqual({
    activeAgentCount: 5,
    managedLaneCount: 2,
    managerCount: 1,
    serviceWorkerCount: 1,
    totalLaneCount: 3,
  });
  expect(snapshot.managers.items[0]?.missionId).toBe('fq3-structure');
  expect(snapshot.managers.items[0]?.lanes.map((lane) => lane.laneName)).toEqual([
    'ag-owned-one',
    'ag-owned-two',
  ]);
  expect(snapshot.directLanes.items.map((lane) => lane.laneName)).toEqual([
    'ag-direct-one',
  ]);
  expect(snapshot.managers.items[0]?.statusLabel).toBe('B116.1 статус-дерево');
  expect(snapshot.quotas[0]?.snapshot.primaryRemainingPercent).toBe(85.4);
  expect(snapshot.quotas[0]?.snapshot.stale).toBe(false);

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain('📊 2/9 Codex-кодерів під менеджерами · 1 менеджер · сервер ок');
  expect(rendered).toContain('🧠 Fable — керує · tmux master-orchestrator');
  expect(rendered).toContain('• B116.1 статус-дерево · 1 год');
  expect(rendered).toContain('• Окремо: coder 1');
  expect(rendered).toContain('• coder — direct lane one · 45 хв');
  expect(rendered).toContain('💳 Codex ~85% · оновлено 30 хв тому · Claude ок');
  expect(rendered).toContain('🖥️ Hetzner — load');
  expect(rendered).not.toContain('bill — активний');
  expect(rendered).not.toContain('Кодер:');
  expect(rendered).not.toContain('Менеджер:');
  expect(rendered).not.toContain('працюють');
  expect(rendered).not.toContain('ag-done-but-still-listed');
  expect(rendered).not.toContain('gpt-5.5');
  expect(rendered).not.toContain('claude-opus-4-8');
});

test('collectStatusSnapshot renders actionable fleet diagnostics for low-width fleet states', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-fleet-diag-'));
  const runtimeDir = prepareRuntime(homeDir);
  const now = Date.now();
  const activeLaneAt = new Date(now - 60 * 1000).toISOString();
  const staleLaneAt = new Date(now - 20 * 60 * 1000).toISOString();
  const doneLaneAt = new Date(now - 3 * 60 * 1000).toISOString();
  const staleHeartbeatPath = join(runtimeDir, 'manager-heartbeats', 'fq-stale.beat');

  mkdirSync(join(runtimeDir, 'manager-heartbeats'), { recursive: true });
  mkdirSync(join(runtimeDir, 'manager-status'), { recursive: true });
  mkdirSync(join(homeDir, '.claude'), { recursive: true });
  writeFileSync(staleHeartbeatPath, '');
  utimesSync(staleHeartbeatPath, new Date(now - 12 * 60 * 1000), new Date(now - 12 * 60 * 1000));
  writeFileSync(
    join(homeDir, '.claude', 'auto_approve.json'),
    JSON.stringify({
      autonomy: {
        vendor_quota: {
          anthropic: 'thin',
          openai: 'ok',
        },
      },
    }),
  );
  writeFileSync(
    join(runtimeDir, 'manager-status', 'fq-dead.json'),
    JSON.stringify({
      mission_id: 'fq-dead',
      overall_status: 'FAILED',
      reason: 'manager-unit-inactive-before-rollup',
      updated_at: new Date(now - 5 * 60 * 1000).toISOString(),
    }),
  );
  writeFileSync(
    join(runtimeDir, 'manager-status', 'fq-spawn.json'),
    JSON.stringify({
      mission_id: 'fq-spawn',
      overall_status: 'FAILED',
      reason: 'failed_to_spawn',
      updated_at: new Date(now - 4 * 60 * 1000).toISOString(),
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-active.json'),
    JSON.stringify({
      branch: 'ag-active',
      lane: 'ag-active',
      mission_id: 'fq-active',
      provider: 'codex',
      started_at: activeLaneAt,
      status: 'working',
      task_hint: 'active coder',
      updated_at: activeLaneAt,
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-stale.json'),
    JSON.stringify({
      branch: 'ag-stale',
      lane: 'ag-stale',
      mission_id: 'fq-active',
      provider: 'codex',
      started_at: staleLaneAt,
      status: 'working',
      task_hint: 'stale coder',
      updated_at: staleLaneAt,
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-done.json'),
    JSON.stringify({
      branch: 'ag-done',
      lane: 'ag-done',
      mission_id: 'fq-active',
      provider: 'codex',
      started_at: doneLaneAt,
      status: 'done',
      task_hint: 'done coder',
      updated_at: doneLaneAt,
    }),
  );

  const fileSystem = {
    exists: (path: string): boolean =>
      path === join(homeDir, '.claude', 'auto_approve.json') ||
      path.startsWith(runtimeDir),
    listFiles: (rootDir: string, extension: string): string[] => {
      if (rootDir === join(runtimeDir, 'lane-reports')) {
        return [
          join(runtimeDir, 'lane-reports', 'ag-active.json'),
          join(runtimeDir, 'lane-reports', 'ag-stale.json'),
          join(runtimeDir, 'lane-reports', 'ag-done.json'),
        ].filter((path) => path.endsWith(extension));
      }
      if (rootDir === join(runtimeDir, 'manager-status')) {
        return [
          join(runtimeDir, 'manager-status', 'fq-dead.json'),
          join(runtimeDir, 'manager-status', 'fq-spawn.json'),
        ].filter((path) => path.endsWith(extension));
      }
      if (rootDir === join(runtimeDir, 'manager-heartbeats')) {
        return [staleHeartbeatPath].filter((path) => path.endsWith(extension));
      }
      if (rootDir === '/tmp') {
        return ['/tmp/ag-zero.log', '/tmp/ag-spawn.log'].filter((path) =>
          path.endsWith(extension),
        );
      }
      return [];
    },
    modifiedAt: (path: string): number | null => {
      if (path === staleHeartbeatPath) return now - 12 * 60 * 1000;
      if (path === '/tmp/ag-zero.log') return now - 10 * 60 * 1000;
      if (path === '/tmp/ag-spawn.log') return now - 8 * 60 * 1000;
      return null;
    },
    readFile: (path: string): string => {
      if (path === join(homeDir, '.claude', 'auto_approve.json')) {
        return JSON.stringify({
          autonomy: {
            vendor_quota: {
              anthropic: 'thin',
              openai: 'ok',
            },
          },
        });
      }
      if (path === '/tmp/ag-zero.log') {
        return '=== zero EXIT rc=0 commits=0 dirty=0 Sun Jul 12 10:00:00 UTC 2026 ===';
      }
      if (path === '/tmp/ag-spawn.log') {
        return 'FATAL: lane=spawn provider=codex model=gpt-5.5 spawn failed: could not launch detached lane runner';
      }
      return readFileSync(path, 'utf8');
    },
  };

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      ...baseStatusCommands(),
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: [
          'bpa-manager-pilot-fq-active.service loaded active running manager-pilot',
          'bpa-manager-pilot-fq-stale.service loaded active running manager-pilot',
        ].join('\n'),
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: [
          'bpa-lane-active.service loaded active running lane',
          'bpa-lane-stale.service loaded active running lane',
          'bpa-lane-done.service loaded active running lane',
        ].join('\n'),
      },
    }),
    homeDir,
    fileSystem,
    { now },
  );

  expect(snapshot.fleetDiagnostics.managerCounts).toEqual({
    active: 1,
    dead: 2,
    stale: 1,
  });
  expect(snapshot.fleetDiagnostics.codexLaneCounts).toEqual({
    active: 1,
    done: 1,
    stale: 1,
  });
  expect(snapshot.fleetDiagnostics.logSignals).toEqual({
    spawnFailures: 2,
    zeroCommitExits: 1,
  });
  expect(snapshot.fleetDiagnostics.providerMode).toBe('Codex-only degraded');

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain(
    '• Fleet · managers active 1/stale 1/dead 2 · codex lanes active 1/stale 1/done 1 · zero-commit 1 · spawn-fail 2 · mode Codex-only degraded · fresh 1 хв тому',
  );
});

test('collectStatusSnapshot does not count an old failed lane report as stale', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-failed-terminal-'));
  const runtimeDir = prepareRuntime(homeDir);
  const oldTimestamp = '2020-01-01T00:00:00.000Z';
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-failed.json'),
    JSON.stringify({
      branch: 'ag-failed',
      lane: 'ag-failed',
      provider: 'codex',
      started_at: oldTimestamp,
      status: 'failed',
      updated_at: oldTimestamp,
    }),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner(baseStatusCommands()),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-17T12:00:00.000Z') },
  );

  expect(snapshot.fleetDiagnostics.codexLaneCounts).toEqual({
    active: 0,
    done: 1,
    stale: 0,
  });
});

test('collectStatusSnapshot counts live Codex exec processes only with fresh lane-report artifacts', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-live-codex-'));
  const runtimeDir = prepareRuntime(homeDir);
  const now = Date.parse('2026-07-18T20:15:00.000Z');
  const freshOne = join(runtimeDir, 'lane-reports', 'ag-fresh-one.json');
  const freshTwo = join(runtimeDir, 'lane-reports', 'ag-fresh-two.json');
  const stale = join(runtimeDir, 'lane-reports', 'ag-stale.json');

  for (const [path, lane] of [[freshOne, 'ag-fresh-one'], [freshTwo, 'ag-fresh-two'], [stale, 'ag-stale']] as const) {
    writeFileSync(path, JSON.stringify({ lane, mission_id: 'm268-live-wave', provider: 'codex', status: 'working', updated_at: '2026-07-09T00:00:00.000Z' }));
  }

  const fileSystem = {
    exists: (path: string): boolean => path.startsWith(runtimeDir),
    listFiles: (rootDir: string, extension: string): string[] => rootDir === join(runtimeDir, 'lane-reports') ? [freshOne, freshTwo, stale].filter((path) => path.endsWith(extension)) : [],
    modifiedAt: (path: string): number | null => path === stale ? now - 11 * 60 * 1000 : path === freshOne || path === freshTwo ? now - 2 * 60 * 1000 : null,
    readFile: (path: string): string => readFileSync(path, 'utf8'),
  };

  const snapshot = await collectStatusSnapshot(commandRunner({
    ...baseStatusCommands(),
    "pgrep -af 'codex exec'": { ok: true, out: '101 codex exec --lane one\n102 codex exec --lane two' },
    "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": { ok: true, out: 'bpa-manager-pilot-m268-live-wave.service loaded active running manager-pilot' },
  }), homeDir, fileSystem, { now });

  expect(snapshot.counts.managedLaneCount).toBe(2);
  expect(snapshot.fleetDiagnostics.codexLaneCounts).toEqual({ active: 2, done: 0, stale: 1 });
});

test('collectStatusSnapshot ages stale spawn-fail records out after 24 hours', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-old-spawn-'));
  const runtimeDir = prepareRuntime(homeDir);
  const now = Date.parse('2026-07-18T20:15:00.000Z');
  const statusPath = join(runtimeDir, 'manager-status', 'm268-old.json');
  const logPath = join(runtimeDir, 'manager-missions', 'm268-old.log');
  mkdirSync(join(runtimeDir, 'manager-status'), { recursive: true });
  writeFileSync(statusPath, JSON.stringify({ mission_id: 'm268-old', overall_status: 'FAILED', reason: 'failed_to_spawn', updated_at: '2026-07-10T20:15:00.000Z' }));
  writeFileSync(logPath, 'spawn failed before detached runner started');

  const fileSystem = {
    exists: (path: string): boolean => path.startsWith(runtimeDir),
    listFiles: (rootDir: string, extension: string): string[] => rootDir === join(runtimeDir, 'manager-status') ? [statusPath].filter((path) => path.endsWith(extension)) : rootDir === join(runtimeDir, 'manager-missions') ? [logPath].filter((path) => path.endsWith(extension)) : [],
    modifiedAt: (path: string): number | null => path === logPath ? now - 8 * 24 * 60 * 60 * 1000 : null,
    readFile: (path: string): string => readFileSync(path, 'utf8'),
  };

  const snapshot = await collectStatusSnapshot(commandRunner(baseStatusCommands()), homeDir, fileSystem, { now });
  expect(snapshot.fleetDiagnostics.logSignals.spawnFailures).toBe(0);
});

test('collectStatusSnapshot does not double count a manager spawn failure from status and mission log', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-spawn-dedupe-'));
  const runtimeDir = prepareRuntime(homeDir);
  const now = Date.now();
  const failedAt = new Date(now - 4 * 60 * 1000).toISOString();
  const missionLogPath = join(runtimeDir, 'manager-missions', 'fq-spawn.log');

  mkdirSync(join(runtimeDir, 'manager-status'), { recursive: true });
  writeFileSync(
    join(runtimeDir, 'manager-status', 'fq-spawn.json'),
    JSON.stringify({
      mission_id: 'fq-spawn',
      overall_status: 'FAILED',
      reason: 'failed_to_spawn',
      updated_at: failedAt,
    }),
  );
  writeFileSync(
    missionLogPath,
    'manager spawn failed for mission fq-spawn before the timeout and never reached confirmed spawn',
  );

  const fileSystem = {
    exists: (path: string): boolean => path.startsWith(runtimeDir),
    listFiles: (rootDir: string, extension: string): string[] => {
      if (rootDir === join(runtimeDir, 'lane-reports')) {
        return [];
      }
      if (rootDir === join(runtimeDir, 'manager-status')) {
        return [join(runtimeDir, 'manager-status', 'fq-spawn.json')].filter((path) =>
          path.endsWith(extension),
        );
      }
      if (rootDir === join(runtimeDir, 'manager-heartbeats')) {
        return [];
      }
      if (rootDir === join(runtimeDir, 'manager-missions')) {
        return [missionLogPath].filter((path) => path.endsWith(extension));
      }
      if (rootDir === '/tmp') {
        return [];
      }
      return [];
    },
    modifiedAt: (path: string): number | null => {
      if (path === missionLogPath) return now - 4 * 60 * 1000;
      return null;
    },
    readFile: (path: string): string => readFileSync(path, 'utf8'),
  };

  const snapshot = await collectStatusSnapshot(
    commandRunner(baseStatusCommands()),
    homeDir,
    fileSystem,
    { now },
  );

  expect(snapshot.fleetDiagnostics.logSignals).toEqual({
    spawnFailures: 1,
    zeroCommitExits: 0,
  });
});

test('collectStatusSnapshot locks the ultra-minimal four-line render and bans noisy tokens', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-lock-'));
  const runtimeDir = prepareRuntime(homeDir);
  const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '07', '10');
  const ownedStartedAt = minutesAgoIso(28);
  const reviewStartedAt = minutesAgoIso(12);
  const staleQuotaCapturedAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, 'manager-missions', 'fq11-wide-harness.md'),
    [
      '---',
      'mission_id: fq11-wide-harness',
      'goal: Stage stand slice',
      'status_label: стейджинг-стенд (зріз dev→staging)',
      '---',
    ].join('\n'),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-owned-render.json'),
    JSON.stringify({
      branch: 'ag-owned-render',
      lane: 'ag-owned-render',
      mission_id: 'fq11-wide-harness',
      provider: 'codex',
      started_at: ownedStartedAt,
      status: 'working',
      task_hint: 'owned render lane',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-ui-review.json'),
    JSON.stringify({
      branch: 'ag-ui-review',
      lane: 'ag-ui-review',
      provider: 'codex',
      started_at: reviewStartedAt,
      status: 'working',
      task_hint: 'UI: імпорт QuickBooks — на перевірці',
    }),
  );
  writeFileSync(
    join(sessionDir, 'latest.jsonl'),
    [
      `{"timestamp":"${staleQuotaCapturedAt}","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":15,"window_minutes":300,"resets_at":1783679400},"secondary":{"used_percent":7,"window_minutes":10080,"resets_at":1784280600},"plan_type":"pro"}}}`,
    ].join('\n'),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      ...baseStatusCommands(),
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-manager-pilot-fq11-wide-harness.service loaded active running manager-pilot',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: [
          'bpa-lane-owned-render.service loaded active running lane',
          'bpa-lane-ui-review.service loaded active running lane',
        ].join('\n'),
      },
    }),
    homeDir,
  );

  expect(snapshot.managers.items[0]?.lanes.map((lane) => lane.branch)).toEqual([
    'ag-owned-render',
  ]);
  expect(snapshot.directLanes.items.map((lane) => lane.branch)).toEqual([
    'ag-ui-review',
  ]);

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));
  expect(rendered).toContain('📊 1/9 Codex-кодерів під менеджерами · 1 менеджер · сервер ок');
  expect(rendered).toContain('🧠 Fable — очікує · tmux master-orchestrator');
  expect(rendered).toContain('• стейджинг-стенд (зріз dev→staging) · 28 хв');
  expect(rendered).toContain('• Окремо: review 1');
  expect(rendered).toContain('• review — UI: імпорт QuickBooks — на перевірці · 12 хв');
  expect(rendered).toContain('💳 Codex ~85% stale · останнє відоме доба тому · Claude ок');
  expectRenderWithoutDebugNoise(rendered);
});

test('ultra-minimal render lock rejects regressed noisy output', () => {
  const regressed = [
    '📊 1/9 Codex-кодерів під менеджерами · 1 менеджер · сервер ок (4.31/16)',
    '• стейджинг-стенд (зріз dev→staging) · 2026-07-10T08:32:00.000Z',
    '• supervisor — activating · 0 кодери',
    '💳 Codex ~85% · Claude ок',
  ].join('\n');

  expect(() => expectRenderWithoutDebugNoise(regressed)).toThrow();
});

test('collectStatusSnapshot counts only manager-owned Codex lanes in the headline and separates review and ops lanes', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-b184-'));
  const runtimeDir = prepareRuntime(homeDir);

  writeFileSync(
    join(runtimeDir, 'manager-missions', 'fq24-b184.md'),
    [
      '---',
      'mission_id: fq24-b184',
      'status_label: B184 /status telemetry',
      '---',
    ].join('\n'),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-owned-coder.json'),
    JSON.stringify({
      branch: 'ag-owned-coder',
      lane: 'ag-owned-coder',
      mission_id: 'fq24-b184',
      model: 'gpt-5.4',
      provider: 'codex',
      started_at: minutesAgoIso(21),
      status: 'working',
      task_hint: 'headline coder',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-review.json'),
    JSON.stringify({
      branch: 'ag-review',
      lane: 'ag-review',
      mission_id: 'fq24-b184',
      model: 'claude-opus-4-8',
      provider: 'claude',
      started_at: minutesAgoIso(18),
      status: 'working',
      task_hint: 'Claude lock review',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-direct-coder.json'),
    JSON.stringify({
      branch: 'ag-direct-coder',
      lane: 'ag-direct-coder',
      model: 'gpt-5.4',
      provider: 'codex',
      started_at: minutesAgoIso(12),
      status: 'working',
      task_hint: 'standalone codex lane',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-ops.json'),
    JSON.stringify({
      branch: 'ag-ops',
      lane: 'ag-ops',
      model: 'unknown-model',
      provider: 'unknown',
      started_at: minutesAgoIso(9),
      status: 'working',
      task_hint: 'ops maintenance',
    }),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      ...baseStatusCommands(),
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-manager-pilot-fq24-b184.service loaded active running manager-pilot',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: [
          'bpa-lane-owned-coder.service loaded active running lane',
          'bpa-lane-review.service loaded active running lane',
          'bpa-lane-direct-coder.service loaded active running lane',
          'bpa-lane-ops.service loaded active running lane',
        ].join('\n'),
      },
    }),
    homeDir,
  );

  expect(snapshot.counts.managedLaneCount).toBe(1);
  expect(snapshot.counts.totalLaneCount).toBe(4);
  expect(snapshot.managers.items[0]?.lanes.map((lane) => lane.branch)).toEqual([
    'ag-owned-coder',
  ]);
  expect(snapshot.directLanes.items.map((lane) => lane.branch)).toEqual([
    'ag-review',
    'ag-direct-coder',
    'ag-ops',
  ]);

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain('📊 1/9 Codex-кодерів під менеджерами · 1 менеджер · сервер ок');
  expect(rendered).toContain('• B184 /status telemetry');
  expect(rendered).toContain('• Окремо: coder 1 · review 1 · ops 1');
  expect(rendered).toContain('• review — Claude lock review · 18 хв');
  expect(rendered).toContain('• coder — standalone codex lane · 12 хв');
  expect(rendered).toContain('• ops — ops maintenance · 9 хв');
});

test('collectStatusSnapshot excludes Spark-managed verifier lanes from the headline and keeps them separate', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-b184-spark-'));
  const runtimeDir = prepareRuntime(homeDir);

  writeFileSync(
    join(runtimeDir, 'manager-missions', 'fq34-b184.md'),
    [
      '---',
      'mission_id: fq34-b184',
      'status_label: B184 spark lock',
      '---',
    ].join('\n'),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-managed-coder.json'),
    JSON.stringify({
      branch: 'ag-managed-coder',
      lane: 'ag-managed-coder',
      mission_id: 'fq34-b184',
      model: 'gpt-5.4',
      provider: 'codex',
      started_at: minutesAgoIso(24),
      status: 'working',
      task_hint: 'manager child coder',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-b184lock.json'),
    JSON.stringify({
      branch: 'ag-b184lock',
      lane: 'ag-b184lock',
      mission_id: 'fq34-b184',
      model: 'gpt-5.3-codex-spark',
      provider: 'codex',
      started_at: minutesAgoIso(19),
      status: 'working',
      task_hint: 'Spark lock-review verifier',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-claude-review.json'),
    JSON.stringify({
      branch: 'ag-claude-review',
      lane: 'ag-claude-review',
      mission_id: 'fq34-b184',
      model: 'claude-opus-4-8',
      provider: 'claude',
      started_at: minutesAgoIso(15),
      status: 'working',
      task_hint: 'Claude review lane',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-direct-ops.json'),
    JSON.stringify({
      branch: 'ag-direct-ops',
      lane: 'ag-direct-ops',
      model: 'gpt-5.4',
      provider: 'codex',
      started_at: minutesAgoIso(11),
      status: 'working',
      task_hint: 'ops maintenance lane',
    }),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      ...baseStatusCommands(),
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-manager-pilot-fq34-b184.service loaded active running manager-pilot',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: [
          'bpa-lane-managed-coder.service loaded active running lane',
          'bpa-lane-b184lock.service loaded active running lane',
          'bpa-lane-claude-review.service loaded active running lane',
          'bpa-lane-direct-ops.service loaded active running lane',
        ].join('\n'),
      },
    }),
    homeDir,
  );

  expect(snapshot.counts.managedLaneCount).toBe(1);
  expect(snapshot.managers.items[0]?.lanes.map((lane) => lane.branch)).toEqual([
    'ag-managed-coder',
  ]);
  expect(snapshot.directLanes.items.map((lane) => lane.branch)).toEqual([
    'ag-b184lock',
    'ag-claude-review',
    'ag-direct-ops',
  ]);

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain('📊 1/9 Codex-кодерів під менеджерами · 1 менеджер · сервер ок');
  expect(rendered).toContain('• B184 spark lock');
  expect(rendered).toContain('• Окремо: review 2 · ops 1');
  expect(rendered).toContain('• review — Spark lock-review verifier · 19 хв');
  expect(rendered).toContain('• review — Claude review lane · 15 хв');
  expect(rendered).toContain('• ops — ops maintenance lane · 11 хв');
  expect(rendered).not.toContain('📊 2/9 Codex-кодерів під менеджерами');
  expect(rendered).not.toContain('• coder — Spark lock-review verifier');
});

test('collectStatusSnapshot attributes lanes to managers by mission-linked branch reports', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-attribution-'));
  const runtimeDir = prepareRuntime(homeDir);

  writeFileSync(
    join(runtimeDir, 'manager-missions', 'fq8-status-round3.md'),
    [
      '---',
      'mission_id: fq8-status-round3',
      'goal: Fix /status human readability',
      'status_label: /status — третій захід',
      '---',
    ].join('\n'),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-owned-alpha.json'),
    JSON.stringify({
      branch: 'ag-owned-alpha',
      lane: 'ag-statusr3',
      mission_id: 'fq8-status-round3',
      provider: 'codex',
      started_at: minutesAgoIso(28),
      status: 'working',
      task_hint: 'owned alpha',
    }),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-owned-beta.json'),
    JSON.stringify({
      branch: 'ag-owned-beta',
      lane: 'ag-statusr3-review',
      mission_id: 'fq8-status-round3',
      provider: 'codex',
      started_at: minutesAgoIso(18),
      status: 'working',
      task_hint: 'owned beta',
    }),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      ...baseStatusCommands(),
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-manager-pilot-fq8-status-round3.service loaded active running manager-pilot',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: [
          'bpa-lane-owned-alpha.service loaded active running lane',
          'bpa-lane-owned-beta.service loaded active running lane',
        ].join('\n'),
      },
    }),
    homeDir,
  );

  expect(snapshot.counts.managedLaneCount).toBe(2);
  expect(snapshot.managers.items[0]?.lanes.map((lane) => lane.branch)).toEqual([
    'ag-owned-alpha',
    'ag-owned-beta',
  ]);
  expect(snapshot.directLanes.items).toHaveLength(0);

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain('📊 2/9 Codex-кодерів під менеджерами · 1 менеджер');
  expect(rendered).toContain('• /status — третій захід');
  expect(rendered).not.toContain('• owned alpha');
  expect(rendered).not.toContain('• owned beta');
});

test('collectStatusSnapshot renders stale Codex quota with a human age and no ISO timestamp', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-stale-'));
  const runtimeDir = prepareRuntime(homeDir);
  const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '07', '10');

  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, 'manager-missions', 'fq8-status-round3.md'),
    ['---', 'mission_id: fq8-status-round3', 'status_label: staging stand', '---'].join(
      '\n',
    ),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-stage.json'),
    JSON.stringify({
      branch: 'ag-stage',
      lane: 'ag-stage',
      mission_id: 'fq8-status-round3',
      provider: 'codex',
      started_at: minutesAgoIso(28),
      status: 'working',
      task_hint: 'staging stand',
    }),
  );
  writeFileSync(
    join(sessionDir, 'latest.jsonl'),
    [
      '{"timestamp":"2026-07-10T08:19:18.335Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":15,"window_minutes":300,"resets_at":1783660800},"secondary":{"used_percent":8,"window_minutes":10080,"resets_at":1784280600},"plan_type":"pro"}}}',
    ].join('\n'),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      ...baseStatusCommands(),
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-manager-pilot-fq8-status-round3.service loaded active running manager-pilot',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-lane-stage.service loaded active running lane',
      },
    }),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-10T10:30:00.000Z') },
  );

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain('💳 Codex ~85% stale · останнє відоме');
  expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('collectStatusSnapshot honors the bound tmux session from orchestrator-binding.json', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-binding-'));
  const runtimeDir = prepareRuntime(homeDir);

  writeFileSync(
    join(runtimeDir, 'orchestrator-binding.json'),
    JSON.stringify({
      provider: 'claude',
      session_id: '',
      bound_chat_id: '83769716',
      tmux_session: 'fable-escalation',
      bound_at: '2026-07-10T08:00:00.000Z',
      updated_at: '2026-07-10T08:00:00.000Z',
      state_version: 1,
    }),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      "systemctl --user list-units 'bpa-worker-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      'tmux list-sessions': {
        ok: true,
        out: 'fable-escalation: 1 windows\nscratch: 1 windows',
      },
    }),
    homeDir,
  );

  expect(snapshot.orchestrator).toEqual({
    model: 'claude-fable-5',
    provider: 'claude',
    sessionName: 'fable-escalation',
    startedAt: null,
    taskHint: 'waiting',
    unavailableReason: null,
    working: true,
  });
});

test('formatStatusSnapshot shows verbose identifiers only when STATUS_DEBUG=1', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-debug-'));
  const runtimeDir = prepareRuntime(homeDir);
  const laneStartedAt = minutesAgoIso(12);

  writeFileSync(
    join(runtimeDir, 'manager-missions', 'fq6-20260710-status-readability.md'),
    [
      '---',
      'mission_id: fq6-20260710-status-readability',
      'goal: Make Telegram /status easier to read, remove dense English',
      '---',
    ].join('\n'),
  );
  writeFileSync(
    join(runtimeDir, 'lane-reports', 'ag-statusux.json'),
    JSON.stringify({
      branch: 'ag-statusux',
      lane: 'ag-statusux',
      model: 'gpt-5.5',
      mission_id: 'fq6-20260710-status-readability',
      provider: 'codex',
      started_at: laneStartedAt,
      status: 'working',
      task_hint: 'Polish /status readability for Telegram',
    }),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-manager-pilot-fq6-20260710-status-readability.service loaded active running manager-pilot',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: 'bpa-lane-statusux.service loaded active running lane',
      },
      "systemctl --user list-units 'bpa-worker-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      'tmux list-sessions': {
        ok: true,
        out: 'master-orchestrator: 1 windows',
      },
      "systemctl --user show 'bpa-manager-pilot-fq6-20260710-status-readability.service' --property ActiveEnterTimestamp --value": {
        ok: true,
        out: laneStartedAt,
      },
      "systemctl --user show 'bpa-lane-statusux.service' --property ActiveEnterTimestamp --value": {
        ok: true,
        out: laneStartedAt,
      },
    }),
    homeDir,
  );

  const defaultRendered = withStatusDebug(false, () => renderStatus(snapshot));
  expect(defaultRendered).toContain(
    '📊 1/9 Codex-кодерів під менеджерами · 1 менеджер · сервер ок',
  );
  expect(defaultRendered).toContain(
    '🧠 Fable — керує · tmux master-orchestrator',
  );
  expect(defaultRendered).toContain(
    '• Make Telegram /status easier to read, r… · 12 хв',
  );
  expect(defaultRendered).not.toContain('gpt-5.5');
  expect(defaultRendered).not.toContain(
    'bpa-manager-pilot-fq6-20260710-status-readability.service',
  );

  const debugRendered = withStatusDebug(true, () => renderStatus(snapshot));
  expect(debugRendered).toContain('claude/claude-opus-4-8');
  expect(debugRendered).toContain('codex/gpt-5.5');
  expect(debugRendered).toContain('master-orchestrator');
  expect(debugRendered).toContain(
    'bpa-manager-pilot-fq6-20260710-status-readability.service',
  );
});

test('collectStatusSnapshot injects user bus env into user-scope systemctl calls when service env is missing', async () => {
  const invocations: Array<{
    cmd: string;
    env?: Record<string, string | undefined>;
  }> = [];
  const runner: CommandRunner = async (cmd, options) => {
    invocations.push({ cmd, env: options?.env });
    return { ok: true, out: '' };
  };

  await collectStatusSnapshot(runner, mkdtempSync(join(tmpdir(), 'status-env-')), undefined, {
    env: {},
    uid: 1000,
  });

  const systemctlCalls = invocations.filter((entry) =>
    entry.cmd.startsWith('systemctl --user list-units'),
  );
  expect(systemctlCalls).toHaveLength(3);
  for (const call of systemctlCalls) {
    expect(call.env?.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    expect(call.env?.DBUS_SESSION_BUS_ADDRESS).toBe(
      'unix:path=/run/user/1000/bus',
    );
  }
  expect(invocations.find((entry) => entry.cmd === 'tmux list-sessions')?.env).toBe(
    undefined,
  );
});

test('formatStatusSnapshot shows unavailableReason instead of idle when systemd is unreachable', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-empty-'));

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: false,
        out: 'Failed to connect to bus: No medium found',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: false,
        out: 'Failed to connect to bus: No medium found',
      },
      "systemctl --user list-units 'bpa-worker-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      'tmux list-sessions': {
        ok: false,
        out: 'no server running on /tmp/tmux-1000/default',
      },
    }),
    homeDir,
  );

  expect(snapshot.managers.unavailableReason).toBe(
    'Failed to connect to bus: No medium found',
  );
  expect(snapshot.directLanes.unavailableReason).toBe(
    'Failed to connect to bus: No medium found',
  );
  expect(snapshot.workers.items).toEqual([]);
  expect(snapshot.orchestrator.unavailableReason).toBe(
    'no server running on /tmp/tmux-1000/default',
  );
  expect(snapshot.quotas[0]?.snapshot.summary).toBe(
    'n/a (нема локальних логів сесій)',
  );
  expect(snapshot.quotas[1]?.snapshot.summary).toBe(
    'n/a (CLI/local state не показує live залишок квоти)',
  );

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));
  expect(rendered).toContain('📊 0/9 Codex-кодерів під менеджерами · 0 менеджери · сервер ок');
  expect(rendered).toContain(
    '🧠 Fable — недоступний: no server running on /tmp/tmux-1000/default · tmux master-orchestrator',
  );
  expect(rendered).toContain('• Failed to connect to bus: No medium found');
  expect(rendered).not.toContain('└─ idle');

  const debugRendered = withStatusDebug(true, () => renderStatus(snapshot));
  expect(debugRendered).toContain(
    '└─ error: Failed to connect to bus: No medium found',
  );
  expect(debugRendered).not.toContain('└─ idle');
});

test('collectStatusSnapshot uses the newest rate-limit snapshot across session logs and marks stale snapshots', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-quota-'));
  const earlySessionDir = join(homeDir, '.codex', 'sessions', '2026', '07', '09');
  const latestSessionDir = join(homeDir, '.codex', 'sessions', '2026', '07', '10');

  mkdirSync(earlySessionDir, { recursive: true });
  mkdirSync(latestSessionDir, { recursive: true });
  writeFileSync(
    join(earlySessionDir, 'older.jsonl'),
    [
      '{"timestamp":"2026-07-09T07:00:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":80,"window_minutes":300,"resets_at":1783584000},"secondary":{"used_percent":20,"window_minutes":10080,"resets_at":1784203200},"plan_type":"pro"}}}',
    ].join('\n'),
  );
  writeFileSync(
    join(latestSessionDir, 'newest.jsonl'),
    [
      '{"timestamp":"2026-07-10T09:30:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":14,"window_minutes":300,"resets_at":1783679400},"secondary":{"used_percent":7,"window_minutes":10080,"resets_at":1784280600},"plan_type":"pro"}}}',
    ].join('\n'),
  );

  const freshSnapshot = await collectStatusSnapshot(
    commandRunner({
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      "systemctl --user list-units 'bpa-worker-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      'tmux list-sessions': {
        ok: true,
        out: '',
      },
    }),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-10T10:00:00.000Z') },
  );

  expect(freshSnapshot.quotas[0]?.snapshot.summary).toContain(
    '5h 86% left until 2026-07-10T10:30:00.000Z',
  );
  expect(freshSnapshot.quotas[0]?.snapshot.primaryRemainingPercent).toBe(86);
  expect(freshSnapshot.quotas[0]?.snapshot.stale).toBe(false);

  const staleSnapshot = await collectStatusSnapshot(
    commandRunner({
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      "systemctl --user list-units 'bpa-worker-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      'tmux list-sessions': {
        ok: true,
        out: '',
      },
    }),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-10T11:00:00.000Z') },
  );

  expect(staleSnapshot.quotas[0]?.snapshot.summary).toBe(
    '~86% stale; оновлено 1 год тому [local log]',
  );
  expect(staleSnapshot.quotas[0]?.snapshot.primaryRemainingPercent).toBe(86);
  expect(staleSnapshot.quotas[0]?.snapshot.stale).toBe(true);
});

test('collectStatusSnapshot prefers a fresh quota-latest snapshot over stale rollout logs', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-quota-latest-'));
  const staleSessionDir = join(homeDir, '.codex', 'sessions', '2026', '07', '09');
  const quotaFile = join(homeDir, '.codex', 'quota-latest.jsonl');

  mkdirSync(staleSessionDir, { recursive: true });
  writeFileSync(
    join(staleSessionDir, 'older.jsonl'),
    [
      '{"timestamp":"2026-07-09T08:19:18.335Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":7,"window_minutes":300,"resets_at":1783596212},"secondary":{"used_percent":37,"window_minutes":10080,"resets_at":1783995312},"plan_type":"pro"}}}',
    ].join('\n'),
  );
  writeFileSync(
    quotaFile,
    [
      '{"timestamp":"2026-07-10T08:44:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":14,"window_minutes":300,"resets_at":1783679400},"secondary":{"used_percent":7,"window_minutes":10080,"resets_at":1784280600},"plan_type":"pro"}}}',
    ].join('\n'),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner(baseStatusCommands()),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-10T09:00:00.000Z') },
  );

  expect(snapshot.quotas[0]?.snapshot.summary).toContain(
    'оновлено 16 хв тому [local log]',
  );
  expect(snapshot.quotas[0]?.snapshot.summary).toContain(
    '5h 86% left until 2026-07-10T10:30:00.000Z',
  );
  expect(snapshot.quotas[0]?.snapshot.summary).toContain(
    '7d 93% left until 2026-07-17T09:30:00.000Z',
  );
  expect(snapshot.quotas[0]?.snapshot.primaryRemainingPercent).toBe(86);

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain(
    '💳 Codex ~86% · оновлено 16 хв тому · Claude ок',
  );
});

test('collectStatusSnapshot consumes the vendor dashboard quota-latest snapshot contract', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-vendor-snapshot-'));
  const quotaFile = join(homeDir, '.codex', 'quota-latest.jsonl');

  mkdirSync(join(homeDir, '.codex'), { recursive: true });
  writeFileSync(
    quotaFile,
    `${JSON.stringify(
      buildVendorQuotaSnapshotEvent(
        {
          creditsLabel: '$42.50',
          fetchedAt: '2026-07-10T12:00:00.000Z',
          loginState: 'authenticated',
          primaryUsedPercent: 80,
          secondaryUsedPercent: 92,
          sparkPrimaryUsedPercent: 77,
          sparkSecondaryUsedPercent: 87,
        },
        {
          creditsLabel: '$17.00',
          fableUsedPercent: 36,
          fetchedAt: '2026-07-10T12:00:00.000Z',
          loginState: 'authenticated',
          sessionUsedPercent: 30,
          weeklyUsedPercent: 27,
        },
        '2026-07-10T12:00:00.000Z',
      ),
    )}\n`,
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner(baseStatusCommands()),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-10T12:30:00.000Z') },
  );

  expect(snapshot.quotas[0]?.snapshot.summary).toContain(
    '5h 20% left',
  );
  expect(snapshot.quotas[0]?.snapshot.summary).toContain(
    'Spark 5h 77% used',
  );
  expect(snapshot.quotas[0]?.snapshot.summary).toContain('credits $42.50');
  expect(snapshot.quotas[1]?.snapshot.summary).toContain('session 30% used');
  expect(snapshot.quotas[1]?.snapshot.summary).toContain('Fable 36% used');
  expect(snapshot.quotas[1]?.snapshot.summary).toContain('credits $17.00');
  expect(snapshot.quotas[0]?.snapshot.primaryRemainingPercent).toBe(20);

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain(
    '💳 Codex ~20% · оновлено 30 хв тому · Claude live',
  );
});

test('collectStatusSnapshot prefers a re-login marker over older stale Codex logs', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-vendor-relogin-'));
  const staleSessionDir = join(homeDir, '.codex', 'sessions', '2026', '07', '09');
  const quotaFile = join(homeDir, '.codex', 'quota-latest.jsonl');

  mkdirSync(staleSessionDir, { recursive: true });
  writeFileSync(
    join(staleSessionDir, 'older.jsonl'),
    [
      '{"timestamp":"2026-07-09T08:19:18.335Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":7,"window_minutes":300,"resets_at":1783596212},"secondary":{"used_percent":37,"window_minutes":10080,"resets_at":1783995312},"plan_type":"pro"}}}',
    ].join('\n'),
  );
  writeFileSync(
    quotaFile,
    [
      JSON.stringify({
        timestamp: '2026-07-10T12:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'vendor_quota_snapshot',
          vendor_quotas: {
            codex: {
              creditsLabel: null,
              fetchedAt: '2026-07-10T12:00:00.000Z',
              loginState: 'relogin-needed',
              primaryUsedPercent: null,
              secondaryUsedPercent: null,
              sparkPrimaryUsedPercent: null,
              sparkSecondaryUsedPercent: null,
            },
            claude: {
              creditsLabel: null,
              fableUsedPercent: null,
              fetchedAt: '2026-07-10T12:00:00.000Z',
              loginState: 'relogin-needed',
              sessionUsedPercent: null,
              weeklyUsedPercent: null,
            },
          },
        },
      }),
    ].join('\n'),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner(baseStatusCommands()),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-10T12:30:00.000Z') },
  );

  expect(snapshot.quotas[0]?.snapshot.summary).toBe(
    'сесія протермінована — треба перелогінитись',
  );
  expect(snapshot.quotas[0]?.snapshot.primaryRemainingPercent).toBeNull();
  expect(snapshot.quotas[1]?.snapshot.summary).toBe(
    'сесія протермінована — треба перелогінитись',
  );

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain('Claude сесія протермінована');
  expect(rendered).not.toContain('~93%');
});

test('collectStatusSnapshot uses the newest rate-limit snapshot across known Codex homes', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-codex-homes-'));
  const staleSessionDir = join(homeDir, '.codex', 'sessions', '2026', '07', '09');
  const freshSessionDir = join(
    homeDir,
    'agents',
    'agent-bill',
    '.codex',
    'sessions',
    '2026',
    '07',
    '10',
  );

  mkdirSync(staleSessionDir, { recursive: true });
  mkdirSync(freshSessionDir, { recursive: true });
  writeFileSync(
    join(staleSessionDir, 'older.jsonl'),
    [
      '{"timestamp":"2026-07-09T08:19:18.335Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":7,"window_minutes":300,"resets_at":1783596212},"secondary":{"used_percent":37,"window_minutes":10080,"resets_at":1783995312},"plan_type":"pro"}}}',
    ].join('\n'),
  );
  writeFileSync(
    join(freshSessionDir, 'newer.jsonl'),
    [
      '{"timestamp":"2026-07-10T08:44:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":14,"window_minutes":300,"resets_at":1783679400},"secondary":{"used_percent":7,"window_minutes":10080,"resets_at":1784280600},"plan_type":"pro"}}}',
    ].join('\n'),
  );

  const snapshot = await collectStatusSnapshot(
    commandRunner({
      "systemctl --user list-units 'bpa-manager-pilot-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      "systemctl --user list-units 'bpa-lane-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      "systemctl --user list-units 'bpa-worker-*' --no-legend --plain": {
        ok: true,
        out: '',
      },
      'tmux list-sessions': {
        ok: true,
        out: '',
      },
    }),
    homeDir,
    undefined,
    { now: Date.parse('2026-07-10T09:00:00.000Z') },
  );

  expect(snapshot.quotas[0]?.snapshot.summary).toContain(
    '5h 86% left until 2026-07-10T10:30:00.000Z',
  );
  expect(snapshot.quotas[0]?.snapshot.summary).toContain(
    '7d 93% left until 2026-07-17T09:30:00.000Z',
  );
  expect(snapshot.quotas[0]?.snapshot.primaryRemainingPercent).toBe(86);
});

test('collectStatusSnapshot renders server resources from proc and statfs data', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-resources-'));
  const fileSystem = {
    exists: (path: string): boolean => path === '/proc/meminfo' || path === '/proc/loadavg',
    listFiles: (): string[] => [],
    readFile: (path: string): string => {
      if (path === '/proc/meminfo') {
        return ['MemTotal:       31457280 kB', 'MemAvailable:   25165824 kB'].join('\n');
      }
      if (path === '/proc/loadavg') {
        return '1.03 0.80 0.61 1/123 456';
      }
      throw new Error(`unexpected read: ${path}`);
    },
    statFs: (path: string) => {
      if (path === '/') {
        return {
          bavail: 84 * 1024 * 1024,
          blocks: 301 * 1024 * 1024,
          bsize: 1024,
        };
      }
      if (path === '/tmp') {
        return {
          bavail: 30 * 1024,
          blocks: 100 * 1024,
          bsize: 1024,
        };
      }
      throw new Error(`unexpected statfs: ${path}`);
    },
  };

  const snapshot = await collectStatusSnapshot(
    commandRunner(baseStatusCommands()),
    homeDir,
    fileSystem,
    {
      cpuCount: 16,
      now: Date.parse('2026-07-10T09:00:00.000Z'),
    },
  );

  const rendered = withStatusDebug(false, () => renderStatus(snapshot));

  expect(rendered).toContain('📊 0/9 Codex-кодерів під менеджерами · 0 менеджери · сервер ок');
  expect(rendered).toContain('🧠 Fable — очікує · tmux master-orchestrator');
  expect(rendered).toContain('💳 Codex нема даних · Claude ок');
  expect(rendered).toContain('Ресурси сервера:');
  expect(rendered).toContain('- RAM: 6 з 30 GB зайнято, 24 GB доступно');
  expect(rendered).toContain('- CPU: load ~1.0 на 16 ядер');
  expect(rendered).toContain('- Диск: 217/301 GB (72%), вільно 84 GB');
  expect(rendered).toContain('- /tmp: 70% використано');
});

test('collectStatusSnapshot uses human server-health words in the default header', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'status-collector-resource-words-'));
  const pressureFileSystem = {
    exists: (path: string): boolean => path === '/proc/meminfo' || path === '/proc/loadavg',
    listFiles: (): string[] => [],
    readFile: (path: string): string => {
      if (path === '/proc/meminfo') {
        return ['MemTotal:       1000 kB', 'MemAvailable:   100 kB'].join('\n');
      }
      if (path === '/proc/loadavg') {
        return '12.00 10.00 8.00 1/123 456';
      }
      throw new Error(`unexpected read: ${path}`);
    },
    statFs: () => ({
      bavail: 50,
      blocks: 100,
      bsize: 1024,
    }),
  };

  const pressureSnapshot = await collectStatusSnapshot(
    commandRunner(baseStatusCommands()),
    homeDir,
    pressureFileSystem,
    { cpuCount: 16 },
  );
  const pressureRendered = withStatusDebug(false, () => renderStatus(pressureSnapshot));

  expect(pressureRendered).toContain('📊 0/9 Codex-кодерів під менеджерами · 0 менеджери · серверу важко');
  expect(pressureRendered).not.toContain('сервер навантажений');

  const diskFileSystem = {
    exists: (): boolean => false,
    listFiles: (): string[] => [],
    readFile: (): string => {
      throw new Error('unexpected read');
    },
    statFs: (path: string) => {
      if (path === '/') {
        return {
          bavail: 10,
          blocks: 100,
          bsize: 1024,
        };
      }
      if (path === '/tmp') {
        return {
          bavail: 100,
          blocks: 100,
          bsize: 1024,
        };
      }
      throw new Error(`unexpected statfs: ${path}`);
    },
  };

  const diskSnapshot = await collectStatusSnapshot(
    commandRunner(baseStatusCommands()),
    homeDir,
    diskFileSystem,
  );
  const diskRendered = withStatusDebug(false, () => renderStatus(diskSnapshot));

  expect(diskRendered).toContain('📊 0/9 Codex-кодерів під менеджерами · 0 менеджери · сервер диск 90%!');
  expect(diskRendered).not.toContain('сервер /tmp');
  expect(diskRendered).not.toContain('сервер disk');
});

test('status-collector module imports cleanly', async () => {
  const module = await import('./status-collector');

  expect(typeof module.collectStatusSnapshot).toBe('function');
  expect(typeof module.formatStatusSnapshot).toBe('function');
});
