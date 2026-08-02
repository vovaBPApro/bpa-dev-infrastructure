import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

function trackedTypescriptFiles(): string[] {
  const result = Bun.spawnSync(
    ['git', '-C', import.meta.dir, 'ls-files', '--full-name', '--', '*.ts'],
    { stdout: 'pipe', stderr: 'pipe' },
  );

  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString().trim()}`);
  }

  const repositoryRoot = join(import.meta.dir, '..');
  return result.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((file) => join(repositoryRoot, file));
}

function resolveLocalImport(importer: string, specifier: string): string | null {
  const target = normalize(join(dirname(importer), specifier));
  return [target, `${target}.ts`, join(target, 'index.ts')].find(existsSync) ?? null;
}

test('every local import in the copied daemon slice resolves', () => {
  const unresolved: string[] = [];
  const importPattern = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

  for (const file of trackedTypescriptFiles()) {
    for (const match of readFileSync(file, 'utf8').matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') && !resolveLocalImport(file, specifier)) {
        unresolved.push(`${file.slice(import.meta.dir.length + 1)} -> ${specifier}`);
      }
    }
  }

  expect(unresolved).toEqual([]);
});
