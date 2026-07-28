import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const matrix = readFileSync(join(import.meta.dir, 'matrix.sh'), 'utf8');
const projectFor = (name: string) => `stand-${name}`;
const portAllowed = (port: number) =>
  Number.isInteger(port) &&
  port >= 1024 &&
  port <= 65535 &&
  !(port >= 3100 && port <= 3102) &&
  !(port >= 8000 && port <= 8100);
const collisions = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index);

describe('parallel stand matrix invariants', () => {
  test('locks lane names to isolated compose projects', () => {
    expect(projectFor('lane-1')).toBe('stand-lane-1');
    expect(projectFor('integration')).toBe('stand-integration');
    expect(new Set(['lane-1', 'lane-2', 'integration'].map(projectFor)).size).toBe(3);
    expect(matrix).toContain("printf 'stand-%s\\n' \"$1\"");
  });

  test('rejects reserved and non-ephemeral host port ranges', () => {
    expect(portAllowed(1023)).toBeFalse();
    expect(portAllowed(3100)).toBeFalse();
    expect(portAllowed(3102)).toBeFalse();
    expect(portAllowed(8000)).toBeFalse();
    expect(portAllowed(8100)).toBeFalse();
    expect(portAllowed(18482)).toBeTrue();
    expect(portAllowed(65536)).toBeFalse();
    expect(matrix).toContain('HOST_PORT=0 docker compose');
    expect(matrix).toContain('port < 3100 || port > 3102');
    expect(matrix).toContain('port < 8000 || port > 8100');
  });

  test('detects a collision in docker-inspected values', () => {
    expect(collisions(['49123', '49124', '49123'])).toEqual(['49123']);
    expect(collisions(['stand-lane-1_default', 'stand-lane-2_default'])).toEqual([]);
    expect(matrix).toContain('source=docker-inspect');
  });
});
