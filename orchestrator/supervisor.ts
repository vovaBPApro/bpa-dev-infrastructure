import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RecoveryLane {
  id: string;
  owner: string;
  generation: number;
  leaseDeadline: string;
  semanticProgressAt?: string;
  semanticEvidencePath?: string;
  pidAlive?: boolean;
  verdict?: 'GREEN' | 'NO-GO';
  blocker?: string;
}

export interface RecoveryState { lanes: RecoveryLane[]; }
export interface SupervisionResult { state: RecoveryState; escalations: Escalation[]; }
export interface Escalation {
  id: string;
  kind: 'stale-semantic-progress';
  laneId: string;
  generation: number;
  verdict: 'NO-GO';
  reason: string;
  evidencePath?: string;
  createdAt: string;
}

const millis = (value?: string) => value ? Date.parse(value) : Number.NaN;

export function supervise(state: RecoveryState, now: Date, staleAfterMs: number, newOwner: string): SupervisionResult {
  const escalations: Escalation[] = [];
  const lanes = state.lanes.map((input) => {
    const lane = { ...input };
    const leaseExpired = millis(lane.leaseDeadline) <= now.getTime();
    if (leaseExpired) {
      lane.owner = newOwner;
      lane.generation += 1;
      lane.leaseDeadline = new Date(now.getTime() + staleAfterMs).toISOString();
    }
    const progressAt = millis(lane.semanticProgressAt);
    const stale = !Number.isFinite(progressAt) || now.getTime() - progressAt > staleAfterMs;
    if (stale) {
      lane.verdict = 'NO-GO';
      lane.blocker = 'stale-semantic-progress';
      escalations.push({
        id: `stale-semantic-progress:${lane.id}:${lane.generation}`,
        kind: 'stale-semantic-progress', laneId: lane.id, generation: lane.generation,
        verdict: 'NO-GO', reason: 'semantic progress is stale or missing',
        evidencePath: lane.semanticEvidencePath, createdAt: now.toISOString(),
      });
    }
    return lane;
  });
  return { state: { lanes }, escalations };
}

export function ownerMayWrite(lane: RecoveryLane, owner: string, generation: number, now: Date): boolean {
  return lane.owner === owner && lane.generation === generation && millis(lane.leaseDeadline) > now.getTime();
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function runSupervisor(statePath: string, outboxPath: string, now: Date, staleAfterMs: number, newOwner: string) {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as RecoveryState;
  const result = supervise(state, now, staleAfterMs, newOwner);
  await atomicJson(statePath, result.state);
  if (result.escalations.length) {
    await mkdir(dirname(outboxPath), { recursive: true });
    await appendFile(outboxPath, result.escalations.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  }
  return result;
}

if (import.meta.main) {
  const [statePath, outboxPath] = process.argv.slice(2);
  if (!statePath || !outboxPath) throw new Error('usage: supervisor.ts STATE_JSON OUTBOX_JSONL');
  await runSupervisor(statePath, outboxPath, new Date(), Number(process.env.ORCH_STALE_AFTER_MS ?? 300_000), process.env.ORCH_OWNER ?? `supervisor-${process.pid}`);
}
