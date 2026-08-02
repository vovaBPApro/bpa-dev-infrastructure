import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = import.meta.dir;

describe('watchdog transport source-defect exclusion', () => {
  test('remains explicit, reproducible, and outside automatic test discovery', async () => {
    const defectPath = join(dir, 'watchdog-transport-boundary.defect.ts');
    const defect = await readFile(defectPath, 'utf8');
    const supervision = await readFile(join(dir, 'watchdog-supervision.test.sh'), 'utf8');

    expect(defect).toContain('DEFECT EXCLUDED');
    expect(defect).toContain('reports/v3-review-2-2026-08-02.md §3');
    expect(defect).toContain('5f41a5cad59b764fa4c692ec7f33e3a4c978e559');
    expect(defect).toContain('timeout waiting for successful send; methods=');
    expect(supervision).toContain('DEFECT EXCLUDED: watchdog transport boundary');
    expect(Bun.file(join(dir, 'watchdog-transport-boundary.test.ts')).size).toBe(0);
  });
});
