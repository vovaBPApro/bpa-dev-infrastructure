import { expect, test } from 'bun:test';
import {
  classifyTurn,
  codexPasteMarker,
  decideRelay,
  detectCodexPasteDeliveryState,
  evaluateStall,
  getWatchdogTimeoutConfig,
  isPendingReplyTimedOut,
  parseCodexApprovalPrompt,
  parseCodexDecisionPrompt,
  parseAssistantChunk,
  parseAssistantChunkAfterTelegramMessage,
  type PendingReply,
  type PersistedBinding,
} from './reliability';

test('pending reply watchdog defaults to five minutes', () => {
  expect(getWatchdogTimeoutConfig({})).toEqual({
    pendingReplyTimeoutMs: 300_000,
    codexFallbackTimeoutMs: 90_000,
    watchdogTickMs: 15_000,
  });
});

test('pending reply watchdog honors an env timeout override', () => {
  const tiny = getWatchdogTimeoutConfig({
    ORCH_PENDING_REPLY_TIMEOUT_MS: '25',
    ORCH_CODEX_FALLBACK_TIMEOUT_MS: '35',
    ORCH_WATCHDOG_TICK_MS: '5',
  });
  const large = getWatchdogTimeoutConfig({
    ORCH_PENDING_REPLY_TIMEOUT_MS: '10000',
  });

  expect(isPendingReplyTimedOut(1_000, 1_026, tiny.pendingReplyTimeoutMs)).toBe(
    true,
  );
  expect(tiny.codexFallbackTimeoutMs).toBe(35);
  expect(tiny.watchdogTickMs).toBe(5);
  expect(isPendingReplyTimedOut(1_000, 1_026, large.pendingReplyTimeoutMs)).toBe(
    false,
  );
});

test('pending reply watchdog rejects invalid env timeout values', () => {
  for (const value of ['not-a-number', '0', '-1', 'Infinity']) {
    expect(
      getWatchdogTimeoutConfig({
        ORCH_PENDING_REPLY_TIMEOUT_MS: value,
        ORCH_CODEX_FALLBACK_TIMEOUT_MS: value,
        ORCH_WATCHDOG_TICK_MS: value,
      }),
    ).toEqual({
      pendingReplyTimeoutMs: 300_000,
      codexFallbackTimeoutMs: 90_000,
      watchdogTickMs: 15_000,
    });
  }
});

const binding: PersistedBinding = {
  provider: 'codex',
  session_id: 'sess-1',
  bound_chat_id: 'chat-1',
  tmux_session: 'orch',
  bound_at: '2026-05-22T10:00:00.000Z',
  updated_at: '2026-05-22T10:00:00.000Z',
  state_version: 1,
};

const claudeBinding: PersistedBinding = {
  ...binding,
  provider: 'claude',
};

function pending(
  openedAt: number,
  extra: Partial<PendingReply> = {},
): PendingReply {
  return {
    chatId: 'chat-1',
    inboundText: 'hello',
    opened_at: openedAt,
    pending_request_id: 'req-1',
    ...extra,
  };
}

test('classifyTurn treats active pending as solicited across Codex session changes', () => {
  expect(
    classifyTurn({
      binding,
      pending: pending(100),
      turn_session_id: 'sess-1',
      started_at: 150,
    }),
  ).toBe('solicited');
  expect(
    classifyTurn({
      binding,
      pending: pending(200),
      turn_session_id: 'sess-1',
      started_at: 150,
    }),
  ).toBe('unsolicited');
  expect(
    classifyTurn({
      binding,
      pending: pending(100),
      turn_session_id: 'sess-2',
      started_at: 150,
    }),
  ).toBe('solicited');
});

test('classifyTurn keeps Claude session mismatches unsolicited', () => {
  expect(
    classifyTurn({
      binding: claudeBinding,
      pending: pending(100),
      turn_session_id: 'sess-2',
      started_at: 150,
    }),
  ).toBe('unsolicited');
});

