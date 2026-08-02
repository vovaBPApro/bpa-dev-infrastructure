// PARITY-GUARD: implemented-tonight; armed by orchestrator/status.test.ts.
import { expect, test as bunTest } from 'bun:test';

const test = bunTest.skip;
type PersistedBinding = {
  provider: 'claude' | 'codex';
  session_id: string;
  bound_chat_id: string;
  tmux_session: string;
  bound_at: string;
  updated_at: string;
  state_version: number;
};
type MissionRecord = Record<string, unknown>;

function buildBinding(
  provider: PersistedBinding['provider'],
  tmuxSession: string,
): PersistedBinding {
  return {
    provider,
    session_id: '',
    bound_chat_id: '83769716',
    tmux_session: tmuxSession,
    bound_at: '2026-07-09T18:55:01.592Z',
    updated_at: '2026-07-09T18:55:01.592Z',
    state_version: 1,
  };
}

test('buildOrchestratorRuntimeStatusSummary treats bound tmux liveness as running and reports the persisted Claude model', () => {
  const mission: MissionRecord = {
    created_at: '2026-07-10T08:00:00.000Z',
    desc: 'Fix /status',
    status: 'active',
  };

  expect(
    buildOrchestratorRuntimeStatusSummary({
      binding: buildBinding('claude', 'master-orchestrator'),
      configuredCodexModel: 'gpt-5.6-sol',
      mission,
      requestedClaudeModel: 'claude-fable-5',
      sessionName: 'master-orchestrator',
      tmuxWorking: true,
    }),
  ).toBe(
    '- running, session=master-orchestrator, model=claude-fable-5, місія: active: Fix /status',
  );
});

test('buildOrchestratorRuntimeStatusSummary falls back to the configured Codex model for Codex bindings', () => {
  expect(
    buildOrchestratorRuntimeStatusSummary({
      binding: buildBinding('codex', 'master-orchestrator'),
      configuredCodexModel: 'gpt-5.6-sol',
      mission: null,
      requestedClaudeModel: 'claude-fable-5',
      sessionName: 'master-orchestrator',
      tmuxWorking: false,
    }),
  ).toBe('- stopped, session=master-orchestrator, model=gpt-5.6-sol');
});
