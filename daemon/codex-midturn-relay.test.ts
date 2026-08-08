import { expect, test } from 'bun:test';
import {
  CODEX_HEARTBEAT_AFTER_MS,
  CODEX_PROGRESS_INTERVAL_MS,
  CODEX_STILL_WORKING,
  CodexMidTurnRelay,
  codexFinalEditTarget,
  runCodexMidTurnLoop,
  shouldStartCodexMidTurnRelay,
  startCodexRelayAfterPaste,
} from './codex-midturn-relay';
import {
  decideRelay,
  fenceAcceptedTerminalPending,
  type PendingReply,
  type PersistedBinding,
} from './reliability';

function pending(id = 'request-1'): PendingReply {
  return {
    chatId: 'chat-1',
    messageId: 42,
    inboundText: 'please continue',
    opened_at: 1_000,
    pending_request_id: id,
    baseline_assistant_chunk: 'old output',
  };
}

function fixture() {
  let current: PendingReply | undefined = pending();
  let now = 1_000;
  let chunk: string | null = null;
  const sent: string[] = [];
  const failures: string[] = [];
  let nextMessageId = 700;
  const relay = new CodexMidTurnRelay({
    getPending: () => current,
    extract: async () => chunk,
    send: async (_entry, body) => {
      sent.push(body);
      return nextMessageId++;
    },
    now: () => now,
    failure: (message) => failures.push(message),
  });
  return {
    relay,
    sent,
    failures,
    get current() {
      return current;
    },
    set current(value: PendingReply | undefined) {
      current = value;
    },
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
    set chunk(value: string | null) {
      chunk = value;
    },
  };
}

test('mid-turn relay is Codex-only and leaves Claude routing unchanged', () => {
  expect(shouldStartCodexMidTurnRelay('codex')).toBe(true);
  expect(shouldStartCodexMidTurnRelay('codex', false)).toBe(false);
  expect(shouldStartCodexMidTurnRelay('claude')).toBe(false);
  expect(shouldStartCodexMidTurnRelay(undefined)).toBe(false);
});

test('paste failure starts no relay while buffered paste success starts exactly once', () => {
  const starts: string[] = [];
  expect(
    startCodexRelayAfterPaste('codex', false, 'buffer-chat', (id) =>
      starts.push(id),
    ),
  ).toBe(false);
  expect(starts).toEqual([]);
  expect(
    startCodexRelayAfterPaste('codex', true, 'buffer-chat', (id) =>
      starts.push(id),
    ),
  ).toBe(true);
  expect(starts).toEqual(['buffer-chat']);
  expect(
    startCodexRelayAfterPaste('claude', true, 'buffer-chat', (id) =>
      starts.push(id),
    ),
  ).toBe(false);
});

test('no parseable chunk gets one truthful heartbeat before five minutes', async () => {
  const f = fixture();
  f.now = 1_000 + CODEX_HEARTBEAT_AFTER_MS - 1;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('idle');
  f.now++;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(f.sent).toEqual([CODEX_STILL_WORKING]);
  expect(f.current?.relay_message_id).toBe(700);
});

test('first meaningful chunk is immediate and later progress sends a new update at ninety seconds', async () => {
  const f = fixture();
  f.chunk = 'first progress';
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  f.chunk = 'newest progress';
  f.now = 1_000 + CODEX_PROGRESS_INTERVAL_MS - 1;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('idle');
  f.now++;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(f.sent).toEqual(['first progress', 'newest progress']);
  expect(f.current?.relay_message_id).toBeUndefined();
});

test('first meaningful chunk sends a new notification after an earlier heartbeat', async () => {
  const f = fixture();
  f.now = 1_000 + CODEX_HEARTBEAT_AFTER_MS;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  f.chunk = 'now there is real progress';
  f.now++;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(f.sent).toEqual([CODEX_STILL_WORKING, 'now there is real progress']);
});

test('an early preview cannot suppress repeated four-minute heartbeats', async () => {
  const f = fixture();
  f.chunk = 'early progress';
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  f.chunk = 'early progress';
  f.now = 1_000 + CODEX_HEARTBEAT_AFTER_MS;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  f.now = 1_000 + CODEX_HEARTBEAT_AFTER_MS * 2;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(f.sent).toEqual([
    'early progress',
    CODEX_STILL_WORKING,
    CODEX_STILL_WORKING,
  ]);
  expect(f.current?.midturn_message_count).toBe(3);
  expect(codexFinalEditTarget(f.current)).toBeUndefined();
});

test('repeated identical chunks never flood Telegram', async () => {
  const f = fixture();
  f.chunk = 'same progress';
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  f.now = 1_000 + CODEX_PROGRESS_INTERVAL_MS * 2;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('idle');
  expect(f.sent).toHaveLength(1);
});

test('chunk whitespace is normalized before repeat comparison', async () => {
  const f = fixture();
  f.chunk = '  same progress  ';
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(f.sent).toEqual(['same progress']);
  f.chunk = '\n same progress\t';
  f.now = 1_000 + CODEX_PROGRESS_INTERVAL_MS;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('idle');
  expect(f.sent).toHaveLength(1);
});

