import { readFileSync } from 'fs';
import { createHash } from 'node:crypto';

export type Provider = 'claude' | 'codex';
export type TurnSource = 'claude_stop_hook' | 'codex_notify';

export type PersistedBinding = {
  provider: Provider;
  session_id: string;
  bound_chat_id: string;
  tmux_session: string;
  bound_at: string;
  updated_at: string;
  state_version: number;
};

export type McpDetachState = {
  provider?: Provider;
  connected: boolean;
  tmuxAlive: boolean;
};

export function isMcpChannelDetached(state: McpDetachState): boolean {
  return state.provider === 'claude' && !state.connected && state.tmuxAlive;
}

export type PendingReply = {
  chatId: string;
  messageId?: number;
  inboundText: string;
  opened_at: number;
  pending_request_id: string;
  replied_at?: number;
  reply_source?:
    | 'explicit_reply'
    | 'auto_relay'
    | 'auto_placeholder'
    | 'layer1';
  session_id_at_open?: string;
  fallback_sent?: boolean;
  placeholder_sent?: boolean;
  baseline_assistant_chunk?: string;
  last_relayed_chunk?: string;
  fast_relay_started?: boolean;
  // Telegram message_id of the fast-relay preview, so the authoritative final
  // turn-end relay can EDIT it in place instead of sending a duplicate.
  relay_message_id?: number;
};

export function canSendWatchdogNotice(pending: PendingReply): boolean {
  return pending.replied_at == null && !pending.fallback_sent;
}

/**
 * Take the single watchdog-notice slot for this pending inbound BEFORE the
 * awaited send, and hand back a release for the failure path.
 *
 * `canSendWatchdogNotice` is evaluated at the top of the tick loop, but the
 * loop then awaits (pane capture, then `sendMessage`) before anything writes
 * `fallback_sent`. `watchdogTick` is driven by a bare `setInterval`, so ticks
 * are not serialised: while the first `sendMessage` is in flight every
 * subsequent tick still sees `fallback_sent` unset, passes the guard, and posts
 * its own copy. Latent at the 300s production timeout, reproducible the moment
 * the Telegram API is slower than one tick.
 *
 * `fallback_sent` — not `replied_at` — is the guard, because `replied_at` must
 * stay null for the authoritative turn-end to still be delivered (A1). So the
 * claim is what closes the window, and a genuine send failure must undo it
 * exactly, or one failed notice would silence the watchdog for that inbound
 * forever.
 */
export function claimWatchdogNotice(pending: PendingReply): () => void {
  const prior = {
    fallback_sent: pending.fallback_sent,
    reply_source: pending.reply_source,
    last_relayed_chunk: pending.last_relayed_chunk,
    placeholder_sent: pending.placeholder_sent,
  };
  pending.fallback_sent = true;
  return () => {
    pending.fallback_sent = prior.fallback_sent;
    pending.reply_source = prior.reply_source;
    pending.last_relayed_chunk = prior.last_relayed_chunk;
    pending.placeholder_sent = prior.placeholder_sent;
  };
}

export function markWatchdogNoticeSent(
  pending: PendingReply,
  source: 'auto_relay' | 'auto_placeholder',
  chunk?: string,
): void {
  // A watchdog notice is non-terminal: fallback_sent prevents repeat notices,
  // while replied_at remains free for the eventual authoritative reply.
  pending.fallback_sent = true;
  pending.reply_source = source;
  if (source === 'auto_relay') pending.last_relayed_chunk = chunk;
  if (source === 'auto_placeholder') pending.placeholder_sent = true;
}

export type TurnEndPayload = {
  provider: Provider;
  session_id: string;
  turn_id: string;
  assistant_text: string;
  cwd: string;
  transcript_path?: string;
  source: TurnSource;
};

export type TurnDeliveryOutcome =
  | 'delivered_layer1'
  | 'suppressed_unsolicited'
  | 'suppressed_by_explicit_reply'
  | 'suppressed_by_auto_relay'
  | 'suppressed_by_prior_delivery'
  | 'duplicate_turn';

