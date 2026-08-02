import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BotApiClient, type InboundStore } from './adapters/telegram';
import { withFileLock } from './file-lock';

export type OutboxItem = {
  id: string;
  chatId: string;
  text: string;
  state: 'pending' | 'sending' | 'delivered';
  attempts: number;
  attemptedEpochs: string[];
  lastError?: string;
  deliveredMessageId?: number;
};

type OutboxFile = { version: 1; items: OutboxItem[] };

export class DurableOutbox {
  constructor(
    private readonly path: string,
    private readonly send: (chatId: string, text: string, idempotencyKey: string) => Promise<{ message_id: number }>,
    private readonly recoveryEpoch: string = crypto.randomUUID(),
    private readonly reconcile: (idempotencyKey: string) => Promise<{ message_id: number } | null> = async () => null,
  ) {}

  async enqueue(item: Pick<OutboxItem, 'id' | 'chatId' | 'text'>): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true });
    return withFileLock(this.path, async () => {
      const file = await this.#read();
      if (file.items.some((existing) => existing.id === item.id)) return false;
      file.items.push({ ...item, state: 'pending', attempts: 0, attemptedEpochs: [] });
      await this.#write(file);
      return true;
    });
  }

  async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await withFileLock(this.path, async () => {
      const file = await this.#read();
      for (const item of file.items) {
        if (item.state === 'delivered' || item.attemptedEpochs.includes(this.recoveryEpoch)) continue;
        if (item.state === 'sending') {
          const reconciled = await this.reconcile(item.id);
          if (reconciled) {
            item.state = 'delivered';
            item.deliveredMessageId = reconciled.message_id;
            delete item.lastError;
          } else {
            item.lastError = 'delivery confirmation pending reconciliation';
          }
          await this.#write(file);
          continue;
        }
        item.attempts++;
        item.attemptedEpochs.push(this.recoveryEpoch);
        item.state = 'sending';
        await this.#write(file);
        try {
          const sent = await this.send(item.chatId, item.text, item.id);
          item.state = 'delivered';
          item.deliveredMessageId = sent.message_id;
          delete item.lastError;
        } catch (error) {
          item.state = 'pending';
          item.lastError = error instanceof Error ? error.message : String(error);
        }
        await this.#write(file);
      }
    });
  }

  async items(): Promise<OutboxItem[]> {
    await mkdir(dirname(this.path), { recursive: true });
    return withFileLock(this.path, async () => (await this.#read()).items);
  }

  async #read(): Promise<OutboxFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as OutboxFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error('invalid outbox state');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, items: [] };
      throw error;
    }
  }

  async #write(file: OutboxFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export function createProductionTelegramOutbox(path: string, api: BotApiClient): DurableOutbox {
  return new DurableOutbox(
    path,
    (chatId, text, idempotencyKey) => api.sendMessage(chatId, text, idempotencyKey),
    crypto.randomUUID(),
    (idempotencyKey) => api.reconcileMessage(idempotencyKey),
  );
}

export type TelegramChannelStatus = {
  state: 'healthy' | 'degraded' | 'unknown';
  inboxCount?: number;
  pendingCount?: number;
  deliveredCount?: number;
  lastError?: string;
};

export async function telegramChannelStatus(
  inbox: InboundStore,
  outbox: DurableOutbox,
): Promise<TelegramChannelStatus> {
  try {
    const [inboxCount, items] = await Promise.all([inbox.count(), outbox.items()]);
    const pending = items.filter((item) => item.state !== 'delivered');
    const lastError = pending.map((item) => item.lastError).filter(Boolean).at(-1);
    return {
      state: pending.length > 0 ? 'degraded' : 'healthy',
      inboxCount,
      pendingCount: pending.length,
      deliveredCount: items.length - pending.length,
      ...(lastError ? { lastError } : {}),
    };
  } catch {
    return { state: 'unknown' };
  }
}
