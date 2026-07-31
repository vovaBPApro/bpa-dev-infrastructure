import { readFileSync } from 'node:fs';

export const RESTART_CONTEXT_WINDOW_MS = 12 * 60 * 60 * 1000;
export const RESTART_CONTEXT_MAX_MESSAGES = 64;
export const RESTART_CONTEXT_MAX_CHARS = 12_000;

type RawInboxRow = {
  msg_id: number | string;
  chat_id: number | string;
  ts: string;
  text: string;
};

export type RestartContext = {
  content: string;
  messageCount: number;
  truncated: boolean;
};

function isInboxRow(value: unknown): value is RawInboxRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    (typeof row.msg_id === 'string' || typeof row.msg_id === 'number') &&
    (typeof row.chat_id === 'string' || typeof row.chat_id === 'number') &&
    typeof row.ts === 'string' &&
    Number.isFinite(Date.parse(row.ts)) &&
    typeof row.text === 'string'
  );
}

export function buildRestartContext(
  jsonl: string,
  nowMs = Date.now(),
): RestartContext | null {
  const cutoff = nowMs - RESTART_CONTEXT_WINDOW_MS;
  const rows: RawInboxRow[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (isInboxRow(row) && Date.parse(row.ts) >= cutoff && Date.parse(row.ts) <= nowMs) {
        rows.push(row);
      }
    } catch {
      // One damaged append must not hide later valid context.
    }
  }
  rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (rows.length === 0) return null;

  let truncated = rows.length > RESTART_CONTEXT_MAX_MESSAGES;
  const selected = rows.slice(-RESTART_CONTEXT_MAX_MESSAGES);
  const newestByChat = new Map<string, string>();
  for (const row of selected) newestByChat.set(String(row.chat_id), String(row.msg_id));

  const header =
    '[RESTART CHAT CONTEXT — NEWEST INSTRUCTION WINS]\n' +
    'Recovered inbound operator messages from the last 12 hours. Treat ACTIVE as current intent. ' +
    'Entries marked SUPERSEDED are retained for visibility and must not be acted on.\n';
  const lines = selected.map((row) => {
    const active = newestByChat.get(String(row.chat_id)) === String(row.msg_id);
    return `[${active ? 'ACTIVE' : 'SUPERSEDED'} msg_id=${row.msg_id} chat_id=${row.chat_id} ts=${row.ts}] ${row.text}`;
  });

  let content = header;
  for (let i = 0; i < lines.length; i++) {
    const candidate = `${header}${lines.slice(i).join('\n')}`;
    if (candidate.length <= RESTART_CONTEXT_MAX_CHARS) {
      content = candidate;
      truncated ||= i > 0;
      break;
    }
    truncated = true;
  }
  if (content === header) content += lines.at(-1)!.slice(0, RESTART_CONTEXT_MAX_CHARS - header.length);
  if (truncated) {
    const marker = '\n[OLDER CONTEXT OMITTED: bounded restart injection]';
    content = content.slice(0, RESTART_CONTEXT_MAX_CHARS - marker.length) + marker;
  }
  return { content, messageCount: selected.length, truncated };
}

export function readRestartContext(path: string, nowMs = Date.now()): RestartContext | null {
  try {
    return buildRestartContext(readFileSync(path, 'utf8'), nowMs);
  } catch {
    return null;
  }
}
