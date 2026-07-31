import { expect, test } from 'bun:test';
import {
  DEFAULT_HUMAN_MISSION_TTL_SECONDS,
  parseHumanMissionCommand,
  parseTtlSeconds,
} from './human-mission';

test('parses MISSION set metadata and clear commands', () => {
  expect(
    parseHumanMissionCommand(
      'MISSION: ship reusable parser | ttl=6h | until=Friday 18:00',
    ),
  ).toEqual({
    action: 'set',
    text: 'ship reusable parser',
    ttlSeconds: 21_600,
    until: 'Friday 18:00',
  });
  expect(parseHumanMissionCommand(' mission done ')).toEqual({
    action: 'clear',
  });
  expect(parseHumanMissionCommand('MISSION CLEAR')).toEqual({
    action: 'clear',
  });
});

test('rejects empty commands and defaults malformed TTL', () => {
  expect(parseHumanMissionCommand('MISSION:')).toEqual({ action: 'none' });
  expect(parseHumanMissionCommand('MISSION: ship | ttl=bad')).toEqual({
    action: 'set',
    text: 'ship',
    ttlSeconds: DEFAULT_HUMAN_MISSION_TTL_SECONDS,
  });
  expect(parseHumanMissionCommand('not a mission')).toEqual({ action: 'none' });
});

test('parses seconds, minutes, hours, and days', () => {
  expect(parseTtlSeconds('30')).toBe(30);
  expect(parseTtlSeconds('5m')).toBe(300);
  expect(parseTtlSeconds('2H')).toBe(7200);
  expect(parseTtlSeconds('3d')).toBe(259_200);
});
