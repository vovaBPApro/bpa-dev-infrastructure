import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const standDir = import.meta.dir;
const compose = readFileSync(join(standDir, 'compose.yaml'), 'utf8');
const envExample = readFileSync(join(standDir, 'env.example'), 'utf8');
const acceptanceScript = readFileSync(join(standDir, 'run-acceptance.sh'), 'utf8');

describe('Docker acceptance stand', () => {
  test('defines a disposable compose project and runtime limits', () => {
    expect(compose).toMatch(/^name: \$\{COMPOSE_PROJECT_NAME:-contour-acceptance\}$/m);
    expect(compose).toMatch(/^\s+mem_limit: 256m$/m);
    expect(compose).toMatch(/^\s+cpus: "0\.50"$/m);
    expect(compose).toMatch(/^\s+restart: "no"$/m);
  });

  test('has an executable healthcheck', () => {
    expect(compose).toMatch(/^\s+healthcheck:$/m);
    expect(compose).toMatch(/^\s+test:$/m);
    expect(compose).toContain("fetch('http://127.0.0.1:4822/health')");
    expect(compose).toMatch(/^\s+retries: 12$/m);
  });

  test('keeps example environment values explicitly fake', () => {
    for (const line of envExample.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [key, value] = line.split('=', 2);
      expect(key).toMatch(/^[A-Z0-9_]+$/);
      expect(value).toMatch(/^fake-|^\/tmp\/|^static$/);
    }
  });

  test('contains no recognizable plaintext credential markers', () => {
    const forbidden = [
      'gh' + 'p_',
      'github' + '_pat',
      'client' + '_secret',
      'PRIVATE' + ' KEY',
    ];
    for (const marker of forbidden) {
      expect(compose).not.toContain(marker);
      expect(envExample).not.toContain(marker);
    }
    expect(envExample).not.toMatch(/\d{8,10}:AA/);
  });

  test('uses grep rather than ripgrep for host-side acceptance checks', () => {
    expect(acceptanceScript).toContain('require_command grep');
    expect(acceptanceScript).toContain('command grep -q');
    expect(acceptanceScript).not.toMatch(/\brg\b/);
  });
});
