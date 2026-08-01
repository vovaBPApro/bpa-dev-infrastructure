import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const runner = readFileSync(join(dir, 'run.sh'), 'utf8');
const contract = readFileSync(join(dir, 'product.env.example'), 'utf8');

describe('scheduled product meteorite check', () => {
  test('uses only a fresh clone and a tracked configuration example', () => {
    expect(runner).toContain('git clone --quiet --depth 1');
    expect(runner).toContain('PRODUCT_ENV_EXAMPLE');
    expect(runner).toContain('mktemp -d');
    expect(runner).not.toContain('/srv/projects/');
    expect(runner).not.toContain('/etc/agentic-bpa');
  });

  test('fails closed on missing config, Docker, clone, and rebuild', () => {
    expect(runner).toContain('docker info');
    expect(runner).toContain('required config $key is absent');
    expect(runner).toContain('read access to PRODUCT_GIT_URL');
    expect(runner).toContain('fresh clone rebuild failed');
    expect(runner).toContain("printf -- '- result: NO-GO");
    expect(runner).toContain("printf -- '- blocker:");
  });

  test('tracks the incident config and product-owned full rebuild command', () => {
    expect(contract).toMatch(/^PRODUCT_REQUIRED_CONFIG=DATA_ORGANIZATION_ID$/m);
    expect(contract).toMatch(/^PRODUCT_REBUILD_COMMAND=deploy\/test-install-container\.sh$/m);
  });
});
