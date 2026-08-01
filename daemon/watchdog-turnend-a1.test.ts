// A1 regression lock — the operator's long Claude answers must survive the
// watchdog, and the watchdog must not shout while they are on the way.
//
// The incident: the reply watchdog fires at ORCH_PENDING_REPLY_TIMEOUT_MS,
// pane-scrapes (or used to post a "still working" placeholder), and used to
// mark the pending inbound `replied_at`. classifyTurn() then reports
// 'unsolicited' for the real turn-end, and decideRelay() SUPPRESSES unsolicited
// turns for MCP-channel providers (claude). Result: every Claude answer slower
// than the timeout was silently dropped and the operator asked "ти живий?".
//
// Two properties are locked together here, because they live in the same two
// branches and the obvious fix for either one re-breaks the other:
//
//   1. The placeholder branch must send NOTHING to the chat. The Human asked
//      not to see "📭 No reply forwarded …" — it is noise during a long
//      heads-down turn, when the orchestrator is busy rather than stuck.
//   2. The authoritative turn-end must still be DELIVERED afterwards, i.e.
//      the notice records `fallback_sent` and leaves `replied_at` null.
//
// Suppressing (1) by closing the turn re-breaks (2), which is exactly what the
// old daemon did, so both are asserted in the same test.
//
// And because `fallback_sent` is now the ONLY thing stopping a notice storm, it
// has to be claimed before the awaited send rather than after it.
//
// These tests drive the REAL daemon end to end — real watchdogTick, real
// /orchestrator/turn-end ingest — against a stub Telegram API and a stub tmux.
// They also lock the two suppressions that are CORRECT (explicit reply(),
// identical auto-relay body) so this fix cannot be "restored" into a
// double-post.
import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Subprocess } from 'bun';
import { isolatedTestEnv } from './test-env';
// NOTE: import only symbols that exist BEFORE the fix. This file must load —
// and its behavioural tests must actually run and fail — against the regressed
// tree, otherwise the "fail-before" evidence is just a missing export. In
// particular do NOT import markWatchdogNoticeSent or claimWatchdogNotice: a
// revert deletes those exports and the suite would die with a load error
// instead of a red assertion, which is the failure mode that let this
// regression through the first time. The end-to-end tests observe the daemon
// only through the Telegram stub, its stderr, and the turn-end HTTP response —
// all of which predate the fix.
import {
  decideRelay,
  type PendingReply,
  type PersistedBinding,
  type Provider,
  type TurnEndPayload,
} from './reliability';

const BOT_TOKEN = '123456:test-token';

// The operator's real chat. Nothing in this suite may ever address it; a
// fixture chat id is used throughout and this constant exists only so the
// afterEach assertion fails loudly if the real one ever leaks in.
const OPERATOR_CHAT_ID = '83769716';

// A coder lane runs INSIDE the operator's orchestrator process tree, so
// process.env carries the live ORCH_*/TELEGRAM_*/INFRA_* surface: the real
// instance lock, the real lease DB, the real bound chat id, the real bot
// token. Spreading that into a daemon under test makes it talk to the
// operator's Telegram and stomp live state. Scrub the whole prefix surface and
// re-add only what this test owns. The shared helper has a regression lock so
// future ORCH_* names are scrubbed without another hand-maintained path list.
type SentMessage = { chat_id: string; text: string };

type Harness = {
  chatId: string;
  sent: SentMessage[];
  stderr: () => string;
  pushMessage: (text: string, messageId: number) => void;
  turnEnd: (payload: Partial<TurnEndPayload>) => Promise<string>;
  setPane: (pane: string) => void;
  stop: () => void;
};

const harnesses: Harness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    // Fail-closed on the hard constraint: no message this suite produced may
    // ever have been addressed to the operator's live chat.
    expect(h.sent.filter((m) => m.chat_id === OPERATOR_CHAT_ID)).toEqual([]);
    h.stop();
  }
});