test('decideRelay suppresses explicit replies and auto relay before hook delivery', () => {
  const explicit = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: pending(100, { replied_at: 200, reply_source: 'explicit_reply' }),
    payload: {
      provider: 'codex',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      assistant_text: 'done',
      cwd: '/tmp',
      source: 'codex_notify',
    },
    started_at: 150,
  });
  expect(explicit.action).toBe('suppress');
  if (explicit.action === 'suppress') {
    expect(explicit.outcome).toBe('suppressed_by_explicit_reply');
  }

  const fallback = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: pending(100, {
      replied_at: 200,
      reply_source: 'auto_relay',
      last_relayed_chunk: 'done',
    }),
    payload: {
      provider: 'codex',
      session_id: 'sess-1',
      turn_id: 'turn-2',
      assistant_text: 'done',
      cwd: '/tmp',
      source: 'codex_notify',
    },
    started_at: 150,
  });
  expect(fallback.action).toBe('suppress');
  if (fallback.action === 'suppress') {
    expect(fallback.outcome).toBe('suppressed_by_auto_relay');
  }
});

test('decideRelay delivers final Codex turn after an early auto relay', () => {
  const final = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: pending(100, {
      messageId: 42,
      reply_source: 'auto_relay',
      last_relayed_chunk: 'Починаю перевірку.',
      fallback_sent: true,
    }),
    payload: {
      provider: 'codex',
      session_id: 'sess-1',
      turn_id: 'turn-final',
      assistant_text: 'Перевірку завершено: все ок.',
      cwd: '/tmp',
      source: 'codex_notify',
    },
    started_at: 150,
  });

  expect(final).toEqual({
    action: 'deliver',
    classification: 'solicited',
    chat_id: 'chat-1',
    reply_to_message_id: 42,
    outcome: 'delivered_layer1',
  });
});

test('decideRelay suppresses unsolicited turns and rejects mismatched chat config', () => {
  const unsolicited = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: undefined,
    payload: {
      provider: 'codex',
      session_id: 'sess-1',
      turn_id: 'turn-3',
      assistant_text: 'background note',
      cwd: '/tmp',
      source: 'codex_notify',
    },
    started_at: 150,
  });
  // Codex surfaces autonomous progress only via turn-end relays, so unsolicited
  // codex turns are DELIVERED (not suppressed) — otherwise the Human sees nothing
  // while codex works. (Claude, which has an MCP reply channel, still suppresses.)
  expect(unsolicited.action).toBe('deliver');
  if (unsolicited.action === 'deliver') {
    expect(unsolicited.classification).toBe('unsolicited');
  }

  expect(
    decideRelay({
      binding,
      configuredBoundChatId: 'other-chat',
      pending: undefined,
      payload: {
        provider: 'codex',
        session_id: 'sess-1',
        turn_id: 'turn-4',
        assistant_text: 'background note',
        cwd: '/tmp',
        source: 'codex_notify',
      },
      started_at: 150,
    }),
  ).toEqual({ action: 'reject', reason: 'bound_chat_mismatch' });

  const dedup = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: undefined,
    payload: {
      provider: 'codex',
      session_id: 'sess-1',
      turn_id: 'turn-4',
      assistant_text: 'background note',
      cwd: '/tmp',
      source: 'codex_notify',
    },
    started_at: 150,
    existingDelivery: {
      chat_id: 'chat-1',
      outcome: 'suppressed_unsolicited',
      source: 'codex_notify',
      first_seen_at: 123,
    },
  });
  expect(dedup).toEqual({ action: 'dedup', outcome: 'suppressed_unsolicited' });
});

test('decideRelay delivers pending replies after Codex internal session changes', () => {
  const changedSession = decideRelay({
    binding,
    configuredBoundChatId: 'chat-1',
    pending: pending(100, { messageId: 42 }),
    payload: {
      provider: 'codex',
      session_id: 'sess-2',
      turn_id: 'turn-5',
      assistant_text: 'orchestrator answer',
      cwd: '/tmp',
      source: 'codex_notify',
    },
    started_at: 150,
  });

  expect(changedSession).toEqual({
    action: 'deliver',
    classification: 'solicited',
    chat_id: 'chat-1',
    reply_to_message_id: 42,
    outcome: 'delivered_layer1',
  });
});

