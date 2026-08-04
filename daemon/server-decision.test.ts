import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type ApiCall = { method: string; payload: Record<string, unknown> };

const stateDir = mkdtempSync(join(tmpdir(), 'daemon-decision-handler.'));
const calls: ApiCall[] = [];
let messageId = 40;
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
writeFileSync(join(stateDir, 'access.json'), JSON.stringify({
  dmPolicy: 'allowlist',
  allowFrom: ['7'],
  groups: {},
  pending: {},
}));
process.env.TELEGRAM_DAEMON_TEST_MODE = '1';
process.env.TELEGRAM_ACCESS_MODE = 'static';
process.env.TELEGRAM_STATE_DIR = stateDir;
process.env.TELEGRAM_BOT_TOKEN = '123456:fixture-token';
process.env.ORCH_SESSION = '';

const server = await import('./server');
server.installBotApiStubForTest(async (method, payload) => {
  calls.push({ method, payload });
  const result = method === 'sendMessage'
    ? { message_id: ++messageId, date: 1, chat: { id: 7, type: 'private' }, text: payload.text }
    : true;
  return { ok: true, result };
});
const dispatchTool = server.dispatchRegisteredToolForTest;
const dispatchUpdate = server.dispatchRegisteredTelegramUpdateForTest;
const bufferedDecisionContents = server.bufferedDecisionContentsForTest;

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const options = [
  { label: 'Keep staged', value: 'stage' },
  { label: 'Deploy now', value: 'deploy' },
];
const explanations = [
  'Leave production unchanged; testing continues on the staging stand.',
  'Move the verified release to production; users receive it immediately.',
];

function callbackUpdate(data: string, updateId: number): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: 7, is_bot: false, first_name: 'Operator', username: 'operator' },
      message: {
        message_id: 41,
        date: 1,
        chat: { id: 7, type: 'private' },
        text: 'Choose release target',
      },
      chat_instance: 'fixture',
      data,
    },
  };
}

async function dispatchCallback(data: string, updateId: number): Promise<void> {
  await Promise.race([
    dispatchUpdate(callbackUpdate(data, updateId)),
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error(`callback timed out after calls: ${calls.map((call) => call.method).join(',')}`)),
      2_000,
    )),
  ]);
}

function lastCall(method: string): ApiCall | undefined {
  return [...calls].reverse().find((call) => call.method === method);
}

test('REGRESSION HR-1752: registered handlers preserve explained decision semantics', async () => {
  calls.length = 0;
  const result = await dispatchTool('request_decision', {
    decision_id: 'release_target',
    text: 'Choose release target',
    options,
    explanations,
  }) as { content: Array<{ text: string }> };

  const send = calls.find((call) => call.method === 'sendMessage');
  expect(send?.payload.chat_id).toBe('7');
  expect(send?.payload.disable_notification).toBe(false);
  expect(send?.payload.text).toBe(
    `Choose release target\nKeep staged: ${explanations[0]}\nDeploy now: ${explanations[1]}`,
  );
  const keyboard = send?.payload.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual(
    options.map((option) => option.label),
  );

  const sid = /sid=([a-km-z]{5})/.exec(result.content[0].text)?.[1];
  expect(sid).toBeTruthy();
  await dispatchCallback(`dec:${sid}:1`, 100);
  expect(lastCall('answerCallbackQuery')?.payload.text)
    .toBe('Deploy now');
  expect(bufferedDecisionContents()).toContain('decision:release_target=deploy');

  await dispatchCallback(`dec:${sid}:1`, 101);
  expect(lastCall('answerCallbackQuery')?.payload.text)
    .toBe('Decision expired or already answered.');
  await dispatchCallback('dec:zzzzz:0', 102);
  expect(lastCall('answerCallbackQuery')?.payload.text)
    .toBe('Decision expired or already answered.');
}, 15_000);

test('registered request handler refuses malformed composition before transport', async () => {
  calls.length = 0;
  const result = await dispatchTool('request_decision', {
    decision_id: ' ',
    text: 'Choose',
    options,
    explanations,
  }) as { isError: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('decision id is empty');
  expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(0);
});
