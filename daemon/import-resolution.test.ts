import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? typescriptFiles(path)
      : entry.isFile() && path.endsWith('.ts')
        ? [path]
        : [];
  });
}

function resolveLocalImport(importer: string, specifier: string): string | null {
  const target = normalize(join(dirname(importer), specifier));
  return [target, `${target}.ts`, join(target, 'index.ts')].find(existsSync) ?? null;
}

test('every local import in the copied daemon slice resolves', () => {
  const unresolved: string[] = [];
  const importPattern = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;

  for (const file of typescriptFiles(import.meta.dir)) {
    for (const match of readFileSync(file, 'utf8').matchAll(importPattern)) {
      const specifier = match[1];
      if (specifier.startsWith('.') && !resolveLocalImport(file, specifier)) {
        unresolved.push(`${file.slice(import.meta.dir.length + 1)} -> ${specifier}`);
      }
    }
  }

  expect(unresolved).toEqual([]);
});
