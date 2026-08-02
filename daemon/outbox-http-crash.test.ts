import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DurableOutbox } from './outbox';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test('REGRESSION accepted HTTP send survives sender kill with exactly one remote delivery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'v3-telegram-http-crash-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'outbox.json');
  const ledgerPath = join(dir, 'ledger.json');
  const child = Bun.spawn(['bun', join(import.meta.dir, 'outbox-crash-child.ts'), 'crash', path, ledgerPath], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const deadline = Date.now() + 3_000;
  while (!(await Bun.file(ledgerPath).exists())) {
    if (Date.now() >= deadline) throw new Error('fake API did not accept send');
    await Bun.sleep(10);
  }
  child.kill('SIGKILL');
  await child.exited;
  const recovery = Bun.spawn(['bun', join(import.meta.dir, 'outbox-crash-child.ts'), 'recover', path, ledgerPath], {
    stdout: 'pipe', stderr: 'pipe',
  });
  expect(await recovery.exited).toBe(0);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<string, { message_id: number }>;
  expect(Object.keys(ledger)).toHaveLength(1);
  expect(ledger['crash-key']).toEqual({ message_id: 1 });
  const recovered = new DurableOutbox(path, async () => ({ message_id: 99 }));
  expect(await recovered.items()).toEqual([expect.objectContaining({
    id: 'crash-key', state: 'delivered', deliveredMessageId: 1,
  })]);
});
