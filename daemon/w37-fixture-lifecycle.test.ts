import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type Ready = {
  correlation: string;
  fixtureRoot: string;
  socketPath: string;
  watcherPid: number;
};

const childPath = join(import.meta.dir, 'w37-fixture-child.ts');

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
