import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const helper = join(import.meta.dir, 'telegram-transport-preflight.sh');
const scratch = await mkdtemp(join(tmpdir(), 'telegram-preflight-'));
const envFile = join(scratch, 'orchestrator.env');
const curlFixture = join(scratch, 'curl-fixture');
const requestLog = join(scratch, 'request.log');
const token = `123456789:${'a'.repeat(20)}`;

await writeFile(curlFixture, `#!/usr/bin/env bash
set -euo pipefail
config="$(mktemp)"; cat > "$config"
url="$(sed -n 's/^url = "\\(.*\\)"$/\\1/p' "$config")"
method="$(sed -n 's/^request = "\\(.*\\)"$/\\1/p' "$config")"
output="$(sed -n 's/^output = "\\(.*\\)"$/\\1/p' "$config")"
printf '%s %s\\n' "$method" "$url" >> "$REQUEST_LOG"
case "$FIXTURE_MODE" in
  success) printf '%s\\n' '{"ok":true,"result":{"id":123456789,"is_bot":true,"username":"fixture_bot"}}' > "$output" ;;
  wrong-id) printf '%s\\n' '{"ok":true,"result":{"id":987654321,"is_bot":true}}' > "$output" ;;
  auth) printf '%s\\n' '{"ok":false,"description":"fixture rejection"}' > "$output"; exit 22 ;;
  malformed) printf '%s\\n' '{' > "$output" ;;
  timeout) exit 28 ;;
  no-request) exit 0 ;;
esac
`);
await chmod(curlFixture, 0o700);

async function parserExit(contents: string | Uint8Array, preflight = helper) {
  await writeFile(envFile, contents);
  const proc = Bun.spawn({
    cmd: ['bash', '-c', 'source "$PREFLIGHT"; telegram_read_bot_token "$ENV_FILE"'],
    env: { PATH: process.env.PATH!, PREFLIGHT: preflight, ENV_FILE: envFile,
      TELEGRAM_PREFLIGHT_BUN_BIN: process.execPath },
    stdout: 'ignore', stderr: 'ignore',
  });
  return await proc.exited;
}

