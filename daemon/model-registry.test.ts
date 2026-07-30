import { expect, test } from 'bun:test';
import {
  MODEL_CATALOG,
  PINNABLE_ENV_KEYS,
  formatModelReport,
  formatModelSelection,
  formatUnknownModel,
  parseLauncherModelState,
  resolveModelChoice,
  upsertEnvAssignment,
} from './model-registry';

// ── Catalog ─────────────────────────────────────────────────────────────────

test('catalog covers the escalation posture named by the architecture', () => {
  const byName = new Map(MODEL_CATALOG.map((c) => [c.name, c]));
  // instance/handoff-oldorch-2026-07-30.md §1: thin Claude top on a lean tier,
  // Fable as the escalation tier. Both ends must be selectable or the posture
  // is unimplementable.
  expect(byName.get('fable')?.model).toBe('claude-fable-5');
  expect(byName.get('fable')?.provider).toBe('claude');
  expect(byName.get('sonnet')?.provider).toBe('claude');
  expect(byName.get('opus')?.model).toBe('claude-opus-5');
  // The codex fallback pin (instance/params.yaml orchestrator.fallback_model).
  const codex = MODEL_CATALOG.filter((c) => c.provider === 'codex');
  expect(codex.map((c) => c.model)).toContain('gpt-5.6-sol');
});

test('every catalog entry pins a provider-scoped env key only', () => {
  for (const choice of MODEL_CATALOG) {
    expect(PINNABLE_ENV_KEYS).toContain(choice.envKey);
    expect(choice.envKey).toBe(
      choice.provider === 'claude' ? 'ORCH_CLAUDE_MODEL' : 'ORCH_CODEX_MODEL',
    );
  }
  // The provider-agnostic legacy key and the provider itself are structurally
  // unreachable: ORCH_MODEL leaks a Claude model into codex (and back), and
  // ORCH_PROVIDER in the sourced runtime.env hijacks the daemon's per-launch
  // `ORCH_PROVIDER=… launch.sh start` and desynchronises binding.provider,
  // which decideRelay then rejects as provider_mismatch.
  expect(PINNABLE_ENV_KEYS).not.toContain('ORCH_MODEL');
  expect(PINNABLE_ENV_KEYS).not.toContain('ORCH_PROVIDER');
});

test('catalog names and model ids are unique', () => {
  const names = MODEL_CATALOG.map((c) => c.name);
  const models = MODEL_CATALOG.map((c) => c.model);
  expect(new Set(names).size).toBe(names.length);
  expect(new Set(models).size).toBe(models.length);
});

// ── Selection ───────────────────────────────────────────────────────────────

test('a valid short name resolves', () => {
  expect(resolveModelChoice('fable')?.model).toBe('claude-fable-5');
  expect(resolveModelChoice('  Fable ')?.model).toBe('claude-fable-5');
  expect(resolveModelChoice('OPUS')?.model).toBe('claude-opus-5');
});

test('the exact model id resolves too', () => {
  expect(resolveModelChoice('claude-fable-5')?.name).toBe('fable');
  expect(resolveModelChoice('gpt-5.6-sol')?.provider).toBe('codex');
});

test('an unknown or misspelled name is never silently accepted', () => {
  for (const bad of [
    'fabel',
    'claude-fable',
    'gpt-9',
    '',
    '   ',
    'opus; rm -rf /',
    '$(id)',
  ]) {
    expect(resolveModelChoice(bad)).toBeNull();
  }
});

test('the unknown-name reply lists every valid choice', () => {
  const msg = formatUnknownModel('fabel');
  expect(msg).toContain('fabel');
  for (const choice of MODEL_CATALOG) {
    expect(msg).toContain(choice.name);
    expect(msg).toContain(choice.model);
  }
});

// ── runtime.env upsert ──────────────────────────────────────────────────────

test('upsert appends a pin to an empty or absent runtime.env', () => {
  const out = upsertEnvAssignment('', 'ORCH_CLAUDE_MODEL', 'claude-fable-5');
  expect(out).toContain('ORCH_CLAUDE_MODEL=claude-fable-5');
  expect(out.endsWith('\n')).toBe(true);
});

test('upsert replaces an existing live assignment in place', () => {
  const before = [
    'ORCH_CODEX_MODEL=gpt-5.6-sol',
    'ORCH_CLAUDE_MODEL=claude-sonnet-5',
    'ORCH_CODEX_REASONING_EFFORT=high',
    '',
  ].join('\n');
  const out = upsertEnvAssignment(
    before,
    'ORCH_CLAUDE_MODEL',
    'claude-fable-5',
  );
  const lines = out.trim().split('\n');
  expect(lines).toEqual([
    'ORCH_CODEX_MODEL=gpt-5.6-sol',
    'ORCH_CLAUDE_MODEL=claude-fable-5',
    'ORCH_CODEX_REASONING_EFFORT=high',
  ]);
  // Exactly one live assignment — a second one would silently win at source time.
  expect(out.match(/^ORCH_CLAUDE_MODEL=/gm)?.length).toBe(1);
});

