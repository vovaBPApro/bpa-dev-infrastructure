import { expect, test } from 'bun:test';
import {
  buildAgentLines,
  buildDaemonHealth,
  buildRuntimeStatus,
  countActiveLanes,
  isTransportSessionConnected,
  parseWorktreePorcelain,
  type JsonReadResult,
  type RuntimeStatusDeps,
  type ShRunner,
} from './status';

test('REGRESSION ML-4: dead or half-open transport is not connected', () => {
  expect(
    isTransportSessionConnected(true, true, {
      destroyed: false,
      socket: { destroyed: true },
    }),
  ).toBe(false);
  expect(
    isTransportSessionConnected(true, true, {
      destroyed: true,
      socket: { destroyed: false },
    }),
  ).toBe(false);
  expect(isTransportSessionConnected(true, true)).toBe(false);
});

test('transport session is connected only with server and live socket', () => {
  const liveResponse = {
    destroyed: false,
    socket: { destroyed: false },
  };

  expect(isTransportSessionConnected(true, true, liveResponse)).toBe(true);
  expect(isTransportSessionConnected(false, true, liveResponse)).toBe(false);
  expect(isTransportSessionConnected(true, false, liveResponse)).toBe(false);
});

test('REGRESSION: daemon health uses process-local honest field names and epochs', () => {
  const health = buildDaemonHealth({
    pid: 42,
    bot: { connected: false },
    claudeConnected: false,
    tmuxSession: '',
    tmuxAlive: false,
    inMemoryBufferCount: 3,
    processStartedAt: '2026-07-30T00:00:00.000Z',
  });
  expect(health).toMatchObject({
    bot: 'not_connected',
    claude_connected: false,
    in_memory_buffer: {
      count: 3,
      dropped_count: 0,
      process_started_at: '2026-07-30T00:00:00.000Z',
    },
  });
  expect(health).not.toHaveProperty('buffered_msgs');
});

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
  expect(lines).toContain('lane_worktrees: 2 (worktree query ok)');
  expect(lines).toContain('  ag-status-fix: +5');
  expect(lines).toContain('  ag-item6-tail: +5');
});

test('REGRESSION: running processes with no lane worktrees are never presented as zero agents', () => {
  const onlyCanonical = [
    'worktree /home/bpa-shell/bpa-dev-infrastructure',
    'branch refs/heads/main',
    '',
  ].join('\n');
  const lines = buildAgentLines(CANON, fakeRunner(onlyCanonical), {
    countRunningAgents: () => ({ count: 4, source: 'test process census' }),
  });
  expect(lines).toContain('running_agents: 4 (processes: test process census)');
  expect(lines).toContain('lane_worktrees: 0 (worktree query ok)');
  expect(lines.join('\n')).not.toMatch(/agents[^\n]*0.*verified/i);
});

test('buildAgentLines: git failure -> "unknown", never a fabricated 0', () => {
  const failing: ShRunner = () => ({ out: '', ok: false });
  const lines = buildAgentLines(CANON, failing);
  expect(lines).toContain(`lane_worktrees: unknown (git worktree list failed on ${CANON})`);
  expect(lines.join('\n')).not.toContain('0 (verified');
});

test('REGRESSION: git timeout becomes unknown and does not fabricate a zero', () => {
  const timeout: ShRunner = () => ({ out: '', ok: false, timedOut: true });
  const lines = buildAgentLines(CANON, timeout);
  expect(lines).toContain('lane_worktrees: unknown (git timeout)');
  expect(lines.join('\n')).not.toContain('lane_worktrees: 0');
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
    mission: { present: false, reason: 'no state DB at /nope/state.db' },
    binding: null,
    lastRelayResult: 'none',
    lastPaneProgressAt: 0,
    lastGitProgressAt: 0,
    ...overrides,
  };
}

test('buildRuntimeStatus reports worktrees separately from running agents', () => {
  // State file entirely absent, yet lanes exist -> must report the real count.
  const lines = buildRuntimeStatus(statusDeps());
  expect(lines).toContain('lane_worktrees: 2 (worktree query ok)');
  expect(lines).toContain('running_agents: unknown (process query unavailable)');
});

test('ACCEPTANCE: teardown/startup overlap never fabricates a zero-width fleet', () => {
  // Teardown snapshot: open lane worktrees remain while the process census is
  // unavailable during restart. The process side degrades to unknown.
  const duringTeardown = buildRuntimeStatus(statusDeps());
  expect(duringTeardown).toContain('lane_worktrees: 2 (worktree query ok)');
  expect(duringTeardown).toContain(
    'running_agents: unknown (process query unavailable)',
  );
  expect(duringTeardown).not.toContain('running_agents: 0');

  // Startup snapshot: a process is running while the worktree census times out.
  // The worktree side must degrade to unknown rather than presenting idle.
  const duringStartup = buildRuntimeStatus(
    statusDeps({
      runCmd: () => ({ out: '', ok: false, timedOut: true }),
      countRunningAgents: () => ({
        count: 1,
        source: 'test process census',
      }),
    }),
  );
  expect(duringStartup).toContain(
    'running_agents: 1 (processes: test process census)',
  );
  expect(duringStartup).toContain('lane_worktrees: unknown (git timeout)');
  expect(duringStartup).not.toContain('lane_worktrees: 0');
});

