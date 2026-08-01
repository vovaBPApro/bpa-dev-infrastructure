import { unlinkSync } from 'node:fs';

export type TerminalFailureClass =
  | 'usage-limit'
  | '429/overload'
  | 'auth'
  | 'stalled'
  | 'failed'
  | 'exited'
  | 'network'
  | 'fatal'
  | 'unknown';

const UNKNOWN_FAILURE_PATTERNS = [
  /\bterminal failure\b/i,
  /\b(?:agent|watchdog|process) crashed\b/i,
] as const;

const INTERNAL_ALERT_BANNER = '[internal terminal failure alert]';
const INTERNAL_ALERT_BANNER_PATTERN = INTERNAL_ALERT_BANNER.replace(
  /[.*+?^${}()|[\]\\]/g,
  '\\$&',
);

const INTERNAL_ALERT_ECHO = new RegExp(
  `(^|\\n)(?:(?:\\d{4}-\\d{2}-\\d{2}[ T])?\\d{2}:\\d{2}(?::\\d{2})?\\s+)?${INTERNAL_ALERT_BANNER_PATTERN}\\nType: (?:usage-limit|429/overload|auth|stalled|failed|exited|network|fatal|unknown)\\nSession: [^\\n]{1,512}\\n\\n[^\\n]{0,4096}(?=\\n|$)`,
  'gi',
);

const FAILURE_PATTERNS: ReadonlyArray<{
  kind: TerminalFailureClass;
  patterns: readonly RegExp[];
}> = [
  {
    kind: 'usage-limit',
    patterns: [
      /you(?:'ve| have) hit your limit/i,
      /\bhit your limit\b/i,
      /\/extra-usage\b/i,
      /\busage limit\b/i,
    ],
  },
  {
    kind: '429/overload',
    patterns: [
      /\brate limit(?:ed| exceeded)?\b/i,
      /\bquota exceeded\b/i,
      /\b429\b/,
      /\boverloaded\b/i,
    ],
  },
  {
    kind: 'auth',
    patterns: [
      /\bauthentication failed\b/i,
      /\binvalid api key\b/i,
      /\bpermission denied\b/i,
      /\bunauthorized\b/i,
    ],
  },
  {
    kind: 'stalled',
    patterns: [
      /\b(?:agent|watchdog|worker|provider|process) stalled\b/i,
      /\bstream watchdog did not recover\b/i,
      /\bno progress for(?: 600s)?\b/i,
    ],
  },
  {
    kind: 'failed',
    patterns: [
      /\bagent "[^"]+" failed:/i,
      /\b(?:agent|provider|watchdog|worker|process) (?:error|failed)\b/i,
    ],
  },
  {
    kind: 'exited',
    patterns: [
      /\[watchdog\] (?:claude|codex) exited \(code \d+\)/i,
      /\b(?:agent|provider|watchdog|worker|process)(?:-[a-z]+)*[- ]exited\b/i,
    ],
  },
  {
    kind: 'network',
    patterns: [
      /\bnetwork error\b/i,
      /\bconnection refused\b/i,
      /\btimed out\b/i,
      /\beconnreset\b/i,
      /\benotfound\b/i,
      /\betimedout\b/i,
    ],
  },
  {
    kind: 'fatal',
    patterns: [
      /\bfatal error\b/i,
      /\buncaught exception\b/i,
      /\bunhandled rejection\b/i,
      /\bpanic:/i,
      /\b(?:runtime )?fatal(?: error| signal)?\b/i,
    ],
  },
];

export function classifyTerminalFailure(
  line: string,
): TerminalFailureClass | null {
  line = stripTerminalNoise(line);
  line = line.replace(INTERNAL_ALERT_ECHO, '$1');
  for (const entry of FAILURE_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(line))) return entry.kind;
  }
  return UNKNOWN_FAILURE_PATTERNS.some((pattern) => pattern.test(line))
    ? 'unknown'
    : null;
}

export function stripTerminalNoise(line: string): string {
  return line
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

type AlertPayload = {
  kind: TerminalFailureClass;
  line: string;
  session: string;
};

type AlertFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function formatTerminalAlert(payload: AlertPayload): string {
  return [
    '[internal terminal failure alert]',
    `Type: ${payload.kind}`,
    `Session: ${payload.session}`,
    '',
    payload.line,
  ].join('\n');
}

export async function relayTerminalAlert(
  payload: AlertPayload,
  port: string,
  fetchImpl: AlertFetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`http://127.0.0.1:${port}/notify`, {
    method: 'POST',
    headers: { 'X-BPA-Alarm-Audience': 'internal' },
    body: formatTerminalAlert(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`notify returned HTTP ${response.status}`);
  }
}

async function run(): Promise<void> {
  const sessionIndex = Bun.argv.indexOf('--session');
  const session = Bun.argv[sessionIndex + 1] || 'unknown';
  const readyIndex = Bun.argv.indexOf('--ready-file');
  const readyFile = readyIndex >= 0 ? Bun.argv[readyIndex + 1] : '';
  const port = process.env.TELEGRAM_DAEMON_PORT || '4822';
  const seen = new Set<string>();

  if (readyIndex >= 0 && !readyFile) {
    throw new Error('--ready-file requires a path');
  }
  if (readyFile) {
    await Bun.write(readyFile, `${process.pid}\n`);
    process.on('exit', () => {
      try {
        unlinkSync(readyFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    });
  }

  for await (const raw of console) {
    const line = stripTerminalNoise(raw);
    const kind = classifyTerminalFailure(line);
    if (!kind) continue;

    const dedupKey = `${kind}\0${line}`;
    if (seen.has(dedupKey)) continue;
    try {
      await relayTerminalAlert({ kind, line, session }, port);
      seen.add(dedupKey);
    } catch (error) {
      process.stderr.write(
        `[terminal-alert] delivery failed kind=${kind}: ${String(error)}\n`,
      );
    }
  }
}

if (import.meta.main) await run();
