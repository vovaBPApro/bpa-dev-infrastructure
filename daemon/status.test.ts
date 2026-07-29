import { expect, test } from 'bun:test';
import {
  buildAgentLines,
  buildRuntimeStatus,
  countActiveLanes,
  parseWorktreePorcelain,
  type JsonReadResult,
  type RuntimeStatusDeps,
  type ShRunner,
} from './status';

// A fake `git worktree list --porcelain` for the canonical infra repo with two
// live coder lanes plus the canonical checkout itself. This is the shape the new
// stack actually produces (lanes under /home/bpa-shell/.cache/infra-lanes/*).
const PORCELAIN_TWO_LANES = [
  'worktree /home/bpa-shell/bpa-dev-infrastructure',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /home/bpa-shell/.cache/infra-lanes/status-fix',
  'HEAD 2222222222222222222222222222222222222222',
  'branch refs/heads/ag-status-fix',
  '',
  'worktree /home/bpa-shell/.cache/infra-lanes/item6-tail',
  'HEAD 3333333333333333333333333333333333333333',
  'branch refs/heads/ag-item6-tail',
  '',
].join('\n');

// A runner that answers the worktree-list call with `porcelain` and any
// `rev-list --count` call with a fixed ahead count.
function fakeRunner(porcelain: string, aheadOut = '2'): ShRunner {
  return (cmd) => {
    if (cmd.includes('worktree list')) return { out: porcelain, ok: true };
    if (cmd.includes('rev-list --count')) return { out: aheadOut, ok: true };
    return { out: '', ok: true };
  };
}

const CANON = '/home/bpa-shell/bpa-dev-infrastructure';

test('parseWorktreePorcelain pairs each worktree with its branch', () => {
  const entries = parseWorktreePorcelain(PORCELAIN_TWO_LANES);
  expect(entries).toEqual([
    { path: '/home/bpa-shell/bpa-dev-infrastructure', branch: 'main' },
    {
      path: '/home/bpa-shell/.cache/infra-lanes/status-fix',
      branch: 'ag-status-fix',
    },
    {
      path: '/home/bpa-shell/.cache/infra-lanes/item6-tail',
      branch: 'ag-item6-tail',
    },
  ]);
});

// REGRESSION LOCK for Telegram msg 11582: two lane worktrees exist, so /status
// must NOT report 0 agents. The pre-fix logic read a hard-coded
// ~/BPAprojects/agent-bill repo (absent on this layout) or the state file's
// agents_active, both of which yield 0 while lanes run — this locks the truth.
test('REGRESSION: lane worktrees present -> count is 2, never 0', () => {
  const lanes = countActiveLanes(CANON, fakeRunner(PORCELAIN_TWO_LANES));
  expect(lanes.verified).toBe(true);
  if (!lanes.verified) throw new Error('expected verified');
  expect(lanes.count).toBe(2);
  expect(lanes.count).not.toBe(0);
  expect(lanes.lanes.map((l) => l.branch)).toEqual([
    'ag-status-fix',
    'ag-item6-tail',
  ]);
});

test('buildAgentLines shows the verified count and per-lane ahead', () => {
  const lines = buildAgentLines(CANON, fakeRunner(PORCELAIN_TWO_LANES, '5'));
  expect(lines[0]).toBe('agents: 2 (verified)');
  expect(lines).toContain('  ag-status-fix: +5');
  expect(lines).toContain('  ag-item6-tail: +5');
});

test('buildAgentLines: no lanes -> honest "0 (verified)", not "unknown"', () => {
  const onlyCanonical = [
    'worktree /home/bpa-shell/bpa-dev-infrastructure',
    'branch refs/heads/main',
    '',
  ].join('\n');
  const lines = buildAgentLines(CANON, fakeRunner(onlyCanonical));
  expect(lines).toEqual(['agents: 0 (verified, no lane worktrees)']);
});

test('buildAgentLines: git failure -> "unknown", never a fabricated 0', () => {
  const failing: ShRunner = () => ({ out: '', ok: false });
  const lines = buildAgentLines(CANON, failing);
  expect(lines[0].startsWith('agents: unknown')).toBe(true);
  expect(lines[0]).not.toContain('0 (verified');
});

