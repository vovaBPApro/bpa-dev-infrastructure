import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createProductionTerminalAlertNotifyHandler } from './terminal-alert-notify';

type TmuxResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function installFixtureSignalCleanup(
  cleanup: () => void,
  exit: (code: number) => never = (code) => process.exit(code),
): { remove: () => void; handle: (signal: 'SIGINT' | 'SIGTERM') => void } {
  const handle = (signal: 'SIGINT' | 'SIGTERM'): void => {
    cleanup();
    exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onSigint = (): void => handle('SIGINT');
  const onSigterm = (): void => handle('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return {
    remove: () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
    handle,
  };
}

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

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fixtureSocketPath(socket: string): string {
  return join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`, socket);
}

function validateFixtureLeader(pid: number, correlation: string): void {
  const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  if (!command.includes(correlation)) {
    throw new Error(`refusing to reap PID ${pid}: fixture correlation missing`);
  }
  const group = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]);
  if (group.exitCode !== 0 || Number(group.stdout.toString().trim()) !== pid) {
    throw new Error(`refusing to reap PID ${pid}: not fixture process-group leader`);
  }
}

function resolveFixtureLeader(correlation: string): number | undefined {
  const result = Bun.spawnSync(['ps', '-eo', 'pid=,args=']);
  if (result.exitCode !== 0) throw new Error('could not inspect fixture processes');
  const matches = result.stdout.toString().split('\n').filter(
    (line) => line.includes(correlation) && line.includes('terminal-alert.ts'),
  );
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw new Error(`fixture correlation matched ${matches.length} processes`);
  }
  return Number(matches[0]!.trim().split(/\s+/, 1)[0]);
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
    const correlation = `w37-process-fixture-${process.pid}-${Date.now()}`;
    const readyFile = join(scratch, 'terminal-alert.ready');
    const watcherStderr = join(scratch, 'terminal-alert.stderr');
    const journaled: string[] = [];
    const attempts: string[] = [];
    let rejectNetworkOnce = true;

    const journalEvents = new EventEmitter();
    const journalSink = Object.assign(journalEvents, {
      write(
        chunk: string,
        callback: (error?: Error | null) => void,
      ): boolean {
        const line = String(chunk);
        const frame = JSON.parse(line.slice('[terminal-alert] '.length));
        attempts.push(frame);
        if (
          rejectNetworkOnce &&
          frame.includes('network error: ECONNRESET retry-boundary')
        ) {
          rejectNetworkOnce = false;
          callback(new Error('synthetic journal outage'));
          return true;
        }
        journaled.push(frame);
        callback();
        return true;
      },
    });
    const handler = createProductionTerminalAlertNotifyHandler({
      journal: journalSink,
      notifyChatId: () => null,
      relayHuman: () => {
        throw new Error('terminal alert crossed into Human delivery');
      },
    });
    const server = createServer(handler);
    let watcherPid: number | undefined;
    let cleanupComplete = false;

    const cleanupSync = (): void => {
      if (cleanupComplete) return;
      if (watcherPid !== undefined && pidExists(watcherPid)) {
        validateFixtureLeader(watcherPid, correlation);
        process.kill(-watcherPid, 'SIGKILL');
      }
      Bun.spawnSync(['tmux', '-L', socket, 'kill-server']);
      rmSync(scratch, { recursive: true, force: true });
      cleanupComplete = true;
    };
    const signalCleanup = installFixtureSignalCleanup(cleanupSync);

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

      const ownedWatcher = [
        `exec env TELEGRAM_DAEMON_PORT=${address.port}`,
        shellQuote(process.execPath),
        shellQuote(join(import.meta.dir, 'terminal-alert.ts')),
        '--session',
        shellQuote(correlation),
        '--ready-file',
        shellQuote(readyFile),
        `2>${shellQuote(watcherStderr)}`,
      ].join(' ');
      const watcherCommand = `exec setsid sh -c ${shellQuote(ownedWatcher)}`;
      const piped = await tmux(
        socket,
        'pipe-pane',
        '-o',
        '-t',
        target,
        watcherCommand,
      );
      expect(piped).toMatchObject({ exitCode: 0 });
      await waitFor('terminal watcher PID', () => {
        watcherPid = resolveFixtureLeader(correlation);
        return watcherPid !== undefined;
      });
      const ownedWatcherPid = watcherPid;
      if (ownedWatcherPid === undefined) throw new Error('watcher PID disappeared');
      expect(Number.isSafeInteger(ownedWatcherPid) && ownedWatcherPid > 1).toBe(true);
      validateFixtureLeader(ownedWatcherPid, correlation);
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

      await Bun.sleep(1_000);
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
      signalCleanup.remove();
      if (watcherPid !== undefined && pidExists(watcherPid)) {
        validateFixtureLeader(watcherPid, correlation);
        process.kill(-watcherPid, 'SIGTERM');
        await waitFor('fixture watcher process-group exit', () => !pidExists(watcherPid!), 1_000)
          .catch(() => process.kill(-watcherPid!, 'SIGKILL'));
      }
      await tmux(socket, 'kill-server');
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(scratch, { recursive: true, force: true });
      cleanupComplete = true;

      expect(watcherPid === undefined || !pidExists(watcherPid)).toBe(true);
      expect(existsSync(fixtureSocketPath(socket))).toBe(false);
      expect(existsSync(scratch)).toBe(false);
    }
  },
  15_000,
);

test('REGRESSION W-37 round 5: interruption runs fixture cleanup before exit', () => {
  for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const events: string[] = [];
    const installed = installFixtureSignalCleanup(
      () => events.push('cleanup'),
      (code) => {
        events.push(`exit:${code}`);
        throw new Error('captured exit');
      },
    );
    expect(() => installed.handle(signal)).toThrow('captured exit');
    installed.remove();
    expect(events).toEqual(['cleanup', `exit:${expected}`]);
  }
});
