import { expect, test } from 'bun:test';
import {
  composeDecisionRequest,
  handleDecisionCallback,
  handleDecisionRequest,
  resolveDecisionResponse,
} from './decision-request';

const options = [
  { label: 'Deploy now', value: 'deploy' },
  { label: 'Keep staged', value: 'stage' },
];
const explanations = [
  'Move the verified release to production; users receive it immediately.',
  'Leave production unchanged; testing continues on the staging stand.',
];
const decisionId = 'release_target';

test('composes explained options with labels matching buttons in order', () => {
  expect(
    composeDecisionRequest({
      decisionId,
      text: 'Where should the verified release go?',
      options,
      explanations,
    }),
  ).toEqual({
    body: [
      'Where should the verified release go?',
      'Deploy now: Move the verified release to production; users receive it immediately.',
      'Keep staged: Leave production unchanged; testing continues on the staging stand.',
    ].join('\n'),
    options,
  });
});

test('REGRESSION HR-1752: adding an option without an explanation is refused', () => {
  expect(() =>
    composeDecisionRequest({
      decisionId,
      text: 'Where should the verified release go?',
      options: [...options, { label: 'Cancel', value: 'cancel' }],
      explanations,
    }),
  ).toThrow('decision option/explanation count mismatch: 3 options, 2 explanations');
});

test('refuses missing explanation, mismatched counts, and empty label', () => {
  expect(() =>
    composeDecisionRequest({ decisionId, text: 'Choose', options, explanations: ['', 'Wait'] }),
  ).toThrow('decision option 1 explanation is empty');
  expect(() =>
    composeDecisionRequest({ decisionId, text: 'Choose', options, explanations: ['Only one'] }),
  ).toThrow('decision option/explanation count mismatch');
  expect(() =>
    composeDecisionRequest({
      decisionId,
      text: 'Choose',
      options: [{ label: ' ', value: 'x' }],
      explanations: ['Choose X'],
    }),
  ).toThrow('decision option 1 label is empty');
});

test('refuses an over-length body and a button label longer than three words', () => {
  expect(() =>
    composeDecisionRequest({
      decisionId,
      text: 'Choose',
      options: [{ label: 'Proceed', value: 'yes' }],
      explanations: ['x'.repeat(600)],
    }),
  ).toThrow('decision body exceeds 600 characters');
  expect(() =>
    composeDecisionRequest({
      decisionId,
      text: 'Choose',
      options: [{ label: 'Deploy release right now', value: 'yes' }],
      explanations: ['Deploy now'],
    }),
  ).toThrow('decision option 1 label exceeds 3 words');
});

test('round trip resolves the tapped button to the decision wire response', () => {
  const composed = composeDecisionRequest({
    decisionId,
    text: 'Where should the verified release go?',
    options,
    explanations,
  });
  expect(resolveDecisionResponse('release_target', composed.options, 1)).toEqual({
    content: 'decision:release_target=stage',
    option: options[1],
  });
});

test('REGRESSION V3-3.5: distinct labels cannot collapse to one wire value', () => {
  expect(() =>
    composeDecisionRequest({
      decisionId,
      text: 'Choose',
      options: [
        { label: 'Alpha', value: 'same' },
        { label: 'Beta', value: 'same' },
      ],
      explanations: ['Choose alpha', 'Choose beta'],
    }),
  ).toThrow('decision option 2 value is not unique');
});

test('refuses empty, whitespace, and malformed IDs at composition and resolution', () => {
  for (const id of ['', '   ', 'bad id', '=bad', 'a'.repeat(65)]) {
    expect(() =>
      composeDecisionRequest({
        decisionId: id,
        text: 'Choose',
        options,
        explanations,
      }),
    ).toThrow(/decision id is (empty|malformed)/);
    expect(() => resolveDecisionResponse(id, options, 0)).toThrow(
      /decision id is (empty|malformed)/,
    );
  }
});

test('request handler refuses before transport and preserves body/button order', async () => {
  const calls: Array<{ body: string; labels: string[] }> = [];
  const pending = new Map();
  const sendMessage = async (_chatId: string, body: string, buttons: Array<{ label: string }>) => {
    calls.push({ body, labels: buttons.map((button) => button.label) });
    return { message_id: 42 };
  };
  await expect(
    handleDecisionRequest({
      decisionId,
      text: 'Choose',
      options: [options[1], options[0]],
      explanations: [explanations[1], explanations[0]],
      sid: 'abcde',
      chatIds: ['7'],
      sendMessage,
      pending,
    }),
  ).resolves.toMatchObject({
    buttons: [{ label: 'Keep staged' }, { label: 'Deploy now' }],
  });
  expect(calls).toEqual([{
    body: `Choose\nKeep staged: ${explanations[1]}\nDeploy now: ${explanations[0]}`,
    labels: ['Keep staged', 'Deploy now'],
  }]);

  await expect(
    handleDecisionRequest({
      decisionId: ' ', text: 'Choose', options, explanations, sid: 'fghij',
      chatIds: ['7'], sendMessage, pending,
    }),
  ).rejects.toThrow('decision id is empty');
  expect(calls).toHaveLength(1);
});

test('callback handler rejects unknown and stale IDs on the round trip', async () => {
  const pending = new Map();
  await handleDecisionRequest({
    decisionId, text: 'Choose', options, explanations, sid: 'abcde',
    chatIds: ['7'], sendMessage: async () => ({ message_id: 42 }), pending,
  });
  expect(handleDecisionCallback(pending, 'abcde', 1).content).toBe(
    'decision:release_target=stage',
  );
  expect(() => handleDecisionCallback(pending, 'abcde', 1)).toThrow(
    'decision expired or already answered',
  );
  expect(() => handleDecisionCallback(pending, 'zzzzz', 0)).toThrow(
    'decision expired or already answered',
  );
});
