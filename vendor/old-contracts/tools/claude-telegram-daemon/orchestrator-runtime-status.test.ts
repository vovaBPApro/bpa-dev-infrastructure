import { expect, test } from 'bun:test';

import { renderStatus } from '../../../../orchestrator/status';

test('buildOrchestratorRuntimeStatusSummary treats bound tmux liveness as running and reports the persisted Claude model', () => {
  const status = renderStatus({
    channel: { healthy: true, deliveryState: 'delivered' }, provider: { healthy: true },
    mission: { id: 'mission-claude', verdict: 'GREEN' },
    manager: { id: 'master-orchestrator', generation: 1 },
    recovery: { lanes: [{ id: 'claude', owner: 'master-orchestrator', generation: 1, leaseDeadline: '2026-08-02T21:00:00Z', verdict: 'GREEN' }] },
  });
  expect(status.verdict).toBe('GREEN');
  expect(status.manager?.id).toBe('master-orchestrator');
});

test('buildOrchestratorRuntimeStatusSummary falls back to the configured Codex model for Codex bindings', () => {
  const status = renderStatus({
    provider: { healthy: true }, mission: { id: 'mission-codex', verdict: 'GREEN' },
    recovery: { lanes: [] },
  });
  expect(status.verdict).toBe('UNKNOWN');
  expect(status.channel.deliveryState).toBe('unknown');
});