async function preflight(mode: string) {
  const proc = Bun.spawn({
    cmd: ['bash', '-c', 'source "$PREFLIGHT"; telegram_transport_preflight "$ENV_FILE"'],
    env: { PATH: process.env.PATH!, PREFLIGHT: helper, ENV_FILE: envFile,
      TELEGRAM_API_ROOT: 'https://telegram.fixture', CURL_BIN: curlFixture,
      BUN_BIN: process.execPath, REQUEST_LOG: requestLog, FIXTURE_MODE: mode },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([proc.exited,
    new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (stdout.includes(token) || stderr.includes(token)) throw new Error(`${mode}: token disclosed`);
  if (mode === 'success' && (stdout || stderr)) throw new Error('successful preflight emitted output');
  return exit;
}

await writeFile(envFile, `# accepted comment\nTELEGRAM_BOT_TOKEN=${token}\n`);
await chmod(envFile, 0o600);
if (await preflight('success')) throw new Error('success rejected');
const requests = (await readFile(requestLog, 'utf8')).trim().split('\n');
if (requests.length !== 1 || requests[0] !== `POST https://telegram.fixture/bot${token}/getMe`)
  throw new Error('wrong method/path or no request observed');
for (const mode of ['auth', 'timeout', 'malformed', 'wrong-id', 'no-request'])
  if ((await preflight(mode)) === 0) throw new Error(`${mode} accepted`);

const suffix = (n: number) => `123456789:${'z'.repeat(n)}`;
const grammar: Array<[string, boolean, string]> = [
  [`${'1'.repeat(6)}:${'z'.repeat(20)}`, true, 'bot id minimum'],
  [`${'1'.repeat(15)}:${'z'.repeat(20)}`, true, 'bot id maximum'],
  [`${'1'.repeat(5)}:${'z'.repeat(20)}`, false, 'bot id adjacent short'],
  [`${'1'.repeat(16)}:${'z'.repeat(20)}`, false, 'bot id adjacent long'],
  [suffix(20), true, 'minimum'], [suffix(128), true, 'maximum'],
  [suffix(19), false, 'adjacent short'], [suffix(129), false, 'adjacent long'],
  [suffix(10_000), false, 'very long'],
];
for (const [value, ok, label] of grammar) {
  if (((await parserExit(`TELEGRAM_BOT_TOKEN=${value}\n`)) === 0) !== ok)
    throw new Error(`grammar ${label}`);
}

const invalidShapes = [
  ` TELEGRAM_BOT_TOKEN=${token}\n`, `\tTELEGRAM_BOT_TOKEN=${token}\n`,
  `TELEGRAM_BOT_TOKEN=${token}\n TELEGRAM_BOT_TOKEN=bad\n`,
  `TELEGRAM_BOT_TOKEN=${token}\n\tTELEGRAM_BOT_TOKEN=bad\n`,
  `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_BOT_TOKEN=\n`,
  `TELEGRAM_BOT_TOKEN='${token}'\n`, `export TELEGRAM_BOT_TOKEN=${token}\n`,
  `TELEGRAM_BOT_TOKEN=${token} # comment\n`,
  `UNRELATED=value\\\nTELEGRAM_BOT_TOKEN=${token}\n`,
  `UNRELATED='first\nTELEGRAM_BOT_TOKEN=${token}\nlast'\n`,
  `UNRELATED="first\nTELEGRAM_BOT_TOKEN=${token}\nlast"\n`,
  `UNRELATED=escaped\\\\backslash\nTELEGRAM_BOT_TOKEN=${token}\n`,
  `TELEGRAM_BOT_TOKEN=${token}\rTELEGRAM_BOT_TOKEN=bad\n`,
  `TELEGRAM_BOT_TOKEN=${token.slice(0, -1)}\rX\n`,
  `TELEGRAM_BOT_TOKEN=${token}\r\n`,
  `TELEGRAM_BOT_TOKEN=${token}\n \t\rTELEGRAM_BOT_TOKEN=bad\n`,
];
for (const [index, shape] of invalidShapes.entries()) {
  if ((await parserExit(shape)) === 0) throw new Error(`invalid EnvironmentFile shape ${index}`);
}

// EnvironmentFile rejects U+0000. Keep this as an exact byte fixture because
// JavaScript or shell text helpers can otherwise obscure the NUL boundary.
const nulFixture = Buffer.concat([
  Buffer.from('UNRELATED=before'),
  Buffer.from([0]),
  Buffer.from(`after\nTELEGRAM_BOT_TOKEN=${token}\n`),
]);
if ((await parserExit(nulFixture)) === 0)
  throw new Error('NUL-containing EnvironmentFile accepted');

// systemd 255 also requires valid UTF-8 and rejects U+FEFF plus all 66 Unicode
// noncharacters. Exercise every noncharacter at three physical-file placements,
// including both ends of every Unicode plane.
const acceptedUnicode = [
  0x80, 0xfccf, 0xfdd0 - 1, 0xfdef + 1, 0xfffd, 0x10000, 0x10fffd,
];
for (const point of acceptedUnicode) {
  const scalar = Buffer.from(String.fromCodePoint(point), 'utf8');
  const fixture = Buffer.concat([
    Buffer.from('UNRELATED=valid-'),
    scalar,
    Buffer.from(`\nTELEGRAM_BOT_TOKEN=${token}\n`),
  ]);
  if (await parserExit(fixture))
    throw new Error(`valid UTF-8 scalar U+${point.toString(16).toUpperCase()} rejected`);
}

const invalidUtf8: Array<[string, Buffer]> = [
  ['lone-continuation', Buffer.from([0x80])],
  ['invalid-leading-byte', Buffer.from([0xff])],
  ['overlong-slash', Buffer.from([0xc0, 0xaf])],
  ['truncated-three-byte', Buffer.from([0xe2, 0x82])],
  ['encoded-surrogate', Buffer.from([0xed, 0xa0, 0x80])],
  ['above-unicode-range', Buffer.from([0xf4, 0x90, 0x80, 0x80])],
];
const binaryPlacements = (bytes: Buffer) => [
  Buffer.concat([bytes, Buffer.from(`UNRELATED=prefix\nTELEGRAM_BOT_TOKEN=${token}\n`)]),
  Buffer.concat([Buffer.from('UNRELATED=inside-'), bytes,
    Buffer.from(`-value\nTELEGRAM_BOT_TOKEN=${token}\n`)]),
  Buffer.concat([Buffer.from(`TELEGRAM_BOT_TOKEN=${token}\nUNRELATED=suffix`), bytes,
    Buffer.from('\n')]),
];
for (const [label, bytes] of invalidUtf8) {
  for (const [placement, fixture] of binaryPlacements(bytes).entries()) {
    if ((await parserExit(fixture)) === 0)
      throw new Error(`invalid UTF-8 ${label} placement ${placement} accepted`);
  }
}

const forbiddenPoints = [
  0xfeff,
  ...Array.from({ length: 0xfdef - 0xfdd0 + 1 }, (_, index) => 0xfdd0 + index),
  ...Array.from({ length: 17 }, (_, plane) => (plane << 16) + 0xfffe),
  ...Array.from({ length: 17 }, (_, plane) => (plane << 16) + 0xffff),
];
if (forbiddenPoints.length !== 67) throw new Error('forbidden Unicode fixture inventory drift');
for (const point of forbiddenPoints) {
  const bytes = Buffer.from(String.fromCodePoint(point), 'utf8');
  for (const [placement, fixture] of binaryPlacements(bytes).entries()) {
    if ((await parserExit(fixture)) === 0)
      throw new Error(`forbidden U+${point.toString(16).toUpperCase()} placement ${placement} accepted`);
  }
}

await writeFile(envFile, `UNRELATED=ordinary\nTELEGRAM_BOT_TOKEN=${token}\n`);
if (await preflight('success')) throw new Error('ordinary preceding assignment rejected');

// Production mutation lock: widening either bot-id boundary must make the
// adjacent real-parser fixtures fail.
const production = await readFile(helper, 'utf8');
for (const [needle, replacement, rejected, label] of [
  ['{6,15}', '{5,15}', `${'1'.repeat(5)}:${'z'.repeat(20)}`, 'lower'],
  ['{6,15}', '{6,16}', `${'1'.repeat(16)}:${'z'.repeat(20)}`, 'upper'],
] as const) {
  if (!production.includes(needle)) throw new Error(`production grammar missing for ${label} mutant`);
  const mutant = join(scratch, `preflight-${label}-mutant.sh`);
  await writeFile(mutant, production.replace(needle, replacement));
  await writeFile(envFile, `TELEGRAM_BOT_TOKEN=${rejected}\n`);
  const proc = Bun.spawn({ cmd: ['bash', '-c', 'source "$PREFLIGHT"; telegram_read_bot_token "$ENV_FILE"'],
    env: { PATH: process.env.PATH!, PREFLIGHT: mutant, ENV_FILE: envFile }, stdout: 'ignore', stderr: 'ignore' });
  if ((await proc.exited) !== 0) throw new Error(`${label} production mutation was not applied`);
}

const shapeMutant = join(scratch, 'preflight-physical-lines-mutant.sh');
const shapeGuard = /  LC_ALL=C grep -q \$'\[[^\n]+\]' "\$env_file" && return 1\n  LC_ALL=C grep -q '\[[^\n]+\]' "\$env_file" && return 1\n/;
const physicalOnly = production.replace(shapeGuard, '');
if (physicalOnly === production) throw new Error('physical-line mutation was not applied');
await writeFile(shapeMutant, physicalOnly);
await writeFile(envFile, `UNRELATED=value\\\nTELEGRAM_BOT_TOKEN=${token}\n`);
const shapeProc = Bun.spawn({
  cmd: ['bash', '-c', 'source "$PREFLIGHT"; telegram_read_bot_token "$ENV_FILE"'],
  env: { PATH: process.env.PATH!, PREFLIGHT: shapeMutant, ENV_FILE: envFile },
  stdout: 'ignore', stderr: 'ignore',
});
if ((await shapeProc.exited) !== 0) throw new Error('physical-line mutant did not reproduce fail-before');

const nulMutant = join(scratch, 'preflight-nul-mutant.sh');
const nulGuard = "  LC_ALL=C tr -d '\\000' < \"$env_file\" | LC_ALL=C cmp -s \"$env_file\" - || return 1\n";
const withoutNulGuard = production.replace(nulGuard, '');
if (withoutNulGuard === production) throw new Error('NUL mutation was not applied');
await writeFile(nulMutant, withoutNulGuard);
if ((await parserExit(nulFixture, nulMutant)) !== 0)
  throw new Error('NUL mutant did not reproduce fail-before');

const unicodeMutant = join(scratch, 'preflight-unicode-mutant.sh');
const unicodeGuard = '  telegram_environment_file_unicode_valid "$env_file" || return 1\n';
const withoutUnicodeGuard = production.replace(unicodeGuard, '');
if (withoutUnicodeGuard === production) throw new Error('Unicode mutation was not applied');
await writeFile(unicodeMutant, withoutUnicodeGuard);
for (const [label, bytes] of [
  ['invalid UTF-8', Buffer.from([0xff])],
  ['U+FEFF', Buffer.from([0xef, 0xbb, 0xbf])],
  ['U+FDD0', Buffer.from([0xef, 0xb7, 0x90])],
  ['U+1FFFE', Buffer.from([0xf0, 0x9f, 0xbf, 0xbe])],
  ['U+10FFFF', Buffer.from([0xf4, 0x8f, 0xbf, 0xbf])],
] as const) {
  const fixture = Buffer.concat([
    Buffer.from('UNRELATED=before'),
    bytes,
    Buffer.from(`after\nTELEGRAM_BOT_TOKEN=${token}\n`),
  ]);
  if ((await parserExit(fixture, unicodeMutant)) !== 0)
    throw new Error(`${label} mutant did not reproduce fail-before`);
}
console.log('MUTATION-RED physical-line parser and bot-id bounds');
console.log('MUTATION-RED NUL EnvironmentFile guard');
console.log('MUTATION-RED UTF-8 and Unicode noncharacter EnvironmentFile guard');
console.log('telegram transport preflight: PASS');
