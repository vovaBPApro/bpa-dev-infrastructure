// Pure builders for the /status command.
//
// These are extracted from server.ts so the truthfulness of /status can be
// tested without the live system. Every field either reflects ground truth the
// stack actually measured, or degrades HONESTLY to `unknown`/`n/a`.

// A shell runner with the same shape as server.ts's `sh`.
export type ShRunner = (cmd: string) => {
  out: string;
  ok: boolean;
  timedOut?: boolean;
};

// A JSON reader with the same shape as reliability.ts's `maybeReadJson`, but
// tri-state so callers can tell "file absent" from "file present but empty".
export type JsonReadResult =
  | { present: false }
  | { present: true; value: unknown; modifiedAt?: number };

export type JsonReader = (path: string) => JsonReadResult;

// Default lane worktree root and branch prefix for the new infra layout.
export const LANE_WORKTREE_ROOT = '/home/bpa-shell/.cache/infra-lanes/';
export const LANE_BRANCH_PREFIX = 'ag-';

export type LaneWorktree = { path: string; branch: string; ahead: number };
export type RunningAgents = { count: number; source: string } | null;
export type RunningAgentCounter = () => RunningAgents;

export const STATE_FRESHNESS_MS = 10 * 60 * 1000;

export type DaemonHealthDeps = {
  pid: number;
  bot: { connected: true; username: string } | { connected: false };
  claudeConnected: boolean;
  tmuxSession: string;
  tmuxAlive: boolean;
  inMemoryBufferCount: number;
  inMemoryBufferDroppedCount?: number;
  processStartedAt: string;
};

export type TransportResponseState = {
  destroyed: boolean;
  socket?: { destroyed: boolean } | null;
};

// A registered server is not proof that its transport is still usable.
// Unknown response state is deliberately disconnected: health must fail closed.
export function isTransportSessionConnected(
  serverPresent: boolean,
  transportPresent: boolean,
  response?: TransportResponseState,
): boolean {
  return (
    serverPresent &&
    transportPresent &&
    response !== undefined &&
    !response.destroyed &&
    !(response.socket?.destroyed ?? true)
  );
}

export type HumanStatusLane = { id: string; state: string };

export type HumanStatusInput = {
  mission: MissionStatusInput;
  lanes: HumanStatusLane[] | null;
  laneError?: string;
  lastLanded: string | null;
  lastLandedError?: string;
  claudeConnected: boolean;
};

// The normal Telegram view is intentionally a projection, not a dump of the
// diagnostic fields. Unknown inputs stay visibly unknown.
export function buildHumanStatus(input: HumanStatusInput): string[] {
  const mission = !input.mission.present
    ? `невідомо (${input.mission.reason})`
    : input.mission.mission
      ? `${input.mission.mission.desc} — ${input.mission.mission.status}`
      : 'немає активної місії';

  const laneLine = input.lanes
    ? input.lanes.length === 0
      ? '0 активних'
      : `${input.lanes.length}: ${input.lanes.map((lane) => `${lane.id} (${lane.state})`).join(', ')}`
    : `невідомо (${input.laneError ?? 'джерело стану недоступне'})`;
  const blocked = input.lanes
    ? input.lanes.filter((lane) => lane.state === 'failed')
    : [];
  const blockedLine = input.lanes
    ? blocked.length
      ? blocked.map((lane) => `${lane.id}: стан failed`).join(', ')
      : 'немає'
    : `невідомо (${input.laneError ?? 'джерело стану недоступне'})`;

  return [
    `Зараз: ${mission}`,
    `Лейни: ${laneLine}`,
    `Останнє landed: ${input.lastLanded ?? `невідомо (${input.lastLandedError ?? 'git недоступний'})`}`,
    `Блокери: ${blockedLine}`,
    `Claude MCP: ${input.claudeConnected ? 'підключено' : 'не підключено'}`,
  ];
}

