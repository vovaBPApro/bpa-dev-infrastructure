import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { drainOutbox, resolveOrchestratorLauncher } from './control';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  const file = join(dir, 'alerts.outbox');
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('launcher resolves from the install root, not a legacy channel path', () => {
  expect(resolveOrchestratorLauncher('/srv/bpa')).toBe('/srv/bpa/orchestrator/launch.sh');
});

test('outbox delivers every line and acknowledges only sent lines', async () => {
  const f = fixture();
  try {
    writeFileSync(f.file, 'one\ntwo\n');
    const sent: string[] = [];
    await drainOutbox(f.file, 'chat', async (_, text) => void sent.push(text), () => {});
    expect(sent).toEqual(['one', 'two']);
    expect(readFileSync(f.file, 'utf8')).toBe('');
  } finally { f.done(); }
});

test('outbox survives a crash after send and before acknowledgement', async () => {
  const f = fixture();
  try {
    writeFileSync(f.file, 'one\ntwo\n');
    const first: string[] = [];
    await expect(drainOutbox(f.file, 'chat', async (_, text) => void first.push(text), () => {}, () => { throw new Error('crash'); })).rejects.toThrow('crash');
    expect(readFileSync(f.file, 'utf8')).toBe('one\ntwo\n');
    const second: string[] = [];
    await drainOutbox(f.file, 'chat', async (_, text) => void second.push(text), () => {});
    expect(first).toEqual(['one']);
    expect(second).toEqual(['one', 'two']);
  } finally { f.done(); }
});

test('outbox skips malformed lines with a log and retains later alerts', async () => {
  const f = fixture();
  try {
    writeFileSync(f.file, '\nvalid\n');
    const sent: string[] = []; const logs: string[] = [];
    await drainOutbox(f.file, 'chat', async (_, text) => void sent.push(text), (line) => logs.push(line));
    expect(sent).toEqual(['valid']);
    expect(logs[0]).toContain('malformed line skipped');
  } finally { f.done(); }
});
