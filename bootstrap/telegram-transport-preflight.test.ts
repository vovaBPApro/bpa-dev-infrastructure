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
  [suffix(20), true, 'minimum'], [suffix(128), true, 'maximum'],
  [suffix(19), false, 'adjacent short'], [suffix(129), false, 'adjacent long'],
  [suffix(10_000), false, 'very long'],
];
for (const [value, ok, label] of grammar) {
  await writeFile(envFile, `TELEGRAM_BOT_TOKEN=${value}\n`);
  const proc = Bun.spawn({ cmd: ['bash', '-c', 'source "$PREFLIGHT"; telegram_read_bot_token "$ENV_FILE"'],
    env: { PATH: process.env.PATH!, PREFLIGHT: helper, ENV_FILE: envFile }, stdout: 'ignore', stderr: 'ignore' });
  if (((await proc.exited) === 0) !== ok) throw new Error(`grammar ${label}`);
}

const invalidShapes = [
  ` TELEGRAM_BOT_TOKEN=${token}\n`, `\tTELEGRAM_BOT_TOKEN=${token}\n`,
  `TELEGRAM_BOT_TOKEN=${token}\n TELEGRAM_BOT_TOKEN=bad\n`,
  `TELEGRAM_BOT_TOKEN=${token}\n\tTELEGRAM_BOT_TOKEN=bad\n`,
  `TELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_BOT_TOKEN=\n`,
  `TELEGRAM_BOT_TOKEN='${token}'\n`, `export TELEGRAM_BOT_TOKEN=${token}\n`,
  `TELEGRAM_BOT_TOKEN=${token} # comment\n`,
];
for (const [index, shape] of invalidShapes.entries()) {
  await writeFile(envFile, shape);
  const proc = Bun.spawn({ cmd: ['bash', '-c', 'source "$PREFLIGHT"; telegram_read_bot_token "$ENV_FILE"'],
    env: { PATH: process.env.PATH!, PREFLIGHT: helper, ENV_FILE: envFile }, stdout: 'ignore', stderr: 'ignore' });
  if ((await proc.exited) === 0) throw new Error(`invalid EnvironmentFile shape ${index}`);
}
console.log('telegram transport preflight: PASS');
