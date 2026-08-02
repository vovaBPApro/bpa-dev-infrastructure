export const DEFAULT_HUMAN_MISSION_TTL_SECONDS = 12 * 60 * 60;

export type HumanMissionCommand =
  | { action: 'none' }
  | { action: 'clear' }
  | { action: 'set'; text: string; ttlSeconds: number; until?: string };

export function parseTtlSeconds(raw: string | undefined): number {
  if (!raw) return DEFAULT_HUMAN_MISSION_TTL_SECONDS;
  const match = raw.trim().match(/^(\d+)([mhd])?$/i);
  if (!match) return DEFAULT_HUMAN_MISSION_TTL_SECONDS;
  const value = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 60 * 60;
  if (unit === 'd') return value * 24 * 60 * 60;
  return value;
}

export function parseHumanMissionCommand(text: string): HumanMissionCommand {
  const trimmed = text.trim();
  if (/^MISSION\s+(DONE|CLEAR)$/i.test(trimmed)) return { action: 'clear' };
  const match = trimmed.match(/^MISSION:\s*([\s\S]+)$/i);
  if (!match) return { action: 'none' };
  const parts = match[1]!.split(/\s+\|\s+/);
  const body = (parts.shift() ?? '').trim();
  if (!body) return { action: 'none' };
  let ttlSeconds = DEFAULT_HUMAN_MISSION_TTL_SECONDS;
  let until: string | undefined;
  for (const part of parts) {
    const ttlMatch = part.match(/^ttl=(.+)$/i);
    if (ttlMatch) ttlSeconds = parseTtlSeconds(ttlMatch[1]);
    const untilMatch = part.match(/^until=(.+)$/i);
    if (untilMatch) until = untilMatch[1]!.trim();
  }
  return { action: 'set', text: body, ttlSeconds, until };
}
