import { expect, test } from 'bun:test';
import {
  normalizeRelayPayload,
  parseClaudeStopPayload,
  parseCodexNotifyPayload,
} from './reliability';

test('normalizes Claude Stop payloads', () => {
  expect(
    parseClaudeStopPayload({
      session_id: 'claude-session',
      turn_id: 'turn-1',
      cwd: '/tmp/project',
      transcript_path: '/tmp/transcript.jsonl',
      last_assistant_message: 'done',
    }),
  ).toEqual({
    provider: 'claude',
    session_id: 'claude-session',
    turn_id: 'turn-1',
    cwd: '/tmp/project',
    transcript_path: '/tmp/transcript.jsonl',
    assistant_text: 'done',
    source: 'claude_stop_hook',
  });
});

test('normalizes Codex notify payloads', () => {
  expect(
    parseCodexNotifyPayload({
      type: 'agent-turn-complete',
      'thread-id': 'codex-thread',
      'turn-id': 'turn-2',
      cwd: '/tmp/project',
      'last-assistant-message': 'done',
    }),
  ).toEqual({
    provider: 'codex',
    session_id: 'codex-thread',
    turn_id: 'turn-2',
    cwd: '/tmp/project',
    assistant_text: 'done',
    source: 'codex_notify',
  });
});

test('blank assistant text is preserved for daemon no-op rejection', () => {
  const normalized = normalizeRelayPayload({
    type: 'agent-turn-complete',
    'thread-id': 'codex-thread',
    'turn-id': 'turn-3',
    cwd: '/tmp/project',
    'last-assistant-message': null,
  });
  expect(normalized?.assistant_text).toBe('');
});

test('unsupported payloads return null', () => {
  expect(normalizeRelayPayload({ foo: 'bar' })).toBeNull();
});