// Build only from observations made for this status read. The buffer and its
// counters are explicitly scoped to this daemon process lifetime.
export function buildDaemonHealth(deps: DaemonHealthDeps) {
  return {
    daemon: 'running',
    pid: deps.pid,
    bot: deps.bot.connected ? deps.bot.username : 'not_connected',
    claude_connected: deps.claudeConnected,
    tmux_session: deps.tmuxSession || '(not configured)',
    tmux_alive: deps.tmuxSession ? deps.tmuxAlive : 'n/a',
    in_memory_buffer: {
      count: deps.inMemoryBufferCount,
      dropped_count: deps.inMemoryBufferDroppedCount ?? 0,
      process_started_at: deps.processStartedAt,
    },
  };
}

export type ActiveLanes =
  | {
      // Count derived from real ground truth.
      verified: true;
      count: number;
      lanes: LaneWorktree[];
    }
  | {
      // git could not be queried; count is genuinely unknown.
      verified: false;
      reason: string;
    };

// Parse `git worktree list --porcelain` output into path/branch pairs.
export function parseWorktreePorcelain(
  out: string,
): { path: string; branch: string }[] {
  const entries: { path: string; branch: string }[] = [];
  let path: string | null = null;
  let branch = '';
  const flush = () => {
    if (path) entries.push({ path, branch });
    path = null;
    branch = '';
  };
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      flush();
      path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      branch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return entries;
}

// Derive the configured coder-lane worktree set from `git worktree list` on the
// canonical repo. This measures worktrees, not processes. A lane is a worktree
// under LANE_WORKTREE_ROOT whose checked-out branch starts with
// LANE_BRANCH_PREFIX.
export function countActiveLanes(
  canonicalRepo: string,
  runCmd: ShRunner,
  opts: {
    root?: string;
    branchPrefix?: string;
    baseRef?: string;
  } = {},
): ActiveLanes {
  const root = opts.root ?? LANE_WORKTREE_ROOT;
  const branchPrefix = opts.branchPrefix ?? LANE_BRANCH_PREFIX;
  const baseRef = opts.baseRef ?? 'origin/main';

  const res = runCmd(
    `git -C '${canonicalRepo}' worktree list --porcelain 2>/dev/null`,
  );
  if (res.timedOut) return { verified: false, reason: 'git timeout' };
  if (!res.ok) {
    return {
      verified: false,
      reason: `git worktree list failed on ${canonicalRepo}`,
    };
  }

  const lanes: LaneWorktree[] = [];
  for (const { path, branch } of parseWorktreePorcelain(res.out)) {
    const isLanePath = path.startsWith(root);
    const isLaneBranch = branch.startsWith(branchPrefix);
    if (!isLanePath || !isLaneBranch) continue;
    const aheadRes = runCmd(
      `git -C '${path}' rev-list --count '${baseRef}'..HEAD 2>/dev/null`,
    );
    if (aheadRes.timedOut) {
      return { verified: false, reason: 'git timeout' };
    }
    const ahead =
      aheadRes.ok && /^\d+$/.test(aheadRes.out.trim())
        ? parseInt(aheadRes.out.trim(), 10)
        : -1;
    lanes.push({ path, branch, ahead });
  }
  return { verified: true, count: lanes.length, lanes };
}

// One-line-per-lane view for /status. A process census, when available, is
// separate from the worktree census; git failure is always "unknown".
export function buildAgentLines(
  canonicalRepo: string,
  runCmd: ShRunner,
  opts: {
    root?: string;
    branchPrefix?: string;
    baseRef?: string;
    countRunningAgents?: RunningAgentCounter;
  } = {},
): string[] {
  const lanes = countActiveLanes(canonicalRepo, runCmd, opts);
  const running = opts.countRunningAgents?.() ?? null;
  const runningLine = running
    ? `running_agents: ${running.count} (processes: ${running.source})`
    : 'running_agents: unknown (process query unavailable)';
  if (!lanes.verified) {
    return [runningLine, `lane_worktrees: unknown (${lanes.reason})`];
  }
  if (lanes.count === 0)
    return [runningLine, 'lane_worktrees: 0 (worktree query ok)'];
  const lines = [runningLine, `lane_worktrees: ${lanes.count} (worktree query ok)`];
  for (const l of lanes.lanes.slice(0, 15)) {
    const nm = l.branch || l.path.split('/').pop() || l.path;
    const ahead = l.ahead >= 0 ? `+${l.ahead}` : 'ahead=n/a';
    lines.push(`  ${nm}: ${ahead}`);
  }
  return lines;
}

