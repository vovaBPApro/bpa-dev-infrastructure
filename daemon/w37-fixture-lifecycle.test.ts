import { expect, test } from 'bun:test';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type Ready = {
  correlation: string;
  fixtureRoot: string;
  socketPath: string;
  watcherPid: number;
};

const childPath = process.env.W37_FIXTURE_CHILD_PATH
  ?? join(import.meta.dir, 'w37-fixture-child.ts');

function correlation(label: string): string {
  return `w37-lifecycle-${label}-${process.pid}-${Date.now()}`;
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function start(label: string, mode: string): Promise<{
  child: ReturnType<typeof Bun.spawn>;
  ready: Ready;
  stderr: Promise<string>;
}> {
  const id = correlation(label);
  const child = Bun.spawn([process.execPath, childPath], {
    env: {
      ...process.env,
      W37_FIXTURE_CORRELATION: id,
      W37_FIXTURE_MODE: mode,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 5_000;
  let text = '';
  while (!text.includes('\n') && Date.now() < deadline) {
    const read = await reader.read();
    if (read.done) break;
    text += new TextDecoder().decode(read.value);
  }
  reader.releaseLock();
  if (!text.trim()) {
    throw new Error(`fixture did not report ownership: ${await stderr}`);
  }
  return { child, ready: JSON.parse(text.trim()) as Ready, stderr };
}

function assertExactOwnership(ready: Ready): void {
  const uid = process.getuid?.() ?? 0;
  expect(ready.socketPath).toBe(join('/tmp', `tmux-${uid}`, ready.correlation));
  expect(dirname(ready.fixtureRoot)).toBe(tmpdir());
  expect(basename(ready.fixtureRoot)).toBe(`w37-fixture-${ready.correlation}`);
  expect(readFileSync(`/proc/${ready.watcherPid}/cmdline`, 'utf8')).toContain(ready.correlation);
}

function assertZeroResidue(ready: Ready): void {
  expect(pidExists(ready.watcherPid)).toBe(false);
  expect(existsSync(ready.socketPath)).toBe(false);
  expect(existsSync(ready.fixtureRoot)).toBe(false);
}

function ownedProcesses(id: string): string[] {
  const result = Bun.spawnSync(['ps', '-eo', 'pid=,args=']);
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().split('\n')
    .filter((line) => line.includes(id))
    .filter((line) => line.includes('w37-fixture-watcher') || line.includes('tmux'));
}

for (const [label, mode, expected] of [
  ['pass', 'pass', 0],
  ['assertion', 'assertion', 1],
  ['deadline', 'deadline', 124],
] as const) {
  test(`REGRESSION W-37 fixture cleanup: ${label}`, async () => {
    const fixture = await start(label, mode);
    assertExactOwnership(fixture.ready);
    expect(await fixture.child.exited).toBe(expected);
    await fixture.stderr;
    assertZeroResidue(fixture.ready);
  }, 10_000);
}

for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  test(`REGRESSION W-37 fixture cleanup: actual ${signal}`, async () => {
    const fixture = await start(signal.toLowerCase(), 'wait');
    assertExactOwnership(fixture.ready);
    process.kill(fixture.child.pid, signal);
    expect(await fixture.child.exited).toBe(expected);
    await fixture.stderr;
    assertZeroResidue(fixture.ready);
  }, 10_000);
}

test('RED LOCK W-37: pre-fix kill-server-only cleanup leaves owned socket residue', () => {
  const id = correlation('red');
  const socketPath = join('/tmp', `tmux-${process.getuid?.() ?? 0}`, id);
  try {
    const created = Bun.spawnSync([
      'tmux', '-L', id, 'new-session', '-d', '-s', id, 'sleep', '300',
    ]);
    expect(created.exitCode).toBe(0);
    expect(existsSync(socketPath)).toBe(true);
    Bun.spawnSync(['tmux', '-L', id, 'kill-server']);
    expect(existsSync(socketPath)).toBe(true);
  } finally {
    rmSync(socketPath, { force: true });
  }
  expect(existsSync(socketPath)).toBe(false);
});

for (const target of ['socket', 'root', 'both'] as const) {
  test(`REGRESSION W-37 ownership refusal: pre-existing ${target}`, async () => {
    const id = correlation(`existing-${target}`);
    const socketPath = join('/tmp', `tmux-${process.getuid?.() ?? 0}`, id);
    const fixtureRoot = join(tmpdir(), `w37-fixture-${id}`);
    const shimRoot = mkdtempSync(join(tmpdir(), `w37-refusal-shim-${process.pid}-`));
    const tmuxCalls = join(shimRoot, 'tmux.calls');
    const socketBytes = `historical-socket-${id}`;
    const rootBytes = `historical-root-${id}`;
    try {
      writeFileSync(
        join(shimRoot, 'tmux'),
        `#!/bin/sh\nprintf 'called\\n' >> '${tmuxCalls}'\nexit 99\n`,
      );
      chmodSync(join(shimRoot, 'tmux'), 0o700);
      if (target === 'socket' || target === 'both') {
        writeFileSync(socketPath, socketBytes, { flag: 'wx' });
      }
      if (target === 'root' || target === 'both') {
        mkdirSync(fixtureRoot);
        writeFileSync(join(fixtureRoot, 'historical'), rootBytes);
      }
      const socketInode = existsSync(socketPath) ? lstatSync(socketPath).ino : undefined;
      const rootInode = existsSync(fixtureRoot) ? statSync(fixtureRoot).ino : undefined;

      const child = Bun.spawn([process.execPath, childPath], {
        env: {
          ...process.env,
          PATH: `${shimRoot}:${process.env.PATH ?? ''}`,
          W37_FIXTURE_CORRELATION: id,
          W37_FIXTURE_MODE: 'pass',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await child.exited).not.toBe(0);
      expect(await new Response(child.stdout).text()).toBe('');
      expect(await new Response(child.stderr).text()).toContain('W-37 fixture ownership refusal');
      expect(ownedProcesses(id)).toEqual([]);
      expect(existsSync(tmuxCalls)).toBe(false);

      if (socketInode !== undefined) {
        expect(lstatSync(socketPath).ino).toBe(socketInode);
        expect(readFileSync(socketPath, 'utf8')).toBe(socketBytes);
      } else {
        expect(existsSync(socketPath)).toBe(false);
      }
      if (rootInode !== undefined) {
        expect(statSync(fixtureRoot).ino).toBe(rootInode);
        expect(readFileSync(join(fixtureRoot, 'historical'), 'utf8')).toBe(rootBytes);
      } else {
        expect(existsSync(fixtureRoot)).toBe(false);
      }
    } finally {
      rmSync(socketPath, { force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(shimRoot, { recursive: true, force: true });
    }
  }, 10_000);
}
