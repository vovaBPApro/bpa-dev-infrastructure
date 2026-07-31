import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('replaces exact secret bytes in place without changing JSONL offsets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redact-jsonl-'));
  const value = `left-${'q'.repeat(24)}-right`;
  const store = join(dir, 'runtime.env');
  const target = join(dir, 'live.jsonl');
  writeFileSync(store, `ACCESS_TOKEN=${value}\n`);
  writeFileSync(target, `${JSON.stringify({ message: value })}\n${JSON.stringify({ safe: true })}\n`);
  const size = statSync(target).size;
  const result = Bun.spawnSync(['bun', join(import.meta.dir, 'redact-live-jsonl.ts'), '--values-file', store, '--target', target]);
  expect(result.exitCode).toBe(0);
  expect(statSync(target).size).toBe(size);
  const text = readFileSync(target, 'utf8');
  expect(text).not.toContain(value);
  expect(text.split('\n').filter(Boolean).map(JSON.parse)).toHaveLength(2);
});