// Read one string field from an optional JSON state file, degrading honestly.
// `label` names the file for the n/a message.
type FieldResult =
  | { kind: 'value'; text: string }
  | { kind: 'na'; text: string };

function stateAge(read: JsonReadResult, now: number): string | null {
  if (!read.present || read.modifiedAt === undefined) return null;
  const ageMs = Math.max(0, now - read.modifiedAt);
  return ageMs > STATE_FRESHNESS_MS
    ? `stale, age ${Math.floor(ageMs / 60000)}m`
    : null;
}

function stateField(
  read: JsonReadResult,
  label: string,
  pick: (obj: Record<string, unknown>) => string | null,
  now: number,
): FieldResult {
  if (!read.present) return { kind: 'na', text: `n/a (no ${label})` };
  const obj =
    read.value && typeof read.value === 'object'
      ? (read.value as Record<string, unknown>)
      : null;
  if (!obj) return { kind: 'na', text: `n/a (${label} not an object)` };
  const v = pick(obj);
  const age = stateAge(read, now);
  return v === null
    ? {
        kind: 'na',
        text: `unknown (field absent in ${label}${age ? `; ${age}` : ''})`,
      }
    : { kind: 'value', text: age ? `${v} (${age})` : v };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function formatIso(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? input : d.toISOString();
}

// Mission input for /status. It is passed in already resolved rather than as a
// path plus a parser, because the mission's home is now the durable state DB
// (`daemon/mission-source.ts`), not a JSON file. `present: false` carries the
// reason so a broken mission input is reported instead of being rendered as an
// honest-looking "none".
export type MissionStatusInput =
  | { present: false; reason: string }
  | {
      present: true;
      mission: { status: string; desc: string } | null;
      updatedAt?: number | null;
    };

export type RuntimeStatusDeps = {
  canonicalRepo: string;
  runCmd: ShRunner;
  readJson: JsonReader;
  statePath: string;
  lockPath: string | null;
  mission: MissionStatusInput;
  binding: { provider: string; session_id?: string } | null;
  lastRelayResult: string;
  lastPaneProgressAt: number;
  lastGitProgressAt: number;
  laneOpts?: { root?: string; branchPrefix?: string; baseRef?: string };
  countRunningAgents?: RunningAgentCounter;
  isPidAlive?: (pid: number) => boolean;
  now?: number;
  vendorQuotaLines?: string[];
};

// Build the orchestrator runtime status lines. Process and worktree censuses
// are never read from legacy state, and state-file-backed fields show freshness
// rather than being presented as current by default.
export function buildRuntimeStatus(deps: RuntimeStatusDeps): string[] {
  const now = deps.now ?? Date.now();
  const stateRead = deps.readJson(deps.statePath);
  const lockRead = deps.lockPath
    ? deps.readJson(deps.lockPath)
    : ({ present: false } as JsonReadResult);
  const stateLabel = 'orchestrator-state.json';

  const plan = stateField(stateRead, stateLabel, (s) => {
    const cp = s.current_plan;
    if (cp && typeof cp === 'object') {
      const o = cp as Record<string, unknown>;
      if (typeof o.id === 'string' && typeof o.phase === 'string') {
        return `${o.id} (${o.phase})`;
      }
    }
    return null;
  }, now);

  const context = stateField(stateRead, stateLabel, (s) => {
    const rs = (s.runtime_stats ?? {}) as Record<string, unknown>;
    return asString(rs.context_band);
  }, now);

  // Worktrees and live agent processes are distinct measurements.
  const lanes = countActiveLanes(deps.canonicalRepo, deps.runCmd, deps.laneOpts);
  const running = deps.countRunningAgents?.() ?? null;
  const runningLine = running
    ? `running_agents: ${running.count} (processes: ${running.source})`
    : 'running_agents: unknown (process query unavailable)';
  const laneLine = lanes.verified
    ? `lane_worktrees: ${lanes.count} (worktree query ok)`
    : `lane_worktrees: unknown (${lanes.reason})`;

  const providers = stateField(stateRead, stateLabel, (s) => {
    const rs = (s.runtime_stats ?? {}) as Record<string, unknown>;
    const pa = rs.providers_active;
    if (!pa || typeof pa !== 'object') return null;
    const o = pa as Record<string, unknown>;
    return ['codex', 'opus', 'gemini']
      .map((k) => `${k}:${typeof o[k] === 'number' ? o[k] : 'unknown'}`)
      .join(', ');
  }, now);

  const quota = (() => {
    if (!stateRead.present) return `n/a (no ${stateLabel})`;
    const s =
      stateRead.value && typeof stateRead.value === 'object'
        ? (stateRead.value as Record<string, unknown>)
        : {};
    const vq =
      s.vendor_quota && typeof s.vendor_quota === 'object'
        ? (s.vendor_quota as Record<string, unknown>)
        : {};
    const g = (k: string) => asString(vq[k]) ?? 'unknown';
    const text = `anthropic=${g('anthropic')}, openai=${g('openai')}, gemini=${g('gemini')}`;
    const age = stateAge(stateRead, now);
    return age ? `${text} (${age})` : text;
  })();

  const override = stateField(stateRead, stateLabel, (s) => {
    const o = s.current_vendor_override;
    if (o && typeof o === 'object') {
      return asString((o as Record<string, unknown>).vendor);
    }
    return null;
  }, now);

  const instanceLine = (() => {
    if (!lockRead.present) {
      return deps.lockPath
        ? 'instance: stopped (no lock file)'
        : 'instance: n/a (no chat bound)';
    }
    const lock =
      lockRead.value && typeof lockRead.value === 'object'
        ? (lockRead.value as Record<string, unknown>)
        : {};
    const pid = typeof lock.pid === 'number' ? lock.pid : null;
    const started = formatIso(lock.pid_started_at) ?? 'n/a';
    if (!pid) return `instance: stopped, pid=n/a, started_at=${started}`;
    const alive = deps.isPidAlive ? deps.isPidAlive(pid) : null;
    const age = stateAge(lockRead, now);
    const state = alive === false ? 'dead' : alive === null ? 'unknown' : 'running';
    return `instance: ${state}, pid=${pid}, started_at=${started}${age ? ` (${age})` : ''}`;
  })();

  const bindingLabel = deps.binding
    ? `${deps.binding.provider}/${deps.binding.session_id || 'unknown'}`
    : 'idle/unbound';

  const mission = (() => {
    if (!deps.mission.present) return `n/a (${deps.mission.reason})`;
    const m = deps.mission.mission;
    if (!m) return 'none';
    const text = `${m.status}: ${m.desc}`;
    const updatedAt = deps.mission.updatedAt;
    const age = stateAge(
      updatedAt == null
        ? { present: true, value: null }
        : { present: true, value: null, modifiedAt: updatedAt },
      now,
    );
    return age ? `${text} (${age})` : text;
  })();

  return [
    `plan: ${plan.text}`,
    `context: ${context.text}`,
    runningLine,
    laneLine,
    `providers_active: ${providers.text}`,
    ...(deps.vendorQuotaLines ?? [`vendor_quota: ${quota}`]),
    `vendor_override: ${override.text}`,
    instanceLine,
    `binding: ${bindingLabel}`,
    `mission: ${mission}`,
    `last_relay_attempt: ${deps.lastRelayResult}`,
    'last_relay_attempt_acknowledgement: unknown (no end-to-end ack signal)',
    `last_progress: pane=${deps.lastPaneProgressAt ? new Date(deps.lastPaneProgressAt).toISOString() : 'n/a'}, git=${deps.lastGitProgressAt ? new Date(deps.lastGitProgressAt).toISOString() : 'n/a'}`,
  ];
}
