import { expect, test } from 'bun:test';
import { isolatedTestEnv } from './test-env';

test('child isolation drops the full live prefix surface and keeps owned overrides', () => {
  const inherited = {
    PATH: '/fixture/bin',
    ORCH_INSTANCE_LOCK_FILE: '/live/instance.lock',
    ORCH_SINGLETON_LOCK_FILE: '/live/singleton.lock',
    ORCH_LOCK_FILE: '/live/launch.lock',
    ORCH_LEASE_FILE: '/live/orchestrator.lease',
    ORCH_STATE_DB: '/live/state.db',
    ORCH_HEARTBEAT_FILE: '/live/orchestrator.heartbeat',
    ORCH_RUNTIME_DIR: '/live/runtime',
    ORCH_FUTURE_STATE_POINTER: '/live/future',
    TELEGRAM_BOT_TOKEN: 'live-token-fixture',
    TELEGRAM_STATE_DIR: '/live/telegram',
    INFRA_ROOT: '/live/infra',
  };

  const env = isolatedTestEnv(
    {
      ORCH_RUNTIME_DIR: '/scratch/runtime',
      TELEGRAM_STATE_DIR: '/scratch/telegram',
    },
    inherited,
  );

  expect(env).toEqual({
    PATH: '/fixture/bin',
    ORCH_RUNTIME_DIR: '/scratch/runtime',
    TELEGRAM_STATE_DIR: '/scratch/telegram',
  });
  expect(Object.keys(env).some((key) => key === 'ORCH_FUTURE_STATE_POINTER')).toBe(false);
});