export type TurnDeliveryRecord = {
  chat_id: string;
  outcome: TurnDeliveryOutcome;
  source: string;
  first_seen_at: number;
};

export type TurnClassification = 'solicited' | 'unsolicited' | 'rejected';

export type RelayDecision =
  | {
      action: 'reject';
      reason:
        | 'no_binding'
        | 'empty_assistant'
        | 'provider_mismatch'
        | 'session_mismatch'
        | 'bound_chat_mismatch';
    }
  | { action: 'dedup'; outcome: TurnDeliveryOutcome }
  | {
      action: 'deliver';
      classification: Exclude<TurnClassification, 'rejected'>;
      chat_id: string;
      reply_to_message_id?: number;
      outcome: 'delivered_layer1';
    }
  | {
      action: 'suppress';
      classification: Exclude<TurnClassification, 'rejected'>;
      outcome:
        | 'suppressed_unsolicited'
        | 'suppressed_by_explicit_reply'
        | 'suppressed_by_auto_relay'
        | 'suppressed_by_prior_delivery';
      chat_id: string;
    };

export type ClaudeStopHookPayload = {
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  transcript_path?: string | null;
  hook_event_name?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
};

export type CodexNotifyPayload = {
  type?: string;
  'thread-id'?: string;
  'turn-id'?: string;
  cwd?: string;
  'last-assistant-message'?: string | null;
};

export type CodexApprovalPrompt = {
  reason?: string;
  command: string;
};

export type CodexDecisionPrompt = {
  question: string;
  options: Array<{ index: number; label: string }>;
};

export type CodexPasteDeliveryState =
  | 'submitted'
  | 'queued'
  | 'stuck'
  | 'unknown';

export type MissionDoneCmd =
  | {
      kind: 'git_ref_changed';
      ref: string;
      baseline_sha?: string;
    }
  | Record<string, unknown>;

export type MissionRecord = {
  desc: string;
  created_at: string;
  status: string;
  done_cmd?: MissionDoneCmd;
};

export type MissionLedger =
  | {
      active?: MissionRecord | null;
    }
  | MissionRecord;

export type DoneCmdResult =
  | { state: 'completed'; detail: string; baseline_sha?: string }
  | { state: 'pending'; detail: string; baseline_sha?: string }
  | { state: 'cannot_verify'; detail: string };

export type StallInputs = {
  hasBinding: boolean;
  providerKnown: boolean;
  mission: MissionRecord | null;
  tmuxAlive: boolean;
  now: number;
  lastPaneProgressAt?: number;
  lastGitProgressAt?: number;
  lastAlertKey?: string | null;
  thresholdMs: number;
  doneCmdResult?: DoneCmdResult;
  /** Explicit task gate. False makes the watchdog completely passive. */
  hasTask?: boolean;
  /** Stable, multi-signal snapshot of real progress. */
  progressSignature?: string;
  previousProgressSignature?: string;
  stallTicks?: number;
  escalationTicks?: number;
};

export type WatchdogAlertClass =
  | 'session-dead'
  | 'mission-stalled'
  | 'delivery-detached'
  | 'binding-stale'
  | 'restart-failed'
  | 'restart-suppressed';

export const WATCHDOG_ALERT_CLASSES: readonly WatchdogAlertClass[] = [
  'session-dead',
  'mission-stalled',
  'delivery-detached',
  'binding-stale',
  'restart-failed',
  'restart-suppressed',
];

export type StallEvaluation =
  | { state: 'idle'; shouldAlert: false; reason: string; alertKey: null }
  | {
      state: 'dead' | 'stall';
      shouldAlert: boolean;
      reason: string;
      alertKey: string;
      alertClass?: WatchdogAlertClass;
      stallTicks?: number;
      shouldNudge?: boolean;
    };

export function buildProgressSignature(signals: {
  pane?: string;
  gitSha?: string;
  taskState?: string;
  agentExit?: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      pane: signals.pane ?? '',
      gitSha: signals.gitSha ?? '',
      taskState: signals.taskState ?? '',
      agentExit: signals.agentExit ?? '',
    }))
    .digest('hex');
}

