import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type Mode = 'pass' | 'assertion' | 'deadline' | 'wait';

const correlation = process.env.W37_FIXTURE_CORRELATION ?? '';
const mode = process.env.W37_FIXTURE_MODE as Mode;
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
if (dirname(socketPath) !== socketDir || basename(socketPath) !== correlation) {
  refuse('socket did not resolve to the exact private tmux location');
}
if (dirname(fixtureRoot) !== tmpdir() || basename(fixtureRoot) !== `w37-fixture-${correlation}`) {
  refuse('temp tree escaped the test-owned root');
}

let watcherPid: number | undefined;
let cleaned = false;

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validateWatcher(pid: number): void {
  const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
  if (!command.includes(correlation) || !command.includes('w37-fixture-watcher')) {
    refuse(`PID ${pid} command does not carry the exact correlation`);
  }
  const group = Bun.spawnSync(['ps', '-o', 'pgid=', '-p', String(pid)]);
  if (group.exitCode !== 0 || Number(group.stdout.toString().trim()) !== pid) {
    refuse(`PID ${pid} is not the exact process-group leader`);
  }
}

function cleanup(): void {
  if (cleaned) return;
  if (watcherPid !== undefined && pidExists(watcherPid)) {
    validateWatcher(watcherPid);
    process.kill(-watcherPid, 'SIGKILL');
  }
  Bun.spawnSync(['tmux', '-L', correlation, 'kill-server']);
  rmSync(socketPath, { force: true });
  rmSync(fixtureRoot, { recursive: true, force: true });
  cleaned = true;
}

function exitForSignal(signal: 'SIGINT' | 'SIGTERM'): never {
  cleanup();
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.once('SIGINT', () => exitForSignal('SIGINT'));
process.once('SIGTERM', () => exitForSignal('SIGTERM'));

mkdirSync(fixtureRoot);
writeFileSync(watcherMarker, correlation);
const tmux = Bun.spawnSync([
  'tmux', '-L', correlation, 'new-session', '-d', '-s', correlation,
  'bash', '--noprofile', '--norc',
]);
if (tmux.exitCode !== 0 || !existsSync(socketPath)) {
  cleanup();
  refuse(`private tmux server failed: ${tmux.stderr.toString()}`);
}
const watcher = Bun.spawn([
  'setsid', 'bash', '-c',
  `exec -a w37-fixture-watcher-${correlation} sleep 300`,
], { stdout: 'ignore', stderr: 'ignore' });
watcherPid = watcher.pid;
validateWatcher(watcherPid);

console.log(JSON.stringify({ correlation, fixtureRoot, socketPath, watcherPid }));

let exitCode = 0;
try {
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
  cleanup();
}
process.exit(exitCode);
