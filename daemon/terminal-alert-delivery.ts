export type JournalSink = {
  once(event: 'error' | 'drain', listener: (...args: any[]) => void): unknown;
  off(event: 'error' | 'drain', listener: (...args: any[]) => void): unknown;
  write(
    chunk: string,
    callback: (error?: Error | null) => void,
  ): boolean;
};

export type TerminalAlertDeliveryDependencies = {
  journal: JournalSink;
  acceptanceTimeoutMs?: number;
};

export const TERMINAL_ALERT_JOURNAL_PREFIX = '[terminal-alert] ';
export const TERMINAL_ALERT_JOURNAL_FRAME_LIMIT = 16_384;

export function composeTerminalAlertJournalLine(frame: string): string {
  const encoded = JSON.stringify(frame);
  const line = `${TERMINAL_ALERT_JOURNAL_PREFIX}${encoded}\n`;
  if (line.length > TERMINAL_ALERT_JOURNAL_FRAME_LIMIT) {
    throw new Error('terminal alert journal frame exceeds bounded limit');
  }
  return line;
}

/**
 * Terminal alerts cross an out-of-band boundary exactly once: the daemon
 * journal. Never route them through MCP notifications or tmux. Both surfaces
 * are rendered in the pane that terminal-alert.ts watches, which makes any
 * in-band delivery (including an allegedly inert pointer) a feedback edge.
 */
export async function deliverTerminalAlert(
  frame: string,
  deps: TerminalAlertDeliveryDependencies,
): Promise<void> {
  const line = composeTerminalAlertJournalLine(frame);
  const timeoutMs = deps.acceptanceTimeoutMs ?? 5_000;

  await new Promise<void>((resolve, reject) => {
    let callbackAccepted = false;
    let drainAccepted = false;
    let settled = false;
    let needsDrain = false;
    let returnKnown = false;
    let acceptanceScheduled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      deps.journal.off('error', onError);
      deps.journal.off('drain', onDrain);
    };
    const finish = (): void => {
      if (
        !settled &&
        returnKnown &&
        callbackAccepted &&
        (!needsDrain || drainAccepted) &&
        !acceptanceScheduled
      ) {
        acceptanceScheduled = true;
        setImmediate(() => {
          if (settled) return;
          acceptanceScheduled = false;
          if (
            !returnKnown ||
            !callbackAccepted ||
            (needsDrain && !drainAccepted)
          ) return;
          settled = true;
          cleanup();
          resolve();
        });
      }
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onError = (error: Error): void => fail(error);
    const onDrain = (): void => {
      // A sink may emit drain from inside write(), before its return value says
      // whether this write was backpressured. That event describes earlier
      // work and must not satisfy this write. Re-arm immediately so a genuine
      // drain cannot be lost between write() returning and our state update.
      if (!returnKnown) {
        deps.journal.once('drain', onDrain);
        return;
      }
      if (!needsDrain) return;
      drainAccepted = true;
      finish();
    };
    const timer = setTimeout(
      () => fail(new Error('terminal alert journal acceptance timed out')),
      timeoutMs,
    );

    deps.journal.once('error', onError);
    deps.journal.once('drain', onDrain);
    try {
      const accepted = deps.journal.write(line, (error?: Error | null) => {
        if (error) {
          fail(error);
          return;
        }
        callbackAccepted = true;
        finish();
      });
      needsDrain = !accepted;
      returnKnown = true;
      finish();
    } catch (error) {
      fail(error);
    }
  });
}