export function watchdogAlertKey(
  alertClass: WatchdogAlertClass,
  progressSignature: string,
): string {
  return `${alertClass}:${progressSignature}`;
}

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const OSC_RE = /\x1b\][^\x07]*(\x07|\x1b\\)/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '').replace(OSC_RE, '');
}

export function maybeReadJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function parseClaudeStopPayload(
  payload: unknown,
): TurnEndPayload | null {
  const p = payload as ClaudeStopHookPayload;
  if (!p || typeof p !== 'object') return null;
  if (typeof p.session_id !== 'string' || typeof p.turn_id !== 'string') {
    return null;
  }
  return {
    provider: 'claude',
    session_id: p.session_id,
    turn_id: p.turn_id,
    assistant_text:
      typeof p.last_assistant_message === 'string'
        ? p.last_assistant_message
        : '',
    cwd: typeof p.cwd === 'string' ? p.cwd : '',
    transcript_path:
      typeof p.transcript_path === 'string' ? p.transcript_path : undefined,
    source: 'claude_stop_hook',
  };
}

export function parseCodexNotifyPayload(
  payload: unknown,
): TurnEndPayload | null {
  const p = payload as CodexNotifyPayload;
  if (!p || typeof p !== 'object') return null;
  if (p.type !== 'agent-turn-complete') return null;
  if (typeof p['thread-id'] !== 'string' || typeof p['turn-id'] !== 'string') {
    return null;
  }
  return {
    provider: 'codex',
    session_id: p['thread-id'],
    turn_id: p['turn-id'],
    assistant_text:
      typeof p['last-assistant-message'] === 'string'
        ? p['last-assistant-message']
        : '',
    cwd: typeof p.cwd === 'string' ? p.cwd : '',
    source: 'codex_notify',
  };
}

export function normalizeRelayPayload(payload: unknown): TurnEndPayload | null {
  const claude = parseClaudeStopPayload(payload);
  if (claude) return claude;
  return parseCodexNotifyPayload(payload);
}

export function parseClaudeAssistantChunk(pane: string): string | null {
  const lines = stripAnsi(pane).split('\n');
  let chunkStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trimStart().startsWith('⏺')) {
      chunkStart = i;
      break;
    }
  }
  if (chunkStart === -1) return null;

  let chunkEnd = lines.length;
  for (let i = chunkStart + 1; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.startsWith('⏺') || trimmed.startsWith('⎿')) {
      chunkEnd = i;
      break;
    }
    const bars = lines[i].match(/─/g)?.length ?? 0;
    if (lines[i].length >= 20 && bars / lines[i].length >= 0.7) {
      chunkEnd = i;
      break;
    }
  }

  const raw = lines
    .slice(chunkStart, chunkEnd)
    .map((line) => line.replace(/^\s*⏺\s*/, ''))
    .join('\n')
    .trim();
  return raw || null;
}

export function parseCodexAssistantChunk(pane: string): string | null {
  const lines = stripAnsi(pane).split('\n');
  let chunkStart = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === 'Queued follow-up inputs') continue;
    if (!trimmed.startsWith('• ')) continue;
    if (isCodexToolStatus(trimmed.replace(/^\s*•\s*/, ''))) continue;
    chunkStart = i;
    break;
  }
  if (chunkStart === -1) return null;

  const out: string[] = [];
  for (let i = chunkStart; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) {
      if (out.length > 0) break;
      continue;
    }
    if (i > chunkStart && /^• /.test(trimmed)) break;
    if (
      /^└ /.test(trimmed) ||
      /^› /.test(trimmed) ||
      /^• Working \(/.test(trimmed)
    )
      break;
    const bars = raw.match(/─/g)?.length ?? 0;
    if (raw.length >= 20 && bars / raw.length >= 0.7) break;
    out.push(i === chunkStart ? raw.replace(/^\s*•\s*/, '') : raw);
  }

  const joined = out.join('\n').trim();
  return joined || null;
}

