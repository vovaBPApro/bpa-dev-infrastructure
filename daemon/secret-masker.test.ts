import { expect, test } from 'bun:test';
import { maskSecrets } from './secret-masker';

const assignments = [
  ['CLIENT_SECRET', `alpha-${'s'.repeat(24)}-omega`],
  ['ACCESS_TOKEN', `left-${'t'.repeat(24)}-right`],
  ['PASSWORD', `start-${'p'.repeat(24)}-finish`],
];

test('regression lock: every credential-shaped assignment is masked at the sink', () => {
  for (const [key, secret] of assignments) {
    const output = maskSecrets(`${key}=${secret}`);
    expect(output).not.toContain(secret);
    expect(output).toMatch(/\*{8,16}/);
  }
});

test('regression lock: bearer and private-key material never survive in full', () => {
  const token = `head.${'x'.repeat(40)}.tail`;
  const keyBody = `${'M'.repeat(64)}\n${'N'.repeat(64)}`;
  const privateLabel = ['PRIVATE', 'KEY'].join(' ');
  const input = `Authorization: Bearer ${token}\n-----BEGIN ${privateLabel}-----\n${keyBody}\n-----END ${privateLabel}-----`;
  const output = maskSecrets(input);
  expect(output).not.toContain(token);
  expect(output).not.toContain(keyBody);
  expect(output).toContain('****************');
});

test('masked length reveals only a bucket, not the original length', () => {
  const short = maskSecrets(`PASSWORD=abc${'x'.repeat(8)}xyz`);
  const longer = maskSecrets(`PASSWORD=abc${'x'.repeat(14)}xyz`);
  expect(short).toBe(longer);
});
