import { expect, test } from 'bun:test';
import { renderStatus } from './status';

test('status-unknown-is-never-green', () => {
  expect(renderStatus({ recovery: { lanes: [] } }).verdict).toBe('UNKNOWN');
});

test('status-joins-semantic-evidence-and-delivery-state', () => {
  const status = renderStatus({
    channel: { healthy: false, deliveryState: 'retry-persisted' }, provider: { healthy: true },
    mission: { id: 'm1', verdict: 'NO-GO' }, manager: { id: 'mgr1', generation: 2 },
    recovery: { lanes: [{ id: 'l1', owner: 'o', generation: 3, leaseDeadline: '2026-08-02T21:00:00Z', verdict: 'NO-GO', blocker: 'stale-semantic-progress', semanticEvidencePath: 'r.md' }] },
  });
  expect(status.verdict).toBe('NO-GO');
  expect(status.channel.deliveryState).toBe('retry-persisted');
  expect(status.lanes[0].semanticEvidencePath).toBe('r.md');
});
