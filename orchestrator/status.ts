import type { RecoveryState } from './supervisor';

export interface StatusInput {
  channel?: { healthy?: boolean; deliveryState?: string };
  provider?: { healthy?: boolean };
  mission?: { id?: string; verdict?: string };
  manager?: { id?: string; generation?: number };
  recovery: RecoveryState;
}

export function renderStatus(input: StatusInput) {
  const lanes = input.recovery.lanes.map((lane) => ({
    id: lane.id, owner: lane.owner, generation: lane.generation,
    leaseDeadline: lane.leaseDeadline, pidAlive: lane.pidAlive ?? null,
    semanticProgressAt: lane.semanticProgressAt ?? null,
    semanticEvidencePath: lane.semanticEvidencePath ?? null,
    verdict: lane.verdict ?? 'UNKNOWN', blocker: lane.blocker ?? null,
  }));
  const knownHealthy = input.channel?.healthy === true && input.provider?.healthy === true &&
    input.mission?.verdict === 'GREEN' && lanes.length > 0 && lanes.every((lane) => lane.verdict === 'GREEN');
  return {
    verdict: knownHealthy ? 'GREEN' : lanes.some((lane) => lane.verdict === 'NO-GO') ? 'NO-GO' : 'UNKNOWN',
    channel: input.channel ?? { healthy: null, deliveryState: 'unknown' },
    provider: input.provider ?? { healthy: null }, mission: input.mission ?? { verdict: 'UNKNOWN' },
    manager: input.manager ?? null, lanes,
  };
}