function isCodexToolStatus(text: string): boolean {
  if (!text) return true;
  if (text === 'Explored') return true;
  if (text === 'Updated plan') return true;
  if (text === 'Queued follow-up inputs') return true;
  if (text.startsWith('Working (')) return true;
  if (text.startsWith('Ran ')) return true;
  if (text.startsWith('Running ')) return true;
  if (text.startsWith('Read ')) return true;
  if (text.startsWith('List ')) return true;
  if (text.startsWith('Search ')) return true;
  if (text.startsWith('Find ')) return true;
  return false;
}

export function parseCodexApprovalPrompt(
  pane: string,
): CodexApprovalPrompt | null {
  const lines = stripAnsi(pane)
    .split('\n')
    .map((line) => line.trim());
  const promptIdx = lines.findIndex((line) =>
    /Would you like to run the following command\?/i.test(line),
  );
  if (promptIdx === -1) return null;

  let reason: string | undefined;
  let command = '';
  for (let i = promptIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const reasonMatch = /^Reason:\s*(.+)$/.exec(line);
    if (reasonMatch) {
      reason = reasonMatch[1].trim();
      continue;
    }
    const commandMatch = /^\$\s+(.+)$/.exec(line);
    if (commandMatch) {
      command = commandMatch[1].trim();
      break;
    }
  }

  if (!command) return null;
  const tail = lines.slice(promptIdx).join('\n');
  if (!/\bYes,\s*proceed\b/i.test(tail)) return null;
  if (!/\bdon't ask again\b/i.test(tail)) return null;
  if (!/\bNo,\s*and tell Codex what to do differently\b/i.test(tail)) {
    return null;
  }
  return { reason, command };
}

export function parseCodexDecisionPrompt(
  pane: string,
): CodexDecisionPrompt | null {
  const rawLines = stripAnsi(pane).split('\n');
  let start = -1;
  for (let i = rawLines.length - 1; i >= 0; i--) {
    const trimmed = rawLines[i].trim();
    if (!trimmed.startsWith('• ')) continue;
    if (isCodexToolStatus(trimmed.replace(/^\s*•\s*/, ''))) continue;
    start = i;
    break;
  }
  if (start === -1) return null;

  const lines = rawLines
    .slice(start)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^› /.test(line)) return false;
      const bars = line.match(/─/g)?.length ?? 0;
      if (line.length >= 20 && bars / line.length >= 0.7) return false;
      return true;
    })
    .map((line, index) => (index === 0 ? line.replace(/^•\s*/, '') : line));
  const options: Array<{ index: number; label: string }> = [];
  let firstOptionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\d+)\.\s+(.+)$/.exec(lines[i]);
    if (!match) continue;
    if (firstOptionIdx === -1) firstOptionIdx = i;
    options.push({ index: Number(match[1]), label: match[2].trim() });
  }
  if (options.length < 2 || firstOptionIdx <= 0) return null;
  if (!looksLikeActionableDecisionOptions(options)) return null;
  const questionLines = lines.slice(0, firstOptionIdx);
  const question =
    [...questionLines].reverse().find((line) => /[?？]\s*$/.test(line)) ??
    questionLines[questionLines.length - 1];
  if (!question) return null;
  if (!looksLikeDecisionQuestion(question, questionLines)) return null;
  return { question, options };
}

function looksLikeDecisionQuestion(
  question: string,
  contextLines: string[],
): boolean {
  const context = contextLines.join('\n').toLowerCase();
  const q = question.toLowerCase();
  return (
    /як діємо|що робимо|що далі|який варіант|обери|вибери|підтверд|апрув|approve|продовж|скасов|зупин|which option|choose|how should|proceed|continue|confirm|decision/.test(
      `${context}\n${q}`,
    ) || /^(так|ні|yes|no)[?？]?$/.test(q)
  );
}

