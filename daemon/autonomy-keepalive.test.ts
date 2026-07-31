import { expect, test } from 'bun:test';
import {
  AutonomyKeepalive,
  hasOpenWorkboardRows,
  parseFleetConfig,
  parseSystemdLaneUnits,
} from './autonomy-keepalive';

const OPEN_WORKBOARD = `# Workboard\n\n## Open\n\n- **ML-2 — autonomy keep-alive**: pending. *lane*\n`;

test('fleet config reads floor and interval with a 15-minute default', () => {
  expect(parseFleetConfig('fleet:\n  floor: 6\n')).toEqual({
    floor: 6,
    intervalMs: 900_000,
  });
  expect(
    parseFleetConfig('fleet:\n  floor: 4\n  keepalive_interval_minutes: 2\n'),
  ).toEqual({ floor: 4, intervalMs: 120_000 });
});

test('system lane census uses SYSTEM systemd unit state', () => {
  const units = parseSystemdLaneUnits(
    'lane-alpha.service loaded active running Alpha lane\n' +
      'lane-dirty.service loaded failed failed Dirty lane\n',
  );
  expect(units).toEqual([
    { name: 'lane-alpha.service', active: true },
    { name: 'lane-dirty.service', active: false },
  ]);
});

test('REGRESSION ML-2: timer nudges with open rows and zero running lanes', async () => {
  const nudges: string[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 6,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => [],
    nudge: async (message) => void nudges.push(message),
  });

  await keepalive.timerTick();

  expect(nudges).toHaveLength(1);
  expect(nudges[0]).toContain('fleet below floor: 0/6');
});

test('dirty-dead lane with no exit event is still caught by timer level', async () => {
  const nudges: string[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 2,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => [{ name: 'lane-dirty.service', active: false }],
    nudge: async (message) => void nudges.push(message),
  });

  // No eventTick call: this models a dirty death whose exit transition was lost.
  await keepalive.timerTick();

  expect(nudges).toHaveLength(1);
  expect(nudges[0]).toContain('0/2');
});

test('event level nudges once when a running lane exits', async () => {
  const nudges: string[] = [];
  let units = [{ name: 'lane-alpha.service', active: true }];
  const keepalive = new AutonomyKeepalive({
    floor: 1,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => units,
    nudge: async (message) => void nudges.push(message),
  });

  await keepalive.eventTick();
  units = [{ name: 'lane-alpha.service', active: false }];
  await keepalive.eventTick();
  await keepalive.eventTick();

  expect(nudges).toEqual(['lane alpha finished; inspect evidence and continue dispatch']);
});

test('closed-only workboard and a full fleet stay quiet', async () => {
  expect(hasOpenWorkboardRows('## Open\n- **W-1 — CLOSED**: landed.')).toBe(false);
  const nudges: string[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 1,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => [{ name: 'lane-alpha.service', active: true }],
    nudge: async (message) => void nudges.push(message),
  });
  await keepalive.timerTick();
  expect(nudges).toEqual([]);
});
