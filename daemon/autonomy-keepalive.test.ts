import { expect, test } from 'bun:test';
import {
  AutonomyKeepalive,
  deliverAutonomyNudge,
  deliverFleetAlert,
  hasOpenWorkboardRows,
  parseFleetConfig,
  parseSystemdLaneUnits,
} from './autonomy-keepalive';

const OPEN_WORKBOARD = `# Workboard\n\n## Open\n\n- **ML-2 — autonomy keep-alive**: pending. *lane*\n`;

test('fleet config reads floor and interval with a 15-minute default', () => {
  expect(parseFleetConfig('fleet:\n  floor: 6\n')).toEqual({
    floor: 6,
    notifyHumanBelow: 1,
    intervalMs: 900_000,
  });
  expect(
    parseFleetConfig(
      'fleet:\n  floor: 4\n  notify_human_below: 3\n  keepalive_interval_minutes: 2\n',
    ),
  ).toEqual({ floor: 4, notifyHumanBelow: 3, intervalMs: 120_000 });
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
    notifyHumanBelow: 3,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => [],
    nudge: async (message) => void nudges.push(message),
    alertHuman: async () => {},
  });

  await keepalive.timerTick();

  expect(nudges).toHaveLength(1);
  expect(nudges[0]).toContain('fleet below floor: 0/6');
});

test('dirty-dead lane with no exit event is still caught by timer level', async () => {
  const nudges: string[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 2,
    notifyHumanBelow: 1,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => [{ name: 'lane-dirty.service', active: false }],
    nudge: async (message) => void nudges.push(message),
    alertHuman: async () => {},
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
    notifyHumanBelow: 1,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => units,
    nudge: async (message) => void nudges.push(message),
    alertHuman: async () => {},
  });

  await keepalive.eventTick();
  units = [{ name: 'lane-alpha.service', active: false }];
  await keepalive.eventTick();
  await keepalive.eventTick();

  expect(nudges).toEqual(['lane alpha finished; inspect evidence and continue dispatch']);
});

test('REGRESSION ML-2 delivery: tmux unavailable rejects and retries the pending exit', async () => {
  let units = [{ name: 'lane-alpha.service', active: true }];
  let available = false;
  const pasted: string[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 1,
    notifyHumanBelow: 1,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => units,
    nudge: (message) =>
      deliverAutonomyNudge(message, {
        tmuxAvailable: async () => available,
        paste: async (text) => {
          pasted.push(text);
          return true;
        },
        log: () => {},
      }),
    alertHuman: async () => {},
  });

  await keepalive.eventTick();
  units = [];
  await expect(keepalive.eventTick()).rejects.toThrow('tmux unavailable');
  available = true;
  await keepalive.eventTick();

  expect(pasted).toHaveLength(1);
  expect(pasted[0]).toContain('lane alpha finished');
});

test('REGRESSION ML-2 delivery: paste false rejects and retries the pending exit', async () => {
  let units = [{ name: 'lane-alpha.service', active: true }];
  let pasteOk = false;
  let attempts = 0;
  const keepalive = new AutonomyKeepalive({
    floor: 1,
    notifyHumanBelow: 1,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => units,
    nudge: (message) =>
      deliverAutonomyNudge(message, {
        tmuxAvailable: async () => true,
        paste: async () => {
          attempts++;
          return pasteOk;
        },
        log: () => {},
      }),
    alertHuman: async () => {},
  });

  await keepalive.eventTick();
  units = [];
  await expect(keepalive.eventTick()).rejects.toThrow('paste failed');
  pasteOk = true;
  await keepalive.eventTick();

  expect(attempts).toBe(2);
});

test('closed-only workboard and a full fleet stay quiet', async () => {
  expect(hasOpenWorkboardRows('## Open\n- **W-1 — CLOSED**: landed.')).toBe(false);
  const nudges: string[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 1,
    notifyHumanBelow: 1,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => [{ name: 'lane-alpha.service', active: true }],
    nudge: async (message) => void nudges.push(message),
    alertHuman: async () => {},
  });
  await keepalive.timerTick();
  expect(nudges).toEqual([]);
});

test('REGRESSION fleet floor: zero lanes alerts Human once with numbers and rearms after recovery', async () => {
  const alerts: string[] = [];
  let units: { name: string; active: boolean }[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 10,
    notifyHumanBelow: 3,
    readWorkboard: () => '',
    listUnits: () => units,
    nudge: async () => {},
    alertHuman: async (message) => void alerts.push(message),
  });

  await keepalive.timerTick();
  await keepalive.timerTick();
  units = [
    { name: 'lane-a.service', active: true },
    { name: 'lane-b.service', active: true },
    { name: 'lane-c.service', active: true },
  ];
  await keepalive.timerTick();
  units = [];
  await keepalive.timerTick();

  expect(alerts).toEqual([
    '0 lanes running — not enough work in flight (alert threshold: 3)',
    '0 lanes running — not enough work in flight (alert threshold: 3)',
  ]);
});

test('failed Human delivery remains armed for retry', async () => {
  let attempts = 0;
  const keepalive = new AutonomyKeepalive({
    floor: 10,
    notifyHumanBelow: 3,
    readWorkboard: () => '',
    listUnits: () => [],
    nudge: async () => {},
    alertHuman: async () => {
      attempts++;
      if (attempts === 1) throw new Error('Telegram unavailable');
    },
  });

  await expect(keepalive.timerTick()).rejects.toThrow('Telegram unavailable');
  await keepalive.timerTick();
  expect(attempts).toBe(2);
});

test('REGRESSION fleet floor fail-closed: failed census alerts Human as unknown', async () => {
  const alerts: string[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 10,
    notifyHumanBelow: 3,
    readWorkboard: () => OPEN_WORKBOARD,
    listUnits: () => {
      throw new Error('systemctl unavailable');
    },
    nudge: async () => {},
    alertHuman: async (message) => void alerts.push(message),
  });

  await keepalive.timerTick();
  expect(alerts).toEqual([
    'fleet status unknown — systemd unit census failed; treating as below alert threshold (3)',
  ]);
});

test('REGRESSION fleet floor fail-closed: failed workboard read alerts Human as unknown', async () => {
  const alerts: string[] = [];
  const keepalive = new AutonomyKeepalive({
    floor: 10,
    notifyHumanBelow: 3,
    readWorkboard: () => {
      throw new Error('read failed');
    },
    listUnits: () => [{ name: 'lane-a.service', active: true }],
    nudge: async () => {},
    alertHuman: async (message) => void alerts.push(message),
  });

  await keepalive.timerTick();
  expect(alerts[0]).toContain('workboard read failed');
});

test('REGRESSION fleet floor delivery: partial success is not loudly resent in one episode', async () => {
  const acknowledged = new Set<number>();
  const deliveries: number[] = [];
  let secondChatAvailable = false;
  const keepalive = new AutonomyKeepalive({
    floor: 10,
    notifyHumanBelow: 3,
    readWorkboard: () => '',
    listUnits: () => [],
    nudge: async () => {},
    alertHuman: (message) =>
      deliverFleetAlert(message, [101, 202], acknowledged, async (chatId) => {
        deliveries.push(chatId);
        if (chatId === 202 && !secondChatAvailable) throw new Error('unavailable');
      }),
    resetHumanAlert: () => acknowledged.clear(),
  });

  await expect(keepalive.timerTick()).rejects.toThrow('not delivered');
  secondChatAvailable = true;
  await keepalive.timerTick();
  await keepalive.timerTick();

  expect(deliveries).toEqual([101, 202, 202]);
});
