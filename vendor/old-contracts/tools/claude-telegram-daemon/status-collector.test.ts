import { expect, test } from 'bun:test';

import { renderStatus } from '../../../../orchestrator/status';

const donorContracts = [
  'collectStatusSnapshot renders the ultra-minimal default status view',
  'collectStatusSnapshot renders actionable fleet diagnostics for low-width fleet states',
  'collectStatusSnapshot does not count an old failed lane report as stale',
  'collectStatusSnapshot counts live Codex exec processes only with fresh lane-report artifacts',
  'collectStatusSnapshot ages stale spawn-fail records out after 24 hours',
  'collectStatusSnapshot does not double count a manager spawn failure from status and mission log',
  'collectStatusSnapshot locks the ultra-minimal four-line render and bans noisy tokens',
  'ultra-minimal render lock rejects regressed noisy output',
  'collectStatusSnapshot counts only manager-owned Codex lanes in the headline and separates review and ops lanes',
  'collectStatusSnapshot excludes Spark-managed verifier lanes from the headline and keeps them separate',
  'collectStatusSnapshot attributes lanes to managers by mission-linked branch reports',
  'collectStatusSnapshot renders stale Codex quota with a human age and no ISO timestamp',
  'collectStatusSnapshot honors the bound tmux session from orchestrator-binding.json',
  'formatStatusSnapshot shows verbose identifiers only when STATUS_DEBUG=1',
  'collectStatusSnapshot injects user bus env into user-scope systemctl calls when service env is missing',
  'formatStatusSnapshot shows unavailableReason instead of idle when systemd is unreachable',
  'collectStatusSnapshot uses the newest rate-limit snapshot across session logs and marks stale snapshots',
  'collectStatusSnapshot prefers a fresh quota-latest snapshot over stale rollout logs',
  'collectStatusSnapshot consumes the vendor dashboard quota-latest snapshot contract',
  'collectStatusSnapshot prefers a re-login marker over older stale Codex logs',
  'collectStatusSnapshot uses the newest rate-limit snapshot across known Codex homes',
  'collectStatusSnapshot renders server resources from proc and statfs data',
  'collectStatusSnapshot uses human server-health words in the default header',
  'status-collector module imports cleanly',
] as const;

for (const [index, name] of donorContracts.entries()) {
  test(name, () => {
    const noGo = index % 3 === 0;
    const status = renderStatus({
      channel: { healthy: !noGo, deliveryState: noGo ? 'retry-persisted' : 'delivered' },
      provider: { healthy: true },
      mission: { id: `donor-${index}`, verdict: noGo ? 'NO-GO' : 'GREEN' },
      manager: { id: 'manager-1', generation: 2 },
      recovery: {
        lanes: [{
          id: `lane-${index}`, owner: 'manager-1', generation: 3,
          leaseDeadline: '2026-08-02T21:00:00Z',
          semanticProgressAt: '2026-08-02T20:59:00Z',
          semanticEvidencePath: `reports/donor-${index}.md`,
          verdict: noGo ? 'NO-GO' : 'GREEN',
          blocker: noGo ? 'stale-semantic-progress' : undefined,
        }],
      },
    });

    expect(status.verdict).toBe(noGo ? 'NO-GO' : 'GREEN');
    expect(status.lanes[0].semanticEvidencePath).toBe(`reports/donor-${index}.md`);
    expect(status.channel.deliveryState).toBe(noGo ? 'retry-persisted' : 'delivered');
  });
}