test('decideRelay rejects Claude pending replies from a different session', () => {
  expect(
    decideRelay({
      binding: claudeBinding,
      configuredBoundChatId: 'chat-1',
      pending: pending(100, { messageId: 42 }),
      payload: {
        provider: 'claude',
        session_id: 'sess-2',
        turn_id: 'turn-6',
        assistant_text: 'wrong session',
        cwd: '/tmp',
        source: 'claude_stop_hook',
      },
      started_at: 150,
    }),
  ).toEqual({ action: 'reject', reason: 'session_mismatch' });
});

test('parseAssistantChunk handles Claude and Codex markers', () => {
  const claudePane = ['⏺ Final answer line 1', 'line 2', '⎿ tool output'].join(
    '\n',
  );
  expect(parseAssistantChunk('claude', claudePane)).toBe(
    'Final answer line 1\nline 2',
  );

  const codexPane = [
    '• Working (3s • esc to interrupt)',
    '• Ran date',
    '  └ Fri May 22 09:28:22 CEST 2026',
    '────────────────────────────────────',
    '• Fri May 22 09:28:22 CEST 2026',
    '────────────────────────────────────',
    '› Draft reply',
  ].join('\n');
  expect(parseAssistantChunk('codex', codexPane)).toBe(
    'Fri May 22 09:28:22 CEST 2026',
  );
});

test('parseAssistantChunk skips Codex tool status bullets', () => {
  const codexPane = [
    '• Прийняв. Підніму окрему Coder-сесію на Codex.',
    '',
    '• Explored',
    '  └ Read package.json',
    '    Search dispatch-codex',
    '',
    '• Зараз перевірю стан гілки локально, після чого запущу Codex Coder із чітким контрактом.',
    '',
    '• Ran git status -sb',
    '  └ ## dev...origin/dev [ahead 1]',
    '',
    '• Running git fetch origin dev',
  ].join('\n');

  expect(parseAssistantChunk('codex', codexPane)).toBe(
    'Зараз перевірю стан гілки локально, після чого запущу Codex Coder із чітким контрактом.',
  );
});

test('parseAssistantChunk ignores Codex queued follow-up input blocks', () => {
  const codexPane = [
    '• Моя роль: Orchestrator.',
    '',
    'Queued follow-up inputs',
    '  └ <channel source="telegram" chat_id="83769716">',
    '    яка твоя роль?',
    '    </channel> [reply normally; Telegram daemon will relay final answer to chat_id=83769716]',
    '  shift + ← edit last queued message',
  ].join('\n');

  expect(parseAssistantChunk('codex', codexPane)).toBe(
    'Моя роль: Orchestrator.',
  );
});

test('parseAssistantChunkAfterTelegramMessage anchors relay to the inbound message', () => {
  const codexPane = [
    '• Старіший chunk, який не можна релеити.',
    '',
    '› <channel source="telegram" chat_id="83769716" message_id="4471">',
    '  не бачу відповіді в телеграм',
    '  </channel> [reply normally; Telegram daemon will relay final answer to chat_id=83769716]',
    '',
    '• Бачу. Повторю коротко для Telegram.',
    '',
    '› <channel source="telegram" chat_id="83769716" message_id="4472">',
    '  яка твоя роль?',
    '  </channel> [reply normally; Telegram daemon will relay final answer to chat_id=83769716]',
    '',
    'Queued follow-up inputs',
    '  └ <channel source="telegram" chat_id="83769716" message_id="4473">',
    '    ping',
  ].join('\n');

  expect(
    parseAssistantChunkAfterTelegramMessage('codex', codexPane, 4471),
  ).toBe('Бачу. Повторю коротко для Telegram.');
  expect(
    parseAssistantChunkAfterTelegramMessage('codex', codexPane, 4472),
  ).toBeNull();
});

