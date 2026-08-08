import type { PendingReply, Provider } from './reliability';

export const CODEX_PROGRESS_INTERVAL_MS = 90_000;
export const CODEX_HEARTBEAT_AFTER_MS = 240_000;
export const CODEX_MIDTURN_POLL_MS = 5_000;
export const CODEX_MIDTURN_MAX_BODY = 3_500;
export const CODEX_STILL_WORKING =
  'Codex ще не передав фінальну відповідь; канал живий. Наступний змістовний прогрес або фінал надійде сюди.';

export function codexFinalEditTarget(
  pending: PendingReply | undefined,
): number | undefined {
  return pending?.reply_source === 'auto_relay' &&
    (pending.midturn_message_count ?? 1) === 1
    ? pending.relay_message_id
    : undefined;
}

export function shouldStartCodexMidTurnRelay(
  provider: Provider | undefined,
  pasteSucceeded = true,
): boolean {
  return provider === 'codex' && pasteSucceeded;
}

export function startCodexRelayAfterPaste(
  provider: Provider | undefined,
  pasteSucceeded: boolean,
  chatId: string | undefined,
  start: (chatId: string) => void,
): boolean {
  if (!chatId || !shouldStartCodexMidTurnRelay(provider, pasteSucceeded)) {
    return false;
  }
  start(chatId);
  return true;
}

export type CodexMidTurnResult =
  | 'inactive'
  | 'busy'
  | 'idle'
  | 'sent'
  | 'retry';

export type CodexMidTurnDeps = {
  getPending(chatId: string): PendingReply | undefined;
  extract(pending: PendingReply): Promise<string | null>;
  send(pending: PendingReply, body: string): Promise<number>;
  now(): number;
  failure(message: string): void;
};

export type CodexMidTurnLoopDeps = {
  getPending(chatId: string): PendingReply | undefined;
  sleep(delayMs: number): Promise<void>;
  failureDelayMs?: number;
  tick(chatId: string, requestId: string): Promise<CodexMidTurnResult>;
  maybeApproval(chatId: string): Promise<boolean>;
  maybeDecision(chatId: string): Promise<boolean>;
  failure(message: string): void;
};

export async function runCodexMidTurnLoop(
  chatId: string,
  deps: CodexMidTurnLoopDeps,
): Promise<void> {
  const pending = deps.getPending(chatId);
  if (!pending || pending.fast_relay_started) return;
  pending.fast_relay_started = true;
  const requestId = pending.pending_request_id;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await deps.sleep(attempt === 0 ? 800 : CODEX_MIDTURN_POLL_MS);
        const current = deps.getPending(chatId);
        if (!current || current.pending_request_id !== requestId) return;
        if (current.replied_at != null) return;
        if (await deps.maybeApproval(chatId)) continue;
        if (await deps.maybeDecision(chatId)) continue;
        await deps.tick(chatId, requestId);
      } catch (error) {
        deps.failure(
          `codex mid-turn owner tick FAILED chat=${chatId} request=${requestId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, deps.failureDelayMs ?? CODEX_MIDTURN_POLL_MS),
        );
      }
    }
  } finally {
    const current = deps.getPending(chatId);
    if (current === pending && current.pending_request_id === requestId) {
      current.fast_relay_started = false;
    }
  }
}

function boundedBody(chunk: string): string {
  const trimmed = chunk.trim();
  return trimmed.length > CODEX_MIDTURN_MAX_BODY
    ? `${trimmed.slice(0, CODEX_MIDTURN_MAX_BODY)}\n…`
    : trimmed;
}

/**
 * One coalescing relay per pending Telegram request. `tick` is deliberately
 * scheduler-free: production drives it with one loop, while deterministic
 * tests can race and advance a fake clock without sleeping.
 */
export class CodexMidTurnRelay {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: CodexMidTurnDeps) {}

  async tick(chatId: string, requestId: string): Promise<CodexMidTurnResult> {
    const key = `${chatId}\n${requestId}`;
    const initial = this.deps.getPending(chatId);
    if (
      !initial ||
      initial.pending_request_id !== requestId ||
      initial.replied_at != null
    ) {
      return 'inactive';
    }
    if (this.inFlight.has(key)) return 'busy';
    this.inFlight.add(key);
    try {
      const chunk = await this.deps.extract(initial);
      const current = this.deps.getPending(chatId);
      if (
        current !== initial ||
        current.pending_request_id !== requestId ||
        current.replied_at != null
      ) {
        return 'inactive';
      }

      const now = this.deps.now();
      const normalizedChunk = chunk?.trim() || null;
      const meaningful =
        normalizedChunk &&
        normalizedChunk !== current.baseline_assistant_chunk?.trim() &&
        normalizedChunk !== current.last_relayed_chunk?.trim()
          ? normalizedChunk
          : null;
      const messageCount = current.midturn_message_count ?? 0;
      const hasSent = messageCount > 0;
      const firstMeaningful = meaningful && current.last_relayed_chunk == null;
      const progressDue =
        meaningful &&
        (!hasSent ||
          firstMeaningful ||
          now - (current.midturn_last_sent_at ?? 0) >=
            CODEX_PROGRESS_INTERVAL_MS);
      const heartbeatDue =
        now - (current.midturn_last_sent_at ?? current.opened_at) >=
        CODEX_HEARTBEAT_AFTER_MS;

      if (!progressDue && !heartbeatDue) return 'idle';

      const body = progressDue ? boundedBody(meaningful!) : CODEX_STILL_WORKING;
      try {
        const messageId = await this.deps.send(current, body);
        if (this.deps.getPending(chatId) !== current) return 'inactive';
        const nextCount = messageCount + 1;
        current.midturn_message_count = nextCount;
        if (nextCount === 1) {
          current.relay_message_id = messageId;
        } else {
          // More than one mid-turn message means an early preview is no longer
          // the chronological place for the final. Force turn-end to send the
          // authoritative answer as a fresh message.
          current.relay_message_id = undefined;
        }
        current.reply_source = 'auto_relay';
        current.fallback_sent = true;
        current.placeholder_sent = !progressDue;
        current.last_relayed_chunk = progressDue
          ? meaningful!
          : current.last_relayed_chunk;
        current.midturn_last_sent_at = now;
        return 'sent';
      } catch (error) {
        this.deps.failure(
          `codex mid-turn relay FAILED chat=${chatId} request=${requestId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return 'retry';
      }
    } catch (error) {
      this.deps.failure(
        `codex mid-turn extract FAILED chat=${chatId} request=${requestId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'retry';
    } finally {
      this.inFlight.delete(key);
    }
  }
}