function freePort(): number {
  return 20_000 + Math.floor(Math.random() * 25_000);
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Boot the real daemon against a stub Telegram Bot API and a stub tmux.
 * Nothing here touches the operator's live daemon, lock, lease or chat.
 */
async function startDaemon(opts: {
  provider: Provider;
  sessionId: string;
  pane: string;
  /** Delay every sendMessage, to widen the watchdog's double-post window. */
  sendDelayMs?: number;
}): Promise<Harness> {
  const scratch = mkdtempSync(join(tmpdir(), 'a1-watchdog-'));
  const stateDir = join(scratch, 'state');
  const runtimeDir = join(stateDir, 'daemon', 'runtime');
  const installRoot = join(scratch, 'install');
  const binDir = join(scratch, 'bin');
  const homeDir = join(scratch, 'home');
  const paneFile = join(scratch, 'pane.txt');
  const chatId = '999000111';
  const tmuxSession = 'a1-watchdog-test';
  const daemonPort = freePort();
  const apiPort = freePort();

  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(installRoot, 'orchestrator'), { recursive: true });

  writeFileSync(paneFile, opts.pane);

  writeFileSync(
    join(stateDir, 'access.json'),
    JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [chatId], groups: {} }),
  );
  writeFileSync(
    join(runtimeDir, 'orchestrator-binding.json'),
    JSON.stringify({
      provider: opts.provider,
      session_id: opts.sessionId,
      bound_chat_id: chatId,
      tmux_session: tmuxSession,
      bound_at: '2026-07-30T00:00:00.000Z',
      updated_at: '2026-07-30T00:00:00.000Z',
      state_version: 1,
    } satisfies PersistedBinding),
  );

  // Stub tmux: session is alive, capture-pane serves the fixture, every other
  // subcommand (load-buffer/paste-buffer/send-keys/display-message) succeeds.
  const tmux = join(binDir, 'tmux');
  writeFileSync(
    tmux,
    `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    capture-pane) cat ${JSON.stringify(paneFile)}; exit 0 ;;
    has-session) exit 0 ;;
  esac
done
exit 0
`,
  );
  chmodSync(tmux, 0o755);

  // Startup also performs a lane census. Keep this harness isolated from the
  // host systemd bus; a missing stub previously blocked Telegram polling.
  const systemctl = join(binDir, 'systemctl');
  writeFileSync(systemctl, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(systemctl, 0o755);

  // ── Stub Telegram Bot API ────────────────────────────────────────────────
  const sent: SentMessage[] = [];
  const updates: unknown[] = [];
  let updateId = 1;
  let outMessageId = 5000;

  const pushMessage = (text: string, messageId: number) => {
    updates.push({
      update_id: updateId++,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(chatId), type: 'private' },
        from: { id: Number(chatId), is_bot: false, first_name: 'operator' },
        text,
      },
    });
  };

  const api = Bun.serve({
    port: apiPort,
    hostname: '127.0.0.1',
    async fetch(req) {
      const method = new URL(req.url).pathname.split('/').pop() ?? '';
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        /* GET or empty body */
      }
      const ok = (result: unknown) => Response.json({ ok: true, result });

      if (method === 'getMe') {
        return ok({
          id: 1,
          is_bot: true,
          first_name: 'a1-stub',
          username: 'a1_stub_bot',
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
        });
      }
      if (method === 'getUpdates') {
        // Drain immediately when there is work, otherwise short-poll so the
        // test never waits on grammY's 30s long-poll default.
        if (updates.length === 0) await Bun.sleep(60);
        return ok(updates.splice(0));
      }
      if (method === 'sendMessage') {
        const chat_id = String(body.chat_id ?? '');
        const text = String(body.text ?? '');
        // Record on ARRIVAL, before the artificial latency: the double-post
        // race is about requests issued while an earlier one is still in
        // flight, so the count must reflect requests, not completions.
        sent.push({ chat_id, text });
        if (opts.sendDelayMs) await Bun.sleep(opts.sendDelayMs);
        return ok({
          message_id: ++outMessageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(chat_id), type: 'private' },
          text,
        });
      }
      if (method === 'editMessageText') {
        sent.push({
          chat_id: String(body.chat_id ?? ''),
          text: String(body.text ?? ''),
        });
        return ok(true);
      }
      return ok(true);
    },
  });

  const child = Bun.spawn(['bun', join(import.meta.dir, 'server.ts')], {
    cwd: import.meta.dir,
    env: isolatedTestEnv({
      HOME: homeDir,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_API_ROOT: `http://127.0.0.1:${apiPort}`,
      TELEGRAM_STATE_DIR: stateDir,
      TELEGRAM_DAEMON_PORT: String(daemonPort),
      TELEGRAM_ACCESS_MODE: 'static',
      TELEGRAM_BOUND_CHAT_ID: chatId,
      ORCH_INSTALL_ROOT: installRoot,
      ORCH_SESSION: tmuxSession,
      // Fast watchdog so the timeout path is reachable in a unit test.
      ORCH_PENDING_REPLY_TIMEOUT_MS: '300',
      ORCH_CODEX_FALLBACK_TIMEOUT_MS: '300',
      ORCH_WATCHDOG_TICK_MS: '100',
      // Everything else that would reach outside the scratch tree, parked.
      ORCH_STALL_WATCHDOG_TICK_MS: '3600000',
      ORCH_STALL_THRESHOLD_MS: '3600000',
      ORCH_STATE_DB: join(scratch, 'absent-state.db'),
      ORCH_INSTANCE_LOCK_FILE: join(scratch, 'instance.lock'),
      ORCH_SINGLETON_LOCK_FILE: join(scratch, 'singleton.lock'),
      ORCH_CANONICAL_REPO_PATH: scratch,
      NUDGE_OUTBOX_FILE: join(scratch, 'nudges.outbox'),
      MORNING_OUTBOX_FILE: join(scratch, 'morning.outbox'),
      OUTBOX_POLL_MS: '3600000',
    }),
    stdout: 'ignore',
    // The placeholder branch no longer produces a chat message, so the daemon's
    // own log line is its ONLY observable. Pipe stderr and read it.
    stderr: 'pipe',
  }) as Subprocess<'ignore', 'ignore', 'pipe'>;

  let stderrText = '';
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
        const s = decoder.decode(chunk);
        stderrText += s;
        if (process.env.A1_DEBUG) process.stderr.write(s);
      }
    } catch {
      /* the stream closes with the child */
    }
  })();

  const harness: Harness = {
    chatId,
    sent,
    stderr: () => stderrText,
    pushMessage,
    setPane: (pane: string) => writeFileSync(paneFile, pane),
    turnEnd: async (payload) => {
      const res = await fetch(
        `http://127.0.0.1:${daemonPort}/orchestrator/turn-end`,
        {
          method: 'POST',
          body: JSON.stringify({
            provider: opts.provider,
            session_id: opts.sessionId,
            cwd: '/work',
            source:
              opts.provider === 'codex' ? 'codex_notify' : 'claude_stop_hook',
            ...payload,
          }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      return await res.text();
    },
    stop: () => {
      child.kill();
      api.stop(true);
      rmSync(scratch, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);

  // Waiting via fetch used to make this test's own timeout ineffective when a
  // host dropped loopback SYNs: the unresolved fetch trapped waitFor forever.
  // The listen callback emits this only after the HTTP server is bound.
  await waitFor('daemon health listener', () =>
    stderrText.includes('[telegram-daemon] Health:'),
  );

  return harness;
}

// Claude Code's prompt geometry: two horizontal-bar lines with an EMPTY '❯'
// line between them. snifferState() reads that as SENT, so tmuxPasteText()
// succeeds and exactly one pending inbound is registered — same as production.
const CLAUDE_PROMPT_BOX = [
  '────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────',
];

const CLAUDE_PANE_WITH_CHUNK = [
  '  some earlier tui frame',
  '',
  '⏺ partial progress note',
  '',
  ...CLAUDE_PROMPT_BOX,
].join('\n');

const CLAUDE_PANE_NO_CHUNK = [
  '  some earlier tui frame',
  '',
  ...CLAUDE_PROMPT_BOX,
].join('\n');

const LONG_ANSWER =
  'the authoritative long answer the operator actually waited for, ' +
  'written after the watchdog had already given up';

// Fragments that would prove a placeholder reached the chat. Both the emoji and
// the sentence are checked, so a reworded placeholder is still caught.
const PLACEHOLDER_MARKERS = ['📭', 'Still working on your last message'];

// ── The lock ────────────────────────────────────────────────────────────────

test(
  'A1: the placeholder is suppressed to stderr AND the claude turn-end still delivers',
  async () => {
    const h = await startDaemon({
      provider: 'claude',
      sessionId: 'claude-session-1',
      pane: CLAUDE_PANE_NO_CHUNK,
    });

    h.pushMessage('довге питання', 4001);
    // The Human directive: the placeholder is logged, not messaged.
    await waitFor('watchdog placeholder suppression log', () =>
      h.stderr().includes('watchdog placeholder SUPPRESSED'),
    );
    for (const marker of PLACEHOLDER_MARKERS) {
      expect(h.sent.filter((m) => m.text.includes(marker))).toEqual([]);
    }

    // ...and the A1 half, in the same test: the authoritative turn-end arrives
    // AFTER the suppressed notice and must be delivered, not suppressed as
    // 'unsolicited'. Suppressing the placeholder by closing the turn — the
    // shape the old daemon shipped — makes this red.
    const outcome = await h.turnEnd({
      turn_id: 'turn-late-1',
      assistant_text: LONG_ANSWER,
    });
    expect(outcome).toBe('delivered_layer1');
    await waitFor('long answer delivered', () =>
      h.sent.some((m) => m.text.includes(LONG_ANSWER)),
    );

    // Still silent about the placeholder after the real answer went out.
    for (const marker of PLACEHOLDER_MARKERS) {
      expect(h.sent.filter((m) => m.text.includes(marker))).toEqual([]);
    }
  },
  30_000,
);

test(
  'A1: watchdog pane-scrape does NOT eat the fuller claude turn-end',
  async () => {
    const h = await startDaemon({
      provider: 'claude',
      sessionId: 'claude-session-2',
      pane: CLAUDE_PANE_WITH_CHUNK,
    });

    h.pushMessage('довге питання', 4002);
    await waitFor('watchdog auto-relay', () =>
      h.sent.some((m) => m.text.includes('partial progress note')),
    );

    // Correct suppression, kept: the final text is byte-identical to what the
    // pane scrape already posted, so re-sending it would double-post.
    expect(
      await h.turnEnd({
        turn_id: 'turn-identical',
        assistant_text: 'partial progress note',
      }),
    ).toBe('suppressed_by_auto_relay');

    // The regression: the authoritative answer is LONGER than the scraped
    // preview and must still reach the operator.
    expect(
      await h.turnEnd({
        turn_id: 'turn-late-2',
        assistant_text: LONG_ANSWER,
      }),
    ).toBe('delivered_layer1');
    await waitFor('long answer delivered', () =>
      h.sent.some((m) => m.text.includes(LONG_ANSWER)),
    );
  },
  30_000,
);

test(
  'A1: the suppressed claude placeholder is recorded exactly once per pending inbound',
  async () => {
    const h = await startDaemon({
      provider: 'claude',
      sessionId: 'claude-session-3',
      pane: CLAUDE_PANE_NO_CHUNK,
    });

    h.pushMessage('довге питання', 4003);
    await waitFor('watchdog placeholder suppression log', () =>
      h.stderr().includes('watchdog placeholder SUPPRESSED'),
    );
    // replied_at stays null now, so only fallback_sent stops a notice storm:
    // 15 ticks at 100ms must still produce exactly one recorded notice — and
    // still zero chat messages.
    await Bun.sleep(1_500);
    expect(
      countOccurrences(h.stderr(), 'watchdog placeholder SUPPRESSED'),
    ).toBe(1);
    for (const marker of PLACEHOLDER_MARKERS) {
      expect(h.sent.filter((m) => m.text.includes(marker))).toEqual([]);
    }
  },
  30_000,
);

test(
  'A1: a slow Telegram API cannot make overlapping ticks double-post the auto-relay',
  async () => {
    // The race: canSendWatchdogNotice is read at the top of the tick, but
    // fallback_sent used to be written only AFTER the awaited sendMessage.
    // watchdogTick is a bare setInterval, so ticks are not serialised: with a
    // send slower than one tick, every tick in the window passes the guard and
    // posts its own copy. 600ms of API latency against a 100ms tick is several
    // copies on a regressed tree and exactly 1 once the slot is claimed up
    // front.
    const h = await startDaemon({
      provider: 'claude',
      sessionId: 'claude-session-4',
      pane: CLAUDE_PANE_WITH_CHUNK,
      sendDelayMs: 600,
    });

    h.pushMessage('довге питання', 4004);
    await waitFor('watchdog auto-relay', () =>
      h.sent.some((m) => m.text.includes('partial progress note')),
    );
    // Let every tick that could still be inside the window run.
    await Bun.sleep(2_000);
    expect(
      h.sent.filter((m) => m.text.includes('partial progress note')).length,
    ).toBe(1);
  },
  30_000,
);

test(
  'A1 does not break codex: its notify turn-end still delivers after fallback',
  async () => {
    const h = await startDaemon({
      provider: 'codex',
      sessionId: 'codex-session-1',
      // Codex pane chunks start with "• ".
      pane: ['  frame', '', '• codex partial chunk', '', '› '].join('\n'),
    });

    h.pushMessage('довге питання', 4005);
    await waitFor('codex watchdog fallback', () =>
      h.sent.some((m) => m.text.includes('codex partial chunk')),
    );

    // decideRelay delivers codex turns either way — the late notify must still
    // get through, never be suppressed.
    expect(
      await h.turnEnd({
        turn_id: 'codex-turn-late',
        assistant_text: LONG_ANSWER,
      }),
    ).toBe('delivered_layer1');

    // And codex still gets exactly one fallback, as before.
    await Bun.sleep(1_000);
    expect(h.sent.filter((m) => m.text.includes('codex partial chunk')).length)
      .toBe(1);
  },
  30_000,
);

// ── Source lock on the tick itself ──────────────────────────────────────────

// The end-to-end tests prove the observable behaviour. This one pins the two
// invariants that produce it, so a refactor cannot satisfy the observations by
// accident and then drift: the watchdog tick may send AT MOST the one
// pane-scrape relay, and it may never close a turn.
test('watchdogTick sends only the pane-scrape relay and never closes the turn', () => {
  const source = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8');
  const tick = source.match(
    /async function watchdogTick\(\): Promise<void> \{[\s\S]*?\n\}\n/,
  )?.[0];
  expect(tick).toBeDefined();
  expect(tick).toContain('watchdog placeholder SUPPRESSED');
  expect(countOccurrences(tick!, 'bot.api.sendMessage')).toBe(1);
  expect(tick).not.toContain('replied_at =');
});

// ── Unit locks on the decision layer ────────────────────────────────────────

function binding(provider: Provider, sessionId: string): PersistedBinding {
  return {
    provider,
    session_id: sessionId,
    bound_chat_id: '999000111',
    tmux_session: 'a1-watchdog-test',
    bound_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
    state_version: 1,
  };
}

function pending(overrides: Partial<PendingReply> = {}): PendingReply {
  return {
    chatId: '999000111',
    messageId: 4001,
    inboundText: 'довге питання',
    opened_at: 1_000,
    pending_request_id: 'req-1',
    ...overrides,
  };
}

function payload(
  provider: Provider,
  sessionId: string,
  text: string,
): TurnEndPayload {
  return {
    provider,
    session_id: sessionId,
    turn_id: 'turn-1',
    assistant_text: text,
    cwd: '/work',
    source: provider === 'codex' ? 'codex_notify' : 'claude_stop_hook',
  };
}

test('a claude turn-end after a watchdog notice is solicited and delivered', () => {
  for (const source of ['auto_relay', 'auto_placeholder'] as const) {
    const decision = decideRelay({
      binding: binding('claude', 'claude-session-1'),
      configuredBoundChatId: '999000111',
      pending: pending({
        fallback_sent: true,
        placeholder_sent: source === 'auto_placeholder',
        reply_source: source,
        last_relayed_chunk:
          source === 'auto_relay' ? 'partial progress note' : undefined,
      }),
      payload: payload('claude', 'claude-session-1', LONG_ANSWER),
      started_at: 2_000,
    });
    expect(decision).toMatchObject({
      action: 'deliver',
      classification: 'solicited',
      outcome: 'delivered_layer1',
      reply_to_message_id: 4001,
    });
  }
});

// The double-post guard this fix must NOT undo: when the model called reply()
// over the MCP channel, the Stop-hook copy of the same turn is a duplicate.
test('an explicit reply() still suppresses the claude turn-end copy', () => {
  const decision = decideRelay({
    binding: binding('claude', 'claude-session-1'),
    configuredBoundChatId: '999000111',
    pending: pending({
      replied_at: 1_500,
      reply_source: 'explicit_reply',
    }),
    payload: payload('claude', 'claude-session-1', LONG_ANSWER),
    started_at: 2_000,
  });
  expect(decision).toMatchObject({
    action: 'suppress',
    outcome: 'suppressed_by_explicit_reply',
  });
});

test('an identical auto-relay body still suppresses the claude turn-end copy', () => {
  const decision = decideRelay({
    binding: binding('claude', 'claude-session-1'),
    configuredBoundChatId: '999000111',
    pending: pending({
      fallback_sent: true,
      reply_source: 'auto_relay',
      last_relayed_chunk: 'partial progress note',
    }),
    payload: payload('claude', 'claude-session-1', 'partial progress note'),
    started_at: 2_000,
  });
  expect(decision).toMatchObject({
    action: 'suppress',
    outcome: 'suppressed_by_auto_relay',
  });
});

test('a prior layer1 delivery still suppresses a repeat claude turn-end', () => {
  const decision = decideRelay({
    binding: binding('claude', 'claude-session-1'),
    configuredBoundChatId: '999000111',
    pending: pending({ replied_at: 1_500, reply_source: 'layer1' }),
    payload: payload('claude', 'claude-session-1', LONG_ANSWER),
    started_at: 2_000,
  });
  expect(decision).toMatchObject({
    action: 'suppress',
    outcome: 'suppressed_by_prior_delivery',
  });
});