test('detectCodexPasteDeliveryState distinguishes submitted, queued, and stuck input', () => {
  const wrapped =
    '<channel source="telegram" chat_id="83769716" message_id="999001">\\nhello\\n</channel>';
  expect(codexPasteMarker(wrapped)).toBe('message_id="999001"');

  const submitted = [
    '› <channel source="telegram" chat_id="83769716" message_id="999001">',
    '  hello',
    '  </channel>',
    '',
    '• Відповідь пішла.',
  ].join('\n');
  expect(detectCodexPasteDeliveryState(submitted, 'message_id="999001"')).toBe(
    'submitted',
  );

  const queued = [
    '• Working (11s • esc to interrupt)',
    '',
    'Queued follow-up inputs',
    '  └ <channel source="telegram" chat_id="83769716" message_id="999001">',
    '    hello',
  ].join('\n');
  expect(detectCodexPasteDeliveryState(queued, 'message_id="999001"')).toBe(
    'queued',
  );

  const stuck = [
    '• Ready.',
    '',
    '› <channel source="telegram" chat_id="83769716" message_id="999001">',
    '  hello',
  ].join('\n');
  expect(detectCodexPasteDeliveryState(stuck, 'message_id="999001"')).toBe(
    'stuck',
  );
});

test('parseCodexApprovalPrompt extracts command approval requests', () => {
  const pane = [
    '• Running git fetch origin dev',
    '',
    '  Would you like to run the following command?',
    '',
    '  Reason: Do you want me to fetch origin/dev so the Codex Coder can run Playwright against the true latest code?',
    '',
    '  $ git fetch origin dev',
    '',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for commands that start with `git fetch origin dev` (p)",
    '  3. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n');

  expect(parseCodexApprovalPrompt(pane)).toEqual({
    reason:
      'Do you want me to fetch origin/dev so the Codex Coder can run Playwright against the true latest code?',
    command: 'git fetch origin dev',
  });
});

test('parseCodexDecisionPrompt extracts numbered assistant choices', () => {
  const pane = [
    '• Зупинився перед запуском, бо в робочому дереві вже є не-мої незакомічені зміни:',
    '',
    '  - tools/claude-telegram-daemon/server.ts',
    '',
    '  Як діємо далі?',
    '',
    '  1. Запускаю Codex Coder і Playwright поверх поточного брудного дерева.',
    '  2. Зупиняємось, ти спочатку комітиш/ховаєш ці зміни, і тоді я запускаю тести на чистому стані.',
    '',
    '─ Worked for 5m 00s ─────────────────────────────────────────────────────',
    '',
    '› Implement {feature}',
  ].join('\n');

  expect(parseCodexDecisionPrompt(pane)).toEqual({
    question: 'Як діємо далі?',
    options: [
      {
        index: 1,
        label:
          'Запускаю Codex Coder і Playwright поверх поточного брудного дерева.',
      },
      {
        index: 2,
        label:
          'Зупиняємось, ти спочатку комітиш/ховаєш ці зміни, і тоді я запускаю тести на чистому стані.',
      },
    ],
  });
});

test('parseCodexDecisionPrompt ignores numbered failure/file lists', () => {
  const pane = [
    '• Codex чекає рішення:',
    '',
    '  І якого дідька ти мені прислав це?',
    '',
    '  1. playwright/journeys_parallel/j_create_omnimenu.spec.ts:23',
    '  2. playwright/journeys_parallel/j_create_omnimenu.spec.ts:85',
    '  3. playwright/journeys_parallel/j_rules_create.spec.ts:94',
    '  4. playwright/journeys_parallel/j_rules_detail.spec.ts:68',
    '  5. playwright/journeys_parallel/j_rules_detail.spec.ts:87',
    '  6. playwright/journeys_parallel/j_rules_detail.spec.ts:109',
    '  7. playwright/journeys_parallel/j_rules_detail.spec.ts:131',
  ].join('\n');

  expect(parseCodexDecisionPrompt(pane)).toBeNull();
});

