import { expect, test } from 'bun:test';
import {
  composeDecisionRequest,
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

test('composes explained options with labels matching buttons in order', () => {
  expect(
    composeDecisionRequest({
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
      text: 'Where should the verified release go?',
      options: [...options, { label: 'Cancel', value: 'cancel' }],
      explanations,
    }),
  ).toThrow('decision option/explanation count mismatch: 3 options, 2 explanations');
});

test('refuses missing explanation, mismatched counts, and empty label', () => {
  expect(() =>
    composeDecisionRequest({ text: 'Choose', options, explanations: ['', 'Wait'] }),
  ).toThrow('decision option 1 explanation is empty');
  expect(() =>
    composeDecisionRequest({ text: 'Choose', options, explanations: ['Only one'] }),
  ).toThrow('decision option/explanation count mismatch');
  expect(() =>
    composeDecisionRequest({
      text: 'Choose',
      options: [{ label: ' ', value: 'x' }],
      explanations: ['Choose X'],
    }),
  ).toThrow('decision option 1 label is empty');
});

test('refuses an over-length body and a button label longer than three words', () => {
  expect(() =>
    composeDecisionRequest({
      text: 'Choose',
      options: [{ label: 'Proceed', value: 'yes' }],
      explanations: ['x'.repeat(600)],
    }),
  ).toThrow('decision body exceeds 600 characters');
  expect(() =>
    composeDecisionRequest({
      text: 'Choose',
      options: [{ label: 'Deploy release right now', value: 'yes' }],
      explanations: ['Deploy now'],
    }),
  ).toThrow('decision option 1 label exceeds 3 words');
});

test('round trip resolves the tapped button to the decision wire response', () => {
  const composed = composeDecisionRequest({
    text: 'Where should the verified release go?',
    options,
    explanations,
  });
  expect(resolveDecisionResponse('release_target', composed.options, 1)).toEqual({
    content: 'decision:release_target=stage',
    option: options[1],
  });
});