test('overlapping ticks claim one send slot', async () => {
  let release!: (value: string | null) => void;
  const entry = pending();
  const sent: string[] = [];
  const relay = new CodexMidTurnRelay({
    getPending: () => entry,
    extract: () => new Promise((resolve) => (release = resolve)),
    send: async (_pending, body) => {
      sent.push(body);
      return 88;
    },
    now: () => 1_000,
    failure: () => {},
  });
  const first = relay.tick('chat-1', 'request-1');
  expect(await relay.tick('chat-1', 'request-1')).toBe('busy');
  release('one progress');
  expect(await first).toBe('sent');
  expect(sent).toEqual(['one progress']);
});

test('Telegram send failure is loud and retries without closing the slot', async () => {
  const entry = pending();
  let attempts = 0;
  const failures: string[] = [];
  const relay = new CodexMidTurnRelay({
    getPending: () => entry,
    extract: async () => 'progress',
    send: async () => {
      attempts++;
      if (attempts === 1) throw new Error('network down');
      return 91;
    },
    now: () => 1_000,
    failure: (message) => failures.push(message),
  });
  expect(await relay.tick('chat-1', 'request-1')).toBe('retry');
  expect(entry.fallback_sent).toBeUndefined();
  expect(failures[0]).toContain('network down');
  expect(await relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(attempts).toBe(2);
});

test('assistant extraction failure is loud and retries', async () => {
  const entry = pending();
  let attempts = 0;
  const failures: string[] = [];
  const relay = new CodexMidTurnRelay({
    getPending: () => entry,
    extract: async () => {
      attempts++;
      if (attempts === 1) throw new Error('pane unavailable');
      return 'recovered progress';
    },
    send: async () => 93,
    now: () => 1_000,
    failure: (message) => failures.push(message),
  });
  expect(await relay.tick('chat-1', 'request-1')).toBe('retry');
  expect(failures[0]).toContain('pane unavailable');
  expect(await relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(attempts).toBe(2);
});

test('a later Telegram progress-send failure retains prior state and retries', async () => {
  const entry = pending();
  entry.relay_message_id = 99;
  entry.reply_source = 'auto_relay';
  entry.last_relayed_chunk = 'prior';
  entry.midturn_last_sent_at = 1_000;
  entry.midturn_message_count = 1;
  let attempts = 0;
  const failures: string[] = [];
  const relay = new CodexMidTurnRelay({
    getPending: () => entry,
    extract: async () => 'new progress',
    send: async () => {
      attempts++;
      if (attempts === 1) throw new Error('send unavailable');
      return 100;
    },
    now: () => 1_000 + CODEX_PROGRESS_INTERVAL_MS,
    failure: (message) => failures.push(message),
  });
  expect(await relay.tick('chat-1', 'request-1')).toBe('retry');
  expect(entry.last_relayed_chunk).toBe('prior');
  expect(failures[0]).toContain('send unavailable');
  expect(await relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(entry.last_relayed_chunk).toBe('new progress');
  expect(entry.midturn_message_count).toBe(2);
  expect(entry.relay_message_id).toBeUndefined();
  expect(attempts).toBe(2);
});

test('a newer inbound cannot inherit an older in-flight relay', async () => {
  let current = pending();
  let release!: (value: string | null) => void;
  const sent: string[] = [];
  const relay = new CodexMidTurnRelay({
    getPending: () => current,
    extract: () => new Promise((resolve) => (release = resolve)),
    send: async (_pending, body) => {
      sent.push(body);
      return 92;
    },
    now: () => 1_000,
    failure: () => {},
  });
  const oldTick = relay.tick('chat-1', 'request-1');
  current = pending('request-2');
  release('old progress');
  expect(await oldTick).toBe('inactive');
  expect(sent).toHaveLength(0);
  expect(current.relay_message_id).toBeUndefined();
});

test('approval failure retries before the terminal owner release', async () => {
  const entry = pending();
  let sleeps = 0;
  let approvals = 0;
  let ticks = 0;
  const failures: string[] = [];
  await runCodexMidTurnLoop('chat-1', {
    getPending: () => entry,
    sleep: async () => {
      sleeps++;
    },
    failureDelayMs: 0,
    tick: async () => {
      ticks++;
      entry.replied_at = 9_000;
      return 'idle';
    },
    maybeApproval: async () => {
      approvals++;
      if (approvals === 1) throw new Error('approval capture failed');
      return false;
    },
    maybeDecision: async () => false,
    failure: (message) => failures.push(message),
  });
  expect(approvals).toBe(2);
  expect(ticks).toBe(1);
  expect(failures.some((message) => message.includes('approval capture failed'))).toBe(true);
  expect(entry.fast_relay_started).toBe(false);
});

test('decision failure retries before the terminal owner release', async () => {
  const entry = pending();
  let sleeps = 0;
  let decisions = 0;
  let ticks = 0;
  const failures: string[] = [];
  await runCodexMidTurnLoop('chat-1', {
    getPending: () => entry,
    sleep: async () => {
      sleeps++;
    },
    failureDelayMs: 0,
    tick: async () => {
      ticks++;
      entry.replied_at = 9_000;
      return 'idle';
    },
    maybeApproval: async () => false,
    maybeDecision: async () => {
      decisions++;
      if (decisions === 1) throw new Error('decision capture failed');
      return false;
    },
    failure: (message) => failures.push(message),
  });
  expect(decisions).toBe(2);
  expect(ticks).toBe(1);
  expect(failures.some((message) => message.includes('decision capture failed'))).toBe(true);
  expect(entry.fast_relay_started).toBe(false);
});

test('a thrown owner sleep after preview is retried and a later heartbeat still sends', async () => {
  const entry = pending();
  entry.relay_message_id = 77;
  entry.reply_source = 'auto_relay';
  entry.last_relayed_chunk = 'preview';
  entry.midturn_last_sent_at = 1_000;
  entry.midturn_message_count = 1;
  entry.fallback_sent = true;
  const sent: string[] = [];
  const failures: string[] = [];
  let sleeps = 0;
  const relay = new CodexMidTurnRelay({
    getPending: () => entry,
    extract: async () => 'preview',
    send: async (_pending, body) => {
      sent.push(body);
      return 78;
    },
    now: () => 1_000 + CODEX_HEARTBEAT_AFTER_MS,
    failure: (message) => failures.push(message),
  });
  await runCodexMidTurnLoop('chat-1', {
    getPending: () => entry,
    sleep: async () => {
      sleeps++;
      if (sleeps === 1) throw new Error('owner sleep died');
      if (sleeps === 3) entry.replied_at = 10_000;
    },
    failureDelayMs: 0,
    tick: (chatId, requestId) => relay.tick(chatId, requestId),
    maybeApproval: async () => false,
    maybeDecision: async () => false,
    failure: (message) => failures.push(message),
  });
  expect(failures.some((message) => message.includes('owner sleep died'))).toBe(true);
  expect(sent).toEqual([CODEX_STILL_WORKING]);
  expect(entry.midturn_message_count).toBe(2);
  expect(entry.fast_relay_started).toBe(false);
});

test('identical accepted final fences its exact owner and never a newer inbound', async () => {
  const f = fixture();
  f.chunk = 'final text';
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  const binding: PersistedBinding = {
    provider: 'codex',
    session_id: 'session-1',
    bound_chat_id: 'chat-1',
    tmux_session: 'orchestrator',
    bound_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    state_version: 1,
  };
  const decision = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: f.current,
    payload: {
      provider: 'codex',
      session_id: 'session-1',
      turn_id: 'turn-identical',
      assistant_text: 'final text',
      cwd: '/repo',
      source: 'codex_notify',
    },
    started_at: 2_000,
  });
  expect(decision.action).toBe('suppress');
  const exact = f.current;
  expect(
    fenceAcceptedTerminalPending({
      decision,
      expected: exact,
      current: f.current,
      now: 2_001,
    }),
  ).toBe(true);
  f.now = 1_000 + CODEX_HEARTBEAT_AFTER_MS;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('inactive');
  expect(f.sent).toEqual(['final text']);

  const newer = pending('request-2');
  f.current = newer;
  expect(
    fenceAcceptedTerminalPending({
      decision,
      expected: exact,
      current: newer,
      now: 2_002,
    }),
  ).toBe(false);
  expect(newer.replied_at).toBeUndefined();
});

test('authoritative final is fresh and deliver-once after multiple mid-turn messages', async () => {
  const f = fixture();
  f.chunk = 'working';
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(codexFinalEditTarget(f.current)).toBe(700);
  f.chunk = 'more work';
  f.now = 1_000 + CODEX_PROGRESS_INTERVAL_MS;
  expect(await f.relay.tick('chat-1', 'request-1')).toBe('sent');
  expect(codexFinalEditTarget(f.current)).toBeUndefined();
  const binding: PersistedBinding = {
    provider: 'codex',
    session_id: 'session-1',
    bound_chat_id: 'chat-1',
    tmux_session: 'orchestrator',
    bound_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
    state_version: 1,
  };
  const payload = {
    provider: 'codex' as const,
    session_id: 'session-1',
    turn_id: 'turn-1',
    assistant_text: 'final answer',
    cwd: '/repo',
    source: 'codex_notify' as const,
  };
  const decision = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: f.current,
    payload,
    started_at: 2_000,
  });
  expect(decision.action).toBe('deliver');
  expect(f.current?.midturn_message_count).toBe(2);
  const duplicate = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: f.current,
    payload,
    started_at: 2_001,
    existingDelivery: {
      chat_id: 'chat-1',
      outcome: 'delivered_layer1',
      source: 'codex_notify',
      first_seen_at: 2_000,
    },
  });
  expect(duplicate).toEqual({ action: 'dedup', outcome: 'delivered_layer1' });
});