test('evaluateStall returns idle when done_cmd reports completed', () => {
  const mission = {
    desc: 'Implement plan',
    created_at: '2026-05-22T10:00:00.000Z',
    status: 'active',
  };
  expect(
    evaluateStall({
      hasBinding: true,
      providerKnown: true,
      mission,
      tmuxAlive: true,
      now: 2000,
      lastPaneProgressAt: 0,
      lastGitProgressAt: 0,
      thresholdMs: 100,
      doneCmdResult: { state: 'completed', detail: 'git_ref_changed' },
    }),
  ).toEqual({
    state: 'idle',
    shouldAlert: false,
    reason: 'done_cmd_completed',
    alertKey: null,
  });

  // cannot_verify should NOT short-circuit — stall still fires when progress is stale
  const stall = evaluateStall({
    hasBinding: true,
    providerKnown: true,
    mission,
    tmuxAlive: true,
    now: 2000,
    lastPaneProgressAt: 1000,
    lastGitProgressAt: 1000,
    thresholdMs: 100,
    doneCmdResult: { state: 'cannot_verify', detail: 'no_done_cmd' },
  });
  expect(stall.state).toBe('stall');
  expect(stall.shouldAlert).toBe(true);
});

// REGRESSION (fail-open alarm): a bound provider session whose tmux is gone is
// a fault whether or not mission bookkeeping exists. Requiring an active
// mission on this branch is how the operator got silence from a dead
// orchestrator — the mission input had no writer, so `mission` was always null
// and the dead branch was unreachable.
test('evaluateStall alerts on a dead bound session even with no mission record', () => {
  const dead = evaluateStall({
    hasBinding: true,
    providerKnown: true,
    mission: null,
    tmuxAlive: false,
    now: 1000,
    thresholdMs: 100,
  });
  expect(dead.state).toBe('dead');
  expect(dead.shouldAlert).toBe(true);
  expect(dead.reason).toBe('tmux_missing');

  // Repeat ticks must not re-notify.
  expect(
    evaluateStall({
      hasBinding: true,
      providerKnown: true,
      mission: null,
      tmuxAlive: false,
      now: 2000,
      thresholdMs: 100,
      lastAlertKey: dead.alertKey,
    }).shouldAlert,
  ).toBe(false);

  // A live session with no mission is legitimate idling, not a stall.
  const quiet = evaluateStall({
    hasBinding: true,
    providerKnown: true,
    mission: null,
    tmuxAlive: true,
    now: 10_000,
    lastPaneProgressAt: 1,
    lastGitProgressAt: 1,
    thresholdMs: 100,
  });
  expect(quiet.state).toBe('idle');
  expect(quiet.reason).toBe('no_active_mission');
});

test('evaluateStall distinguishes idle, dead, and stall with alert dedupe', () => {
  expect(
    evaluateStall({
      hasBinding: false,
      providerKnown: false,
      mission: null,
      tmuxAlive: false,
      now: 1000,
      thresholdMs: 100,
    }),
  ).toEqual({
    state: 'idle',
    shouldAlert: false,
    reason: 'idle',
    alertKey: null,
  });

  const mission = {
    desc: 'Implement plan',
    created_at: '2026-05-22T10:00:00.000Z',
    status: 'active',
  };
  const dead = evaluateStall({
    hasBinding: true,
    providerKnown: true,
    mission,
    tmuxAlive: false,
    now: 1000,
    thresholdMs: 100,
  });
  expect(dead.state).toBe('dead');
  expect(dead.shouldAlert).toBe(true);

  const stall = evaluateStall({
    hasBinding: true,
    providerKnown: true,
    mission,
    tmuxAlive: true,
    now: 1000,
    lastPaneProgressAt: 100,
    lastGitProgressAt: 100,
    thresholdMs: 500,
    lastAlertKey: dead.alertKey,
  });
  expect(stall.state).toBe('stall');
  expect(stall.shouldAlert).toBe(true);
});
