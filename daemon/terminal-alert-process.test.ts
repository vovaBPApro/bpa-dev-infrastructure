import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotifyHandler } from './notify-handler';
import { deliverTerminalAlert } from './terminal-alert-delivery';

type TmuxResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function tmux(socket: string, ...args: string[]): Promise<TmuxResult> {
  const child = Bun.spawn(['tmux', '-L', socket, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

test(
  'REGRESSION W-37: real tmux watcher emits out-of-band once without pane recursion',
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'w37-process-boundary-'));
    const socket = `w37-${process.pid}-${Date.now()}`;
    const target = 'watched:0.0';
    const readyFile = join(scratch, 'terminal-alert.ready');
    const watcherStderr = join(scratch, 'terminal-alert.stderr');
    const journaled: string[] = [];
    const attempts: string[] = [];
    let rejectNetworkOnce = true;

    const handler = createNotifyHandler({
      notifyChatId: () => null,
      relayHuman: () => {
        throw new Error('terminal alert crossed into Human delivery');
      },
      relayInternal: async (frame) => {
        attempts.push(frame);
        if (
          rejectNetworkOnce &&
          frame.includes('network error: ECONNRESET retry-boundary')
        ) {
          rejectNetworkOnce = false;
          throw new Error('synthetic journal outage');
        }
        deliverTerminalAlert(frame, {
          journal: (text) => journaled.push(text),
        });
      },
    });
    const server = createServer(handler);

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('test server did not expose a TCP port');
      }

      const created = await tmux(
        socket,
        'new-session',
        '-d',
        '-s',
        'watched',
        '-x',
        '24',
        '-y',
        '10',
        'bash',
        '--noprofile',
        '--norc',
      );
      expect(created).toMatchObject({ exitCode: 0 });
      await tmux(socket, 'send-keys', '-t', target, 'stty -echo', 'Enter');

      const watcherCommand = [
        `TELEGRAM_DAEMON_PORT=${address.port}`,
        shellQuote(process.execPath),
        shellQuote(join(import.meta.dir, 'terminal-alert.ts')),
        '--session',
        'w37-process-fixture',
        '--ready-file',
        shellQuote(readyFile),
        `2>${shellQuote(watcherStderr)}`,
      ].join(' ');
      const piped = await tmux(
        socket,
        'pipe-pane',
        '-o',
        '-t',
        target,
        watcherCommand,
      );
      expect(piped).toMatchObject({ exitCode: 0 });
      await waitFor('terminal watcher readiness', () => existsSync(readyFile));

      const emit = async (printfEscapes: string): Promise<void> => {
        await tmux(
          socket,
          'send-keys',
          '-l',
          '-t',
          target,
          `printf '%b' ${shellQuote(printfEscapes)}`,
        );
        await tmux(socket, 'send-keys', '-t', target, 'Enter');
      };

      // The narrow pane visually wraps this line; CR and ANSI model the live
      // TUI stream. Neither rendering detail changes the one-way topology.
      await emit(
        '\\033[31mfatal error: process boundary must not return to the watched pane\\033[0m\\r\\n',
      );
      await waitFor('first out-of-band alert', () => journaled.length === 1);
      expect(attempts).toHaveLength(1);
      expect(journaled[0]).toContain('Type: f·atal');

      await emit(
        '\\033[33mAPI request failed: 429 Too Many Requests\\033[0m\\r\\n',
      );
      await waitFor('distinct out-of-band alert', () => journaled.length === 2);
      expect(attempts).toHaveLength(2);
      expect(journaled[1]).toContain('Type: 4·29/overload');

      // A failed delivery is not deduplicated. Repeating the exact failure
      // retries after HTTP 502 and succeeds without a watcher restart.
      const networkFailure =
        'network error: ECONNRESET retry-boundary\\r\\n';
      await emit(networkFailure);
      await waitFor('failed HTTP delivery', () => attempts.length === 3);
      expect(journaled).toHaveLength(2);
      await emit(networkFailure);
      await waitFor('successful HTTP retry', () => journaled.length === 3);
      expect(attempts).toHaveLength(4);
      expect(journaled[2]).toContain('Type: n·etwork');

      await Bun.sleep(250);
      expect(attempts).toHaveLength(4);
      expect(journaled).toHaveLength(3);

      const capture = await tmux(
        socket,
        'capture-pane',
        '-p',
        '-S',
        '-',
        '-t',
        target,
      );
      expect(capture.exitCode).toBe(0);
      expect(capture.stdout).not.toContain('[internal terminal failure alert]');
      expect(capture.stdout).not.toContain('terminal-alert:');
      expect(capture.stdout).not.toContain('details in daemon journal');

      const alive = await tmux(socket, 'has-session', '-t', 'watched');
      expect(alive.exitCode).toBe(0);
      const pane = await tmux(
        socket,
        'display-message',
        '-p',
        '-t',
        target,
        '#{pane_dead}:#{pane_current_command}',
      );
      expect(pane.stdout.trim()).toBe('0:bash');

      expect(readFileSync(watcherStderr, 'utf8')).toContain(
        'notify returned HTTP 502',
      );
    } finally {
      await tmux(socket, 'kill-server');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
    }
  },
  15_000,
);