function looksLikeActionableDecisionOptions(
  options: Array<{ index: number; label: string }>,
): boolean {
  return options.every((option) => {
    const label = option.label.trim();
    if (looksLikeFileReference(label)) return false;
    return (
      /^(так|ні|yes|no|approve|deny|allow|cancel|stop|continue|proceed|run|skip|retry|запуска|зупин|продовж|скас|повтор|пропуст|дозвол|відхил|коміт|схов|тест|перезапуст)/i.test(
        label,
      ) ||
      /\b(запуска|зупин|продовж|скас|повтор|дозвол|відхил|run|stop|continue|cancel|retry)\b/i.test(
        label,
      )
    );
  });
}

function looksLikeFileReference(label: string): boolean {
  if (/^[./~\w-]+\/[\w./-]+:\d+(:\d+)?$/.test(label)) return true;
  if (/\.(spec|test|ts|tsx|js|jsx|py|md|json|yaml|yml):\d+/.test(label)) {
    return true;
  }
  return false;
}

export function parseAssistantChunk(
  provider: Provider,
  pane: string,
): string | null {
  return provider === 'codex'
    ? parseCodexAssistantChunk(pane)
    : parseClaudeAssistantChunk(pane);
}

export function parseAssistantChunkAfterTelegramMessage(
  provider: Provider,
  pane: string,
  messageId: number | string | undefined,
): string | null {
  if (messageId == null) return parseAssistantChunk(provider, pane);
  const lines = stripAnsi(pane).split('\n');
  const marker = `message_id="${messageId}"`;
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(marker)) {
      start = i;
      break;
    }
  }
  if (start === -1) return parseAssistantChunk(provider, pane);
  return parseAssistantChunk(provider, lines.slice(start + 1).join('\n'));
}

export function codexPasteMarker(text: string): string {
  const messageId = /message_id="([^"]+)"/.exec(text)?.[1];
  if (messageId) return `message_id="${messageId}"`;
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.slice(0, 120) ?? text.slice(0, 120)
  );
}

export function detectCodexPasteDeliveryState(
  pane: string,
  marker: string,
): CodexPasteDeliveryState {
  const lines = stripAnsi(pane).split('\n');
  let markerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(marker)) {
      markerIdx = i;
      break;
    }
  }
  if (markerIdx === -1) return 'unknown';

  const afterMarker = lines.slice(markerIdx + 1);
  if (afterMarker.some((line) => line.trimStart().startsWith('•'))) {
    return 'submitted';
  }

  let queuedIdx = -1;
  for (let i = markerIdx - 1; i >= 0; i--) {
    if (lines[i].trim() === 'Queued follow-up inputs') {
      queuedIdx = i;
      break;
    }
  }
  if (queuedIdx !== -1) {
    const between = lines.slice(queuedIdx + 1, markerIdx);
    const crossedTurnBoundary = between.some((line) => {
      const trimmed = line.trimStart();
      const bars = line.match(/─/g)?.length ?? 0;
      return (
        trimmed.startsWith('› ') ||
        trimmed.startsWith('•') ||
        (line.length >= 20 && bars / line.length >= 0.7)
      );
    });
    if (!crossedTurnBoundary) return 'queued';
  }

  const tail = lines
    .slice(Math.max(0, lines.length - 12))
    .join('\n')
    .trim();
  if (tail.includes(marker)) return 'stuck';
  return 'unknown';
}

export function classifyTurn(params: {
  binding: PersistedBinding | null;
  pending: PendingReply | undefined;
  turn_session_id: string;
  started_at: number;
}): TurnClassification {
  const { binding, pending, turn_session_id, started_at } = params;
  if (!binding) return 'rejected';
  if (
    binding.provider !== 'codex' &&
    binding.session_id &&
    binding.session_id !== turn_session_id
  ) {
    return 'unsolicited';
  }
  if (!pending) return 'unsolicited';
  if (pending.replied_at != null) return 'unsolicited';
  if (started_at >= pending.opened_at) return 'solicited';
  return 'unsolicited';
}

