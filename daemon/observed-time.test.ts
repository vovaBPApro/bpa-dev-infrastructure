import { expect, test } from 'bun:test';
import { ageFromObservedTimestamp } from './observed-time';

const NOW = 10_000;

test('a valid past observation returns its exact age', () => {
  expect(ageFromObservedTimestamp(7_500, NOW)).toEqual({
    ok: true,
    ageMs: 2_500,
  });
});

test('an exact-now observation is valid with zero age', () => {
  expect(ageFromObservedTimestamp(NOW, NOW)).toEqual({
    ok: true,
    ageMs: 0,
  });
});

test('a future observation is rejected without a caller-level tolerance', () => {
  expect(ageFromObservedTimestamp(NOW + 60_000, NOW)).toEqual({
    ok: false,
    reason: 'future',
  });
});

test('even one future millisecond is rejected by the shared boundary', () => {
  expect(ageFromObservedTimestamp(NOW + 1, NOW)).toEqual({
    ok: false,
    reason: 'future',
  });
});

test.each([
  ['NaN', Number.NaN],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
] as const)('a %s observation is rejected as non-finite', (_label, observed) => {
  expect(ageFromObservedTimestamp(observed, NOW)).toEqual({
    ok: false,
    reason: 'non-finite',
  });
});

test.each([
  ['NaN', Number.NaN],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
] as const)('a %s current time is rejected as non-finite', (_label, now) => {
  expect(ageFromObservedTimestamp(7_500, now)).toEqual({
    ok: false,
    reason: 'non-finite',
  });
});

test.each([
  ['missing', undefined],
  ['non-numeric string', 'not-a-timestamp'],
  ['null', null],
  ['numeric-looking string', '7500'],
] as const)(
  'untyped runtime input (%s) is rejected rather than coerced',
  (_label, observed) => {
    expect(
      ageFromObservedTimestamp(observed as unknown as number, NOW),
    ).toEqual({
      ok: false,
      reason: 'non-finite',
    });
  },
);
