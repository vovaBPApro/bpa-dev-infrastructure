import { expect, test } from 'bun:test';
import { maskSecrets } from './secret-masker';
import { SecretMaskStream } from './mask-stream';

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

test('regression lock: a credential split across stream chunks is masked', () => {
  const masker = new SecretMaskStream();
  const value = `edge-${'c'.repeat(18)}-edge`;
  const first = masker.push(`ACCESS_TOKEN=${value.slice(0, 9)}`);
  const second = masker.push(`${value.slice(9)}\nnext line\n`);
  const output = first + second + masker.end();
  expect(first).toBe('');
  expect(output).not.toContain(value);
  expect(output).toContain('next line');
});

test('regression lock: installed stderr sink masks a credential split across many writes', () => {
  const script = `
    const { installStderrSecretMasker } = await import(${JSON.stringify(import.meta.dir + '/secret-masker.ts')});
    installStderrSecretMasker();
    for (const chunk of ['ACCESS_', 'TOKEN=', 'edge-', 'cccccc', 'cccccc', 'cccccc', '-edge', '\\n']) process.stderr.write(chunk);
  `;
  const child = Bun.spawnSync(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const output = child.stderr.toString();
  expect(child.exitCode).toBe(0);
  expect(output.includes('edge-' + 'c'.repeat(18) + '-edge')).toBeFalse();
  expect(output).toContain('*'.repeat(12));
});

test('encoded credentials and exception-shaped output are masked at the sink', () => {
  const value = `edge-${'z'.repeat(18)}-edge`;
  for (const encoded of [Buffer.from(value).toString('base64'), encodeURIComponent(value)]) {
    const output = maskSecrets(`Error retry failed: {\\"ACCESS_TOKEN\\":\\"${encoded}\\"}`);
    expect(output.includes(encoded)).toBeFalse();
  }
});

test('regression lock: short credential values disclose no original bytes', () => {
  const value = 'a1b2c3d4';
  expect(maskSecrets(`PASSWORD=${value}`)).toBe('PASSWORD=********');
});
