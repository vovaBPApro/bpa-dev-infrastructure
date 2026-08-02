import { readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

export function resolveOrchestratorLauncher(installRoot: string): string {
  return join(installRoot, 'orchestrator', 'launch.sh');
}

export type OutboxTransport = (chatId: string, text: string) => Promise<unknown>;
export type OutboxLogger = (message: string) => void;

// Process one line at a time.  The compare-before-ack avoids overwriting a
// concurrent atomic writer; in that case the already-sent line is retried,
// which is preferable to silently losing another alert.
export async function drainOutbox(
  file: string,
  chatId: string,
  send: OutboxTransport,
  log: OutboxLogger,
  beforeAck?: () => void,
): Promise<number> {
  let delivered = 0;
  for (;;) {
    let original: string;
    try {
      original = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return delivered;
      throw err;
    }
    if (original === '') return delivered;
    const lines = original.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    if (lines.length === 0) return delivered;
    const line = lines[0];
    if (!line?.trim()) {
      log(`outbox malformed line skipped file=${file}`);
    } else {
      await send(chatId, line);
      delivered++;
    }
    beforeAck?.();
    // A writer changed the file while this alert was in flight. Do not ack
    // against stale content: duplicate delivery is acceptable; loss is not.
    let current: string;
    try {
      current = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return delivered;
      throw err;
    }
    if (current !== original) return delivered;
    const remaining = lines.slice(1);
    const temp = `${file}.drain-${process.pid}.tmp`;
    writeFileSync(temp, remaining.length ? `${remaining.join('\n')}\n` : '');
    renameSync(temp, file);
  }
}