export function decideRelay(params: {
  binding: PersistedBinding | null;
  configuredBoundChatId: string | null;
  pending: PendingReply | undefined;
  payload: TurnEndPayload;
  started_at: number;
  existingDelivery?: TurnDeliveryRecord;
}): RelayDecision {
  const {
    binding,
    configuredBoundChatId,
    pending,
    payload,
    started_at,
    existingDelivery,
  } = params;
  const assistant = payload.assistant_text.trim();
  if (!assistant) return { action: 'reject', reason: 'empty_assistant' };
  if (!binding) return { action: 'reject', reason: 'no_binding' };
  if (binding.provider !== payload.provider) {
    return { action: 'reject', reason: 'provider_mismatch' };
  }
  if (
    configuredBoundChatId &&
    binding.bound_chat_id !== configuredBoundChatId
  ) {
    return { action: 'reject', reason: 'bound_chat_mismatch' };
  }
  if (existingDelivery) {
    return { action: 'dedup', outcome: existingDelivery.outcome };
  }
  const pendingCanClaimTurn =
    payload.provider === 'codex' &&
    !!pending &&
    pending.replied_at == null &&
    started_at >= pending.opened_at;
  if (
    binding.session_id &&
    binding.session_id !== payload.session_id &&
    !pendingCanClaimTurn
  ) {
    return { action: 'reject', reason: 'session_mismatch' };
  }
  if (
    pending &&
    started_at >= pending.opened_at &&
    pending.reply_source === 'explicit_reply'
  ) {
    return {
      action: 'suppress',
      classification: 'solicited',
      outcome: 'suppressed_by_explicit_reply',
      chat_id: binding.bound_chat_id,
    };
  }
  if (
    pending &&
    started_at >= pending.opened_at &&
    (pending.reply_source === 'auto_relay' ||
      pending.reply_source === 'auto_placeholder')
  ) {
    const relayed = pending.last_relayed_chunk?.trim();
    if (pending.reply_source === 'auto_relay' && relayed === assistant) {
      return {
        action: 'suppress',
        classification: 'solicited',
        outcome: 'suppressed_by_auto_relay',
        chat_id: binding.bound_chat_id,
      };
    }
  }
  if (
    pending &&
    started_at >= pending.opened_at &&
    pending.reply_source === 'layer1'
  ) {
    return {
      action: 'suppress',
      classification: 'solicited',
      outcome: 'suppressed_by_prior_delivery',
      chat_id: binding.bound_chat_id,
    };
  }

  const classification = classifyTurn({
    binding,
    pending,
    turn_session_id: payload.session_id,
    started_at,
  });
  if (classification === 'rejected') {
    return { action: 'reject', reason: 'no_binding' };
  }
  if (classification === 'unsolicited') {
    // Codex surfaces ALL its output via the notify turn-end relay (it has no MCP
    // reply channel). Suppressing "unsolicited" turns hides the orchestrator's
    // autonomous progress — the Human sees nothing while codex works. So for
    // codex, deliver unsolicited turns (deduped by turn_id upstream); only the
    // MCP-channel providers (claude) suppress to avoid double-posting.
    if (payload.provider === 'codex') {
      return {
        action: 'deliver',
        classification,
        chat_id: binding.bound_chat_id,
        outcome: 'delivered_layer1',
      };
    }
    return {
      action: 'suppress',
      classification,
      chat_id: binding.bound_chat_id,
      outcome: 'suppressed_unsolicited',
    };
  }
  return {
    action: 'deliver',
    classification,
    chat_id: binding.bound_chat_id,
    reply_to_message_id: pending?.messageId,
    outcome: 'delivered_layer1',
  };
}

export function loadMissionRecord(raw: unknown): MissionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const ledger = raw as MissionLedger;
  const candidate =
    'active' in ledger ? (ledger.active ?? null) : (ledger as MissionRecord);
  if (!candidate || typeof candidate !== 'object') return null;
  if (
    typeof candidate.desc !== 'string' ||
    typeof candidate.created_at !== 'string' ||
    typeof candidate.status !== 'string'
  ) {
    return null;
  }
  return candidate;
}

export function missionIsActive(mission: MissionRecord | null): boolean {
  if (!mission) return false;
  return !['done', 'complete', 'completed', 'cancelled', 'canceled'].includes(
    mission.status.toLowerCase(),
  );
}