// Full runtime-status builder wiring: fixtures for the JSON reader, no real
// system state. Distinguishes a present state file from an absent one.
function statusDeps(
  overrides: Partial<RuntimeStatusDeps> = {},
): RuntimeStatusDeps {
  return {
    canonicalRepo: CANON,
    runCmd: fakeRunner(PORCELAIN_TWO_LANES),
    readJson: () => ({ present: false }) as JsonReadResult,
    statePath: '/nope/orchestrator-state.json',
    lockPath: '/nope/orchestrator-chat-1.lock',
    missionsPath: '/nope/orchestrator-missions.json',
    parseMission: () => null,
    binding: null,
    lastRelayResult: 'none',
    lastPaneProgressAt: 0,
    lastGitProgressAt: 0,
    ...overrides,
  };
}

test('buildRuntimeStatus agents_active is from worktrees, not the state file', () => {
  // State file entirely absent, yet lanes exist -> must report the real count.
  const lines = buildRuntimeStatus(statusDeps());
  expect(lines).toContain('agents_active: 2 (verified)');
  // and NOT a fabricated zero anywhere on the agents line.
  const agentLine = lines.find((l) => l.startsWith('agents_active'));
  expect(agentLine).not.toBe('agents_active: 0');
});

test('buildRuntimeStatus: missing state files degrade to honest n/a, no throw', () => {
  const lines = buildRuntimeStatus(statusDeps());
  const joined = lines.join('\n');
  expect(joined).toContain('plan: n/a (no orchestrator-state.json)');
  expect(joined).toContain('context: n/a (no orchestrator-state.json)');
  expect(joined).toContain('vendor_quota: n/a (no orchestrator-state.json)');
  expect(joined).toContain(
    'mission: n/a (no orchestrator-missions.json)',
  );
  // Lock file absent -> honest "stopped (no lock file)", not a stale running pid.
  expect(joined).toContain('instance: stopped (no lock file)');
});

test('buildRuntimeStatus: present state file surfaces real fields', () => {
  const state = {
    current_plan: { id: 'PLAN_X', phase: 'impl' },
    runtime_stats: { context_band: 'green', providers_active: { codex: 3 } },
    vendor_quota: { anthropic: 'ok', openai: 'ok', gemini: 'n/a' },
    current_vendor_override: { vendor: 'codex' },
  };
  const lock = { pid: 4242, pid_started_at: '2026-07-29T08:00:00.000Z' };
  const readJson = (path: string): JsonReadResult => {
    if (path.includes('state')) return { present: true, value: state };
    if (path.includes('lock')) return { present: true, value: lock };
    return { present: false };
  };
  const lines = buildRuntimeStatus(
    statusDeps({
      readJson,
      binding: { provider: 'codex', session_id: 'sess-9' },
    }),
  );
  const joined = lines.join('\n');
  expect(joined).toContain('plan: PLAN_X (impl)');
  expect(joined).toContain('context: green');
  expect(joined).toContain('agents_active: 2 (verified)');
  expect(joined).toContain('providers_active: codex:3, opus:0, gemini:0');
  expect(joined).toContain('vendor_override: codex');
  expect(joined).toContain('instance: running, pid=4242');
  expect(joined).toContain('binding: codex/sess-9');
});

// This is the field the /status handler embeds verbatim in the Telegram message
// (server.ts handleSessionCommand joins buildOrchRuntimeStatus() + agent lines).
// Proving the truthful count is in the builder output proves it reaches the msg.
test('status message body contains the truthful agent count', () => {
  const orch = buildRuntimeStatus(statusDeps());
  const agents = buildAgentLines(CANON, fakeRunner(PORCELAIN_TWO_LANES));
  const msg = `Orchestrator:\n${orch.join('\n')}\n\n${agents.join('\n')}`;
  expect(msg).toContain('agents_active: 2 (verified)');
  expect(msg).toContain('agents: 2 (verified)');
  expect(msg).not.toContain('agents: none');
});
