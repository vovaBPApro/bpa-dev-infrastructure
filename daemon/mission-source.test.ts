// The mission input that the dead-orchestrator alarm depends on.
//
// The fixtures below are built with the REAL writer (`core/state.ts`
// StateStore), never with hand-written rows, so a schema or state-machine
// change in the writer breaks this test instead of silently making the reader
// return null again. That null is exactly how the alarm was disarmed before.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../core/state';
import { evaluateStall, missionIsActive } from './reliability';
import { readActiveMission, resolveStateDbPath } from './mission-source';

const scratches: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mission-source-'));
  scratches.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratches.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seed(dir: string, work: (store: StateStore) => void): string {
  const path = join(dir, 'state.db');
  const store = new StateStore(path);
  try {
    work(store);
  } finally {
    store.close();
  }
  return path;
}

test('an absent state DB is reported as absent, never as "no mission"', () => {
  const result = readActiveMission(join(scratch(), 'missing.db'));
  expect(result.present).toBe(false);
  if (!result.present) expect(result.reason).toContain('no state DB at');
});

test('a corrupt state DB is reported, never silently treated as idle', () => {
  const dir = scratch();
  const path = join(dir, 'state.db');
  writeFileSync(path, 'this is not a sqlite database');
  const result = readActiveMission(path);
  expect(result.present).toBe(false);
  if (!result.present) expect(result.reason).toContain('state DB unreadable');
});

test('an empty missions table answers "no mission" without throwing', () => {
  const path = seed(scratch(), () => {});
  const result = readActiveMission(path);
  expect(result).toMatchObject({ present: true, mission: null });
});

test('a running mission is projected into the MissionRecord the alarm needs', () => {
  const path = seed(scratch(), (store) => {
    store.createMission('m-1', 'HR-101 re-arm the liveness alarm');
    store.transitionMission('m-1', 'running');
  });
  const result = readActiveMission(path);
  expect(result.present).toBe(true);
  if (!result.present) throw new Error('unreachable');
  const mission = result.mission!;
  expect(mission.desc).toBe('HR-101 re-arm the liveness alarm');
  expect(mission.status).toBe('running');
  // created_at must parse as a date: buildMissionKey and missionSummary put it
  // in front of the operator.
  expect(Number.isNaN(Date.parse(mission.created_at))).toBe(false);
  // The whole point: this record makes the watchdog non-idle.
  expect(missionIsActive(mission)).toBe(true);
});

test('terminal missions are not active work — succeeded and failed are skipped', () => {
  const path = seed(scratch(), (store) => {
    store.createMission('m-done', 'finished mission');
    store.transitionMission('m-done', 'running');
    store.transitionMission('m-done', 'succeeded');
    store.createMission('m-failed', 'failed mission');
    store.transitionMission('m-failed', 'failed');
  });
  expect(readActiveMission(path)).toMatchObject({
    present: true,
    mission: null,
  });
});

test('queued and recovering missions still count as active work', () => {
  const queued = seed(scratch(), (store) => {
    store.createMission('m-q', 'queued mission');
  });
  expect(readActiveMission(queued)).toMatchObject({
    present: true,
    mission: { status: 'queued', desc: 'queued mission' },
  });

  const recovering = seed(scratch(), (store) => {
    store.createMission('m-r', 'recovering mission');
    store.transitionMission('m-r', 'running');
    store.transitionMission('m-r', 'recovering');
  });
  expect(readActiveMission(recovering)).toMatchObject({
    present: true,
    mission: { status: 'recovering', desc: 'recovering mission' },
  });
});

test('the newest active mission wins when several are open', () => {
  let clock = 1_000;
  const path = join(scratch(), 'state.db');
  const store = new StateStore(path, { now: () => (clock += 1_000) });
  try {
    store.createMission('m-old', 'older mission');
    store.transitionMission('m-old', 'running');
    store.createMission('m-new', 'newer mission');
    store.transitionMission('m-new', 'running');
  } finally {
    store.close();
  }
  expect(readActiveMission(path)).toMatchObject({
    present: true,
    mission: { desc: 'newer mission' },
  });
});

test('reading never mutates the DB the orchestrator owns', () => {
  const path = seed(scratch(), (store) => {
    store.createMission('m-1', 'mission');
    store.transitionMission('m-1', 'running');
  });
  const before = Bun.hash(new Uint8Array(require('fs').readFileSync(path)));
  for (let i = 0; i < 5; i++) readActiveMission(path);
  const after = Bun.hash(new Uint8Array(require('fs').readFileSync(path)));
  expect(after).toBe(before);
});

test('state DB path resolution: INFRA_STATE_DB > ORCH_STATE_DB > install root', () => {
  const saved = {
    infra: process.env.INFRA_STATE_DB,
    orch: process.env.ORCH_STATE_DB,
  };
  try {
    delete process.env.INFRA_STATE_DB;
    delete process.env.ORCH_STATE_DB;
    expect(resolveStateDbPath('/install')).toBe('/install/runtime/state.db');
    process.env.ORCH_STATE_DB = '/orch/state.db';
    expect(resolveStateDbPath('/install')).toBe('/orch/state.db');
    process.env.INFRA_STATE_DB = '/infra/state.db';
    expect(resolveStateDbPath('/install')).toBe('/infra/state.db');
  } finally {
    if (saved.infra === undefined) delete process.env.INFRA_STATE_DB;
    else process.env.INFRA_STATE_DB = saved.infra;
    if (saved.orch === undefined) delete process.env.ORCH_STATE_DB;
    else process.env.ORCH_STATE_DB = saved.orch;
  }
});

// The end-to-end contract, in one assertion: writer -> reader -> alarm.
// This is what nothing checked before, and why a live-looking system could not
// alert on a dead orchestrator.
test('CONTRACT: mission written by core/mission-cli reaches evaluateStall as a fireable alarm', () => {
  const path = seed(scratch(), (store) => {
    store.createMission('m-1', 'land the lane');
    store.transitionMission('m-1', 'running');
  });
  const read = readActiveMission(path);
  if (!read.present) throw new Error('unreachable');
  const decision = evaluateStall({
    hasBinding: true,
    providerKnown: true,
    mission: read.mission,
    tmuxAlive: false,
    now: Date.now(),
    thresholdMs: 900_000,
  });
  expect(decision.state).toBe('dead');
  expect(decision.shouldAlert).toBe(true);
});
