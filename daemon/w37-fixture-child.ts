import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type Mode = 'pass' | 'assertion' | 'deadline' | 'wait';
type StartupInjection = '' | 'validation' | 'after-validation';

const correlation = process.env.W37_FIXTURE_CORRELATION ?? '';
const mode = process.env.W37_FIXTURE_MODE as Mode;
const startupInjection = (process.env.W37_FIXTURE_STARTUP_INJECTION ?? '') as StartupInjection;
const uid = process.getuid?.() ?? 0;
const socketDir = join('/tmp', `tmux-${uid}`);
const socketPath = join(socketDir, correlation);
const fixtureRoot = join(tmpdir(), `w37-fixture-${correlation}`);
const watcherMarker = join(fixtureRoot, 'watcher.marker');

function refuse(reason: string): never {
  throw new Error(`W-37 fixture ownership refusal: ${reason}`);
}

if (!/^w37-lifecycle-[a-z0-9]+-\d+-\d+$/.test(correlation)) {
  refuse('invalid correlation');
}
if (!['pass', 'assertion', 'deadline', 'wait'].includes(mode)) {
  refuse('invalid mode');
}
if (!['', 'validation', 'after-validation'].includes(startupInjection)) {
  refuse('invalid startup injection');
}
if (dirname(socketPath) !== socketDir || basename(socketPath) !== correlation) {
  refuse('socket did not resolve to the exact private tmux location');
}
if (dirname(fixtureRoot) !== tmpdir() || basename(fixtureRoot) !== `w37-fixture-${correlation}`) {
  refuse('temp tree escaped the test-owned root');
}

let watcher: ReturnType<typeof Bun.spawn> | undefined;
let watcherPid: number | undefined;
let cleanupPromise: Promise<void> | undefined;
let ownsFixtureRoot = false;
let ownsSocket = false;

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function awaitPidGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidExists(pid)) {
    if (Date.now() >= deadline) {
      refuse(`watcher PID ${pid} still exists after ${timeoutMs}ms`);
    }
    await Bun.sleep(10);
  }
}

function validateWatcher(pid: number): void {
  const group = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]);
  if (group.exitCode !== 0 || Number(group.stdout.toString().trim()) !== pid) {
    refuse(`PID ${pid} is not the exact process-group leader`);
  }
}

async function awaitWatcherIdentity(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    if (command.includes(correlation) && command.includes('w37-fixture-watcher')) return;
    await Bun.sleep(10);
  }
  refuse(`watcher PID ${pid} did not acquire the exact correlation identity`);
}

async function validateOwnedWatcherForCleanup(pid: number): Promise<void> {
  await awaitWatcherIdentity(pid);
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(')');
  const fields = stat.slice(commandEnd + 2).split(' ');
  const processGroup = Number(fields[2]);
  if (!Number.isSafeInteger(processGroup) || processGroup !== pid) {
    refuse(`cleanup retained watcher PID ${pid} with ambiguous process group`);
  }
}

async function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (watcherPid !== undefined && pidExists(watcherPid)) {
      await validateOwnedWatcherForCleanup(watcherPid);
      process.kill(-watcherPid, 'SIGKILL');
    }
    if (watcher !== undefined) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const exitDeadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(
            `W-37 fixture ownership refusal: watcher child ${watcherPid ?? 'unknown'} did not exit within 5000ms`,
          ));
        }, 5_000);
      });
      try {
        await Promise.race([watcher.exited, exitDeadline]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
    if (watcherPid !== undefined) {
      await awaitPidGone(watcherPid);
    }
    if (ownsSocket) {
      Bun.spawnSync(['tmux', '-L', correlation, 'kill-server']);
      rmSync(socketPath, { force: true });
    }
    if (ownsFixtureRoot) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  })();
  return cleanupPromise;
}

async function exitForSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<never> {
  try {
    await cleanup();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.once('SIGINT', () => void exitForSignal('SIGINT'));
process.once('SIGTERM', () => void exitForSignal('SIGTERM'));

if (existsSync(socketPath)) {
  refuse(`socket path already exists: ${socketPath}`);
}
if (existsSync(fixtureRoot)) {
  refuse(`fixture temp root already exists: ${fixtureRoot}`);
}
mkdirSync(fixtureRoot);
ownsFixtureRoot = true;
let exitCode = 0;
try {
  writeFileSync(watcherMarker, correlation);
  const tmux = Bun.spawnSync([
    'tmux', '-L', correlation, 'new-session', '-d', '-s', correlation,
    'bash', '--noprofile', '--norc',
  ]);
  ownsSocket = existsSync(socketPath);
  if (tmux.exitCode !== 0 || !ownsSocket) {
    refuse(`private tmux server failed: ${tmux.stderr.toString()}`);
  }
  watcher = Bun.spawn([
    'setsid', 'bash', '-c',
    `exec -a w37-fixture-watcher-${correlation} sleep 300`,
  ], { stdout: 'ignore', stderr: 'ignore' });
  watcherPid = watcher.pid;
  await awaitWatcherIdentity(watcherPid);
  writeSync(1, `${JSON.stringify({ correlation, fixtureRoot, socketPath, watcherPid })}\n`);
  if (startupInjection === 'validation') {
    refuse('injected watcher validation failure');
  }
  validateWatcher(watcherPid);
  if (startupInjection === 'after-validation') {
    throw new Error('injected later startup failure');
  }

  if (mode === 'assertion') {
    throw new Error('forced fixture assertion failure');
  }
  if (mode === 'deadline') {
    await new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('fixture deadline exceeded')), 75);
    });
  }
  if (mode === 'wait') {
    await new Promise<never>(() => {});
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  exitCode = mode === 'deadline' ? 124 : 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