test('REGRESSION: last relay is labeled as an attempt with unknown acknowledgement', () => {
  const lines = buildRuntimeStatus(
    statusDeps({ lastRelayResult: 'codex:deliver:sent' }),
  );
  expect(lines).toContain('last_relay_attempt: codex:deliver:sent');
  expect(lines).toContain(
    'last_relay_attempt_acknowledgement: unknown (no end-to-end ack signal)',
  );
  expect(lines.some((line) => line.startsWith('last_relay:'))).toBe(false);
});

test('REGRESSION: live connectivity observations fail closed when targets are unreachable', () => {
  const health = buildDaemonHealth({
    pid: 42,
    bot: { connected: false },
    claudeConnected: false,
    tmuxSession: 'orchestrator',
    tmuxAlive: false,
    inMemoryBufferCount: 0,
    processStartedAt: '2026-07-30T00:00:00.000Z',
  });
  expect(health.bot).toBe('not_connected');
  expect(health.claude_connected).toBe(false);
});

test('buildRuntimeStatus: missing state files degrade to honest n/a, no throw', () => {
  const lines = buildRuntimeStatus(statusDeps());
  const joined = lines.join('\n');
  expect(joined).toContain('plan: n/a (no orchestrator-state.json)');
  expect(joined).toContain('context: n/a (no orchestrator-state.json)');
  expect(joined).toContain('vendor_quota: n/a (no orchestrator-state.json)');
  expect(joined).toContain('mission: n/a (no state DB at /nope/state.db)');
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
  expect(joined).toContain('lane_worktrees: 2 (worktree query ok)');
  expect(joined).toContain('providers_active: codex:3, opus:unknown, gemini:unknown');
  expect(joined).toContain('vendor_override: codex');
  expect(joined).toContain('instance: unknown, pid=4242');
  expect(joined).toContain('binding: codex/sess-9');
});

test('REGRESSION: a missing provider key is unknown, never zero', () => {
  const state = { runtime_stats: { providers_active: { codex: 2 } } };
  const lines = buildRuntimeStatus(
    statusDeps({
      readJson: (path) =>
        path.includes('state')
          ? { present: true, value: state }
          : { present: false },
    }),
  );
  expect(lines).toContain('providers_active: codex:2, opus:unknown, gemini:unknown');
});

test('REGRESSION: stale state values are labeled with their age', () => {
  const now = Date.parse('2026-07-29T10:30:00.000Z');
  const state = {
    current_plan: { id: 'PLAN_OLD', phase: 'impl' },
    runtime_stats: { context_band: 'green' },
  };
  const lines = buildRuntimeStatus(
    statusDeps({
      now,
      readJson: (path) =>
        path.includes('state')
          ? { present: true, value: state, modifiedAt: now - 11 * 60_000 }
          : { present: false },
    }),
  );
  expect(lines).toContain('plan: PLAN_OLD (impl) (stale, age 11m)');
  expect(lines).toContain('context: green (stale, age 11m)');
});

test('buildRuntimeStatus renders the mission read from the durable state DB', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z');
  const fresh = buildRuntimeStatus(
    statusDeps({
      now,
      mission: {
        present: true,
        mission: { status: 'running', desc: 'HR-101 re-arm alarm' },
        updatedAt: now - 60_000,
      },
    }),
  );
  expect(fresh).toContain('mission: running: HR-101 re-arm alarm');

  const stale = buildRuntimeStatus(
    statusDeps({
      now,
      mission: {
        present: true,
        mission: { status: 'running', desc: 'HR-101 re-arm alarm' },
        updatedAt: now - 47 * 60_000,
      },
    }),
  );
  expect(stale).toContain(
    'mission: running: HR-101 re-arm alarm (stale, age 47m)',
  );

  const none = buildRuntimeStatus(
    statusDeps({ mission: { present: true, mission: null, updatedAt: null } }),
  );
  expect(none).toContain('mission: none');
});

// REGRESSION: an unreadable mission source must never render as "none". "none"
// means "the source answered and there is no mission"; a broken source has to
// say so, or a disarmed alarm looks identical to an idle one.
test('buildRuntimeStatus distinguishes a broken mission source from no mission', () => {
  const broken = buildRuntimeStatus(
    statusDeps({
      mission: {
        present: false,
        reason: 'state DB unreadable: disk I/O error',
      },
    }),
  );
  expect(broken).toContain('mission: n/a (state DB unreadable: disk I/O error)');
  expect(broken.join('\n')).not.toContain('mission: none');
});

// This is the field the /status handler embeds verbatim in the Telegram message
// (server.ts handleSessionCommand joins buildOrchRuntimeStatus() + agent lines).
test('status message body contains truthful process and worktree labels', () => {
  const orch = buildRuntimeStatus(statusDeps());
  const agents = buildAgentLines(CANON, fakeRunner(PORCELAIN_TWO_LANES));
  const msg = `Orchestrator:\n${orch.join('\n')}\n\n${agents.join('\n')}`;
  expect(msg).toContain('lane_worktrees: 2 (worktree query ok)');
  expect(msg).toContain('running_agents: unknown (process query unavailable)');
  expect(msg).not.toContain('agents_active:');
});
