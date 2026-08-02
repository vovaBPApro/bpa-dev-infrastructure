import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownerMayWrite, runSupervisor, supervise, type RecoveryState } from './supervisor';

const now = new Date('2026-08-02T20:00:00.000Z');
const fixture = (): RecoveryState => ({ lanes: [{
  id: 'lane-1', owner: 'expired-owner', generation: 4,
  leaseDeadline: '2026-08-02T19:59:00.000Z', semanticProgressAt: '2026-08-02T19:00:00.000Z',
  semanticEvidencePath: 'reports/lane-1.md', pidAlive: true,
}] });

describe('recovery regression locks', () => {
  test('stale-semantic-progress-live-pid-is-red', () => {
    const result = supervise(fixture(), now, 300_000, 'restart-owner');
    expect(result.state.lanes[0]).toMatchObject({ pidAlive: true, verdict: 'NO-GO', blocker: 'stale-semantic-progress' });
    expect(result.escalations).toHaveLength(1);
  });

  test('restart-fences-expired-owner', () => {
    const lane = supervise(fixture(), now, 300_000, 'restart-owner').state.lanes[0];
    expect(lane).toMatchObject({ owner: 'restart-owner', generation: 5 });
    expect(ownerMayWrite(lane, 'expired-owner', 4, now)).toBeFalse();
    expect(ownerMayWrite(lane, 'restart-owner', 5, now)).toBeTrue();
  });

  test('independent-escalation-is-durable-outbox-record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'v3-supervisor-'));
    try {
      const statePath = join(root, 'state.json');
      const outboxPath = join(root, 'outbox.jsonl');
      await writeFile(statePath, JSON.stringify(fixture()));
      await runSupervisor(statePath, outboxPath, now, 300_000, 'restart-owner');
      const row = JSON.parse((await readFile(outboxPath, 'utf8')).trim());
      expect(row).toMatchObject({ id: 'stale-semantic-progress:lane-1:5', verdict: 'NO-GO', laneId: 'lane-1' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
