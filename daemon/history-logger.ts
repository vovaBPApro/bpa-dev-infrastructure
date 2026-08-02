import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';

export type HistoryEntry = {
  ts: string;
  direction: 'in' | 'out';
  outcome: 'received' | 'delivered' | 'failed';
  chat_id: string;
  user: string;
  message_id?: number;
  reply_to?: number;
  type: string;
  kind?: string;
  content_length: number;
  content_sha256?: string;
};

type Payload = {
  chat_id?: string | number;
  text?: string;
  caption?: string;
  reply_parameters?: { message_id?: number };
};
type Result = { message_id?: number } | null | undefined;
type Logger = (entry: HistoryEntry) => void;

const METHODS = new Set(['sendMessage', 'sendPhoto', 'sendDocument', 'editMessageText']);
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
let writeQueue: Promise<void> = Promise.resolve();

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function historyDir(): string {
  return join(process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram'), 'history');
}

function historyFile(now = new Date()): string {
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return join(historyDir(), `messages-${ym}.jsonl`);
}

export function contentFingerprint(content: string): Pick<HistoryEntry, 'content_length' | 'content_sha256'> {
  const bytes = Buffer.from(content, 'utf8');
  return {
    content_length: bytes.length,
    ...(bytes.length ? { content_sha256: createHash('sha256').update(bytes).digest('hex') } : {}),
  };
}

async function enforceRetention(now = Date.now()): Promise<void> {
  const dir = historyDir();
  const cutoff = now - positiveInt(process.env.TELEGRAM_HISTORY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS) * 86_400_000;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/^messages-\d{4}-\d{2}\.jsonl$/.test(name)) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(path, { force: true });
  }
}

async function trimForAppend(path: string, incomingBytes: number): Promise<boolean> {
  const maxBytes = positiveInt(process.env.TELEGRAM_HISTORY_MAX_BYTES, DEFAULT_MAX_BYTES);
  if (incomingBytes > maxBytes) return false;
  const info = await stat(path).catch(() => null);
  if (!info || info.size + incomingBytes <= maxBytes) return true;
  const data = await readFile(path, 'utf8');
  const lines = data.split('\n').filter(Boolean);
  while (lines.length && Buffer.byteLength(`${lines.join('\n')}\n`) + incomingBytes > maxBytes) lines.shift();
  const tmp = `${path}.tmp`;
  await writeFile(tmp, lines.length ? `${lines.join('\n')}\n` : '', { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
  return true;
}

async function append(entry: HistoryEntry): Promise<void> {
  try {
    const dir = historyDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await enforceRetention();
    const line = `${JSON.stringify(entry)}\n`;
    const path = historyFile();
    if (!(await trimForAppend(path, Buffer.byteLength(line)))) {
      process.stderr.write('[history-logger] record exceeds configured byte cap; skipped\n');
      return;
    }
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    process.stderr.write(`[history-logger] write failed (non-fatal): ${error}\n`);
  }
}

export function logHistory(entry: HistoryEntry): void {
  writeQueue = writeQueue.then(() => append(entry), () => append(entry));
}

export function flushHistoryLogger(): Promise<void> { return writeQueue; }

function safeLog(entry: HistoryEntry, logger: Logger): void {
  try { logger(entry); } catch (error) {
    process.stderr.write(`[history-logger] log failed (non-fatal): ${error}\n`);
  }
}

function outboundEntry(method: string, payload: Payload, outcome: 'delivered' | 'failed', result: Result, now: string): HistoryEntry | null {
  if (!METHODS.has(method) || payload.chat_id == null) return null;
  const content = method === 'sendPhoto' || method === 'sendDocument' ? String(payload.caption ?? '') : String(payload.text ?? '');
  return {
    ts: now, direction: 'out', outcome, chat_id: String(payload.chat_id), user: 'bot',
    ...(result?.message_id != null ? { message_id: result.message_id } : {}),
    ...(payload.reply_parameters?.message_id != null ? { reply_to: payload.reply_parameters.message_id } : {}),
    type: method === 'sendPhoto' ? 'photo' : method === 'sendDocument' ? 'document' : 'text',
    kind: method,
    ...contentFingerprint(content),
  };
}

export async function applyOutboundHistory<Method extends string, PayloadType, Signal, ResultType>(
  prev: (method: Method, payload: PayloadType, signal?: Signal) => Promise<ResultType>, method: Method,
  payload: PayloadType, signal?: Signal, options?: { log?: Logger; now?: () => string },
): Promise<ResultType> {
  const logger = options?.log ?? logHistory;
  try {
    const result = await prev(method, payload, signal);
    const entry = outboundEntry(method, payload as Payload, 'delivered', result as Result, options?.now?.() ?? new Date().toISOString());
    if (entry) safeLog(entry, logger);
    return result;
  } catch (error) {
    const entry = outboundEntry(method, payload as Payload, 'failed', undefined, options?.now?.() ?? new Date().toISOString());
    if (entry) safeLog(entry, logger);
    throw error;
  }
}

export function logInbound(entry: Omit<HistoryEntry, 'direction' | 'outcome'>, options?: { log?: Logger; schedule?: (task: () => void) => void }): void {
  (options?.schedule ?? queueMicrotask)(() => safeLog({ ...entry, direction: 'in', outcome: 'received' }, options?.log ?? logHistory));
}