test('upsert leaves the commented documentation line alone', () => {
  const before = '# ORCH_CLAUDE_MODEL=claude-opus-5\n';
  const out = upsertEnvAssignment(before, 'ORCH_CLAUDE_MODEL', 'claude-fable-5');
  expect(out).toContain('# ORCH_CLAUDE_MODEL=claude-opus-5');
  expect(out).toMatch(/^ORCH_CLAUDE_MODEL=claude-fable-5$/m);
});

test('upsert refuses any key outside the provider-scoped allowlist', () => {
  for (const key of ['ORCH_PROVIDER', 'ORCH_MODEL', 'ORCH_SESSION', 'PATH']) {
    expect(() => upsertEnvAssignment('', key, 'x')).toThrow();
  }
});

test('upsert refuses a value that runtime.env would execute when sourced', () => {
  // runtime.env is SOURCED by launch.sh, so an unvalidated value is shell input.
  for (const value of [
    '$(id)',
    '`id`',
    'a b',
    'a\nORCH_PROVIDER=codex',
    'a"b',
    "a'b",
    '',
  ]) {
    expect(() =>
      upsertEnvAssignment('', 'ORCH_CLAUDE_MODEL', value),
    ).toThrow();
  }
});

// ── launch.sh `model` output ────────────────────────────────────────────────

test('the launcher model report parses into resolved state', () => {
  const state = parseLauncherModelState(
    [
      'provider=codex',
      'config_file=/root/bpa-dev-infrastructure/orchestrator/runtime.env',
      'claude_model=claude-opus-5',
      'codex_model=gpt-5.6-sol',
      '',
    ].join('\n'),
  );
  expect(state).toEqual({
    provider: 'codex',
    configFile: '/root/bpa-dev-infrastructure/orchestrator/runtime.env',
    claudeModel: 'claude-opus-5',
    codexModel: 'gpt-5.6-sol',
  });
});

test('a truncated or unparseable launcher report is not guessed at', () => {
  expect(parseLauncherModelState('')).toBeNull();
  expect(parseLauncherModelState('provider=codex\n')).toBeNull();
  expect(parseLauncherModelState('launch.sh: command not found')).toBeNull();
});

// ── Replies ─────────────────────────────────────────────────────────────────

const STATE = {
  provider: 'claude',
  configFile: '/opt/infra/orchestrator/runtime.env',
  claudeModel: 'claude-opus-5',
  codexModel: 'gpt-5.6-sol',
};

test('the no-argument report names the current provider AND model', () => {
  const msg = formatModelReport({ liveProvider: 'claude', state: STATE });
  expect(msg).toContain('claude');
  expect(msg).toContain('claude-opus-5');
  expect(msg).toContain('gpt-5.6-sol');
});

test('the no-argument report lists the selectable vocabulary', () => {
  const msg = formatModelReport({ liveProvider: 'claude', state: STATE });
  for (const choice of MODEL_CATALOG) {
    expect(msg).toContain(`/model ${choice.name}`);
    expect(msg).toContain(choice.model);
  }
});

test('the no-argument report is honest when nothing is running', () => {
  const msg = formatModelReport({ liveProvider: null, state: STATE });
  expect(msg).toMatch(/не запущен|not running/i);
  // Still reports what the NEXT launch would use — never a blank.
  expect(msg).toContain('claude-opus-5');
});

test('the no-argument report degrades loudly when the launcher cannot be read', () => {
  const msg = formatModelReport({ liveProvider: 'claude', state: null });
  expect(msg).toMatch(/NO-GO|не вдалося|unavailable/i);
  // Vocabulary is still listed — the operator must not have to guess.
  expect(msg).toContain('/model fable');
});

test('a same-provider switch says explicitly that it applies on relaunch', () => {
  const msg = formatModelSelection({
    choice: resolveModelChoice('fable')!,
    liveProvider: 'claude',
    sessionAlive: true,
    previousModel: 'claude-opus-5',
  });
  expect(msg).toContain('claude-fable-5');
  expect(msg).toContain('claude-opus-5'); // what is still running
  expect(msg).toMatch(/\/restart/);
  expect(msg).toMatch(/не миттєво|наступн/i); // "not immediately / on next start"
});

test('a cross-provider pin says which start command applies it', () => {
  const msg = formatModelSelection({
    choice: resolveModelChoice('gpt-5.6-sol')!,
    liveProvider: 'claude',
    sessionAlive: true,
    previousModel: 'gpt-5.6-sol',
  });
  expect(msg).toContain('/start_codex');
  // Must NOT tell the operator that /restart applies it — /restart relaunches
  // the CURRENT provider, so a codex pin would not take effect.
  expect(msg).not.toContain('/restart');
});

test('with no session running the reply points at the start command', () => {
  const msg = formatModelSelection({
    choice: resolveModelChoice('fable')!,
    liveProvider: null,
    sessionAlive: false,
    previousModel: 'claude-opus-5',
  });
  expect(msg).toContain('/start_claude');
  expect(msg).not.toContain('/restart');
});

test('every selection reply names the persistence file semantics', () => {
  for (const choice of MODEL_CATALOG) {
    const msg = formatModelSelection({
      choice,
      liveProvider: 'claude',
      sessionAlive: true,
      previousModel: null,
    });
    expect(msg).toContain(choice.model);
    expect(msg).toMatch(/runtime\.env|переживе|persist/i);
  }
});