export function buildMissionKey(mission: MissionRecord): string {
  return `${mission.created_at}:${mission.desc}`;
}

export function sanitizeChatRegion(provider: Provider, pane: string): string {
  const cleaned = stripAnsi(pane).split('\n');
  const filtered = cleaned.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (provider === 'codex') {
      if (trimmed.startsWith('› ')) return false;
      if (trimmed.startsWith('• Working (')) return false;
    }
    return true;
  });
  return filtered.join('\n');
}

export function evaluateStall(inputs: StallInputs): StallEvaluation {
  const {
    hasBinding,
    providerKnown,
    mission,
    tmuxAlive,
    now,
    lastPaneProgressAt,
    lastGitProgressAt,
    lastAlertKey,
    thresholdMs,
    doneCmdResult,
    hasTask = missionIsActive(mission),
    progressSignature,
    previousProgressSignature,
    stallTicks = 0,
    escalationTicks = 1,
  } = inputs;
  // No bound provider session at all: there is nothing the operator asked to
  // be running, so silence is correct.
  if (!hasBinding || !providerKnown) {
    return {
      state: 'idle',
      shouldAlert: false,
      reason: 'idle',
      alertKey: null,
    };
  }
  if (!hasTask) {
    return {
      state: 'idle',
      shouldAlert: false,
      reason: 'no_task',
      alertKey: null,
    };
  }
  if (doneCmdResult?.state === 'completed') {
    return {
      state: 'idle',
      shouldAlert: false,
      reason: 'done_cmd_completed',
      alertKey: null,
    };
  }
  // Alert identities include the frozen progress signature: repeats suppress,
  // while any genuine progress arms the same alert class again.
  const keyBase =
    progressSignature ||
    (mission ? buildMissionKey(mission) : 'bound-session');
  if (!tmuxAlive) {
    const alertKey = watchdogAlertKey('session-dead', keyBase);
    return {
      state: 'dead',
      shouldAlert: lastAlertKey !== alertKey,
      reason: 'tmux_missing',
      alertKey,
      alertClass: 'session-dead',
    };
  }
  if (progressSignature && progressSignature !== previousProgressSignature) {
    return {
      state: 'idle',
      shouldAlert: false,
      reason: 'progress',
      alertKey: null,
    };
  }
  const lastProgressAt = Math.max(
    lastPaneProgressAt ?? 0,
    lastGitProgressAt ?? 0,
  );
  if (!lastProgressAt || now - lastProgressAt < thresholdMs) {
    return {
      state: 'idle',
      shouldAlert: false,
      reason: 'within_threshold',
      alertKey: null,
    };
  }
  const nextStallTicks = stallTicks + 1;
  const alertKey = watchdogAlertKey('mission-stalled', keyBase);
  return {
    state: 'stall',
    shouldAlert: nextStallTicks >= escalationTicks && lastAlertKey !== alertKey,
    reason: 'no_progress',
    alertKey,
    alertClass: 'mission-stalled',
    stallTicks: nextStallTicks,
    shouldNudge: nextStallTicks < escalationTicks,
  };
}

export type WatchdogTimeoutConfig = {
  pendingReplyTimeoutMs: number;
  codexFallbackTimeoutMs: number;
  watchdogTickMs: number;
};

function positiveNumberOrDefault(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getWatchdogTimeoutConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WatchdogTimeoutConfig {
  return {
    pendingReplyTimeoutMs: positiveNumberOrDefault(
      env.ORCH_PENDING_REPLY_TIMEOUT_MS,
      300_000,
    ),
    codexFallbackTimeoutMs: positiveNumberOrDefault(
      env.ORCH_CODEX_FALLBACK_TIMEOUT_MS,
      90_000,
    ),
    watchdogTickMs: positiveNumberOrDefault(
      env.ORCH_WATCHDOG_TICK_MS,
      15_000,
    ),
  };
}

export function isPendingReplyTimedOut(
  openedAt: number,
  now: number,
  timeoutMs: number,
): boolean {
  return now - openedAt >= timeoutMs;
}
