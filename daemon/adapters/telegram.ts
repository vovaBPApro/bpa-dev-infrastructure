import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withFileLock } from '../file-lock';

export type TelegramUpdate = {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
};

export interface InboundStore {
  putIfAbsent(update: TelegramUpdate): Promise<boolean>;
  count(): Promise<number>;
}

export class FileInboundStore implements InboundStore {
  constructor(private readonly path: string) {}

  async putIfAbsent(update: TelegramUpdate): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true });
    return withFileLock(this.path, async () => {
      const updates = await this.#read();
      if (updates.some((item) => item.update_id === update.update_id)) return false;
      updates.push(update);
      const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(updates, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
      return true;
    });
  }

  async count(): Promise<number> {
    return (await this.#read()).length;
  }

  async #read(): Promise<TelegramUpdate[]> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!Array.isArray(value)) throw new Error('invalid inbox state');
      return value as TelegramUpdate[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}

export type BotApiOptions = {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class BotApiClient {
  readonly #fetch: FetchLike;
  readonly #apiRoot: string;

  constructor(options: BotApiOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#apiRoot = `${options.baseUrl.replace(/\/$/, '')}/bot${options.token}`;
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    const query = offset === undefined ? '' : `?offset=${offset}`;
    const response = await this.#fetch(`${this.#apiRoot}/getUpdates${query}`);
    if (!response.ok) throw new Error(`getUpdates failed: HTTP ${response.status}`);
    const body = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] };
    if (!body.ok || !Array.isArray(body.result)) throw new Error('getUpdates returned an invalid response');
    return body.result;
  }

  async sendMessage(chatId: string, text: string): Promise<{ message_id: number }> {
    const response = await this.#fetch(`${this.#apiRoot}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) throw new Error(`sendMessage failed: HTTP ${response.status}`);
    const body = (await response.json()) as { ok: boolean; result?: { message_id: number } };
    if (!body.ok || !body.result) throw new Error('sendMessage returned an invalid response');
    return body.result;
  }
}

export class TelegramAdapter {
  #offset?: number;

  constructor(
    private readonly api: BotApiClient,
    private readonly inbox: InboundStore,
    private readonly acknowledge: (update: TelegramUpdate) => Promise<void>,
  ) {}

  async receiveOnce(): Promise<number> {
    const updates = await this.api.getUpdates(this.#offset);
    for (const update of updates) {
      const inserted = await this.inbox.putIfAbsent(update);
      if (inserted) await this.acknowledge(update);
      this.#offset = Math.max(this.#offset ?? 0, update.update_id + 1);
    }
    return updates.length;
  }
}
