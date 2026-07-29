// Pure builders for the /status command.
//
// These are extracted from server.ts so the truthfulness of /status can be
// tested without the live system. Every field either reflects ground truth the
// new stack actually uses, or degrades HONESTLY: a value that could not be read
// is shown as `n/a (<reason>)`, never fabricated as a stale `0` or a value
// presented as current. We distinguish "0 (verified)" from "unknown".
//
// Ground truth for the active coder-lane count is `git worktree list` on the
// canonical repo, filtered to lane worktrees — the ONLY thing that is true
// regardless of whether any orchestrator wrote a runtime-state file. The old
// daemon derived the count from a hand-maintained `orchestrator-state.json`
// field (or a hard-coded `agent-bill` repo path that does not exist on this
// layout), so it happily printed `0 coders` while three lanes were running.

// A shell runner with the same shape as server.ts's `sh`.
export type ShRunner = (cmd: string) => { out: string; ok: boolean };

// A JSON reader with the same shape as reliability.ts's `maybeReadJson`, but
// tri-state so callers can tell "file absent" from "file present but empty".
export type JsonReadResult =
  | { present: false }
  | { present: true; value: unknown };

export type JsonReader = (path: string) => JsonReadResult;

// Default lane worktree root and branch prefix for the new infra layout.
export const LANE_WORKTREE_ROOT = '/home/bpa-shell/.cache/infra-lanes/';
export const LANE_BRANCH_PREFIX = 'ag-';

export type LaneWorktree = { path: string; branch: string; ahead: number };

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

// Derive the active coder-lane set from `git worktree list` on the canonical
// repo — the ground truth the new stack actually uses. A lane is a worktree
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
    const ahead =
      aheadRes.ok && /^\d+$/.test(aheadRes.out.trim())
        ? parseInt(aheadRes.out.trim(), 10)
        : -1;
    lanes.push({ path, branch, ahead });
  }
  return { verified: true, count: lanes.length, lanes };
}

// One-line-per-lane view for /status. Truthful count first; "0 (verified)" when
// the repo really has no lanes, "unknown" when git could not be queried.
export function buildAgentLines(
  canonicalRepo: string,
  runCmd: ShRunner,
  opts: { root?: string; branchPrefix?: string; baseRef?: string } = {},
): string[] {
  const lanes = countActiveLanes(canonicalRepo, runCmd, opts);
  if (!lanes.verified) {
    return [`agents: unknown (${lanes.reason})`];
  }
  if (lanes.count === 0) return ['agents: 0 (verified, no lane worktrees)'];
  const lines = [`agents: ${lanes.count} (verified)`];
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

function stateField(
  read: JsonReadResult,
  label: string,
  pick: (obj: Record<string, unknown>) => string | null,
): FieldResult {
  if (!read.present) return { kind: 'na', text: `n/a (no ${label})` };
  const obj =
    read.value && typeof read.value === 'object'
      ? (read.value as Record<string, unknown>)
      : null;
  if (!obj) return { kind: 'na', text: `n/a (${label} not an object)` };
  const v = pick(obj);
  return v === null
    ? { kind: 'na', text: `n/a (field absent in ${label})` }
    : { kind: 'value', text: v };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function formatIso(input: unknown): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? input : d.toISOString();
}

export type RuntimeStatusDeps = {
  canonicalRepo: string;
  runCmd: ShRunner;
  readJson: JsonReader;
  statePath: string;
  lockPath: string | null;
  missionsPath: string;
  parseMission: (raw: unknown) => { status: string; desc: string } | null;
  binding: { provider: string; session_id?: string } | null;
  lastRelayResult: string;
  lastPaneProgressAt: number;
  lastGitProgressAt: number;
  laneOpts?: { root?: string; branchPrefix?: string; baseRef?: string };
};

// Build the orchestrator runtime status lines. Unlike the old builder, the
// active-agent count is NOT read from orchestrator-state.json (which is absent
// on this layout and would fabricate 0); it is derived from real worktrees. All
// state-file-backed fields degrade to `n/a (no <file>)` instead of a silent 0.
export function buildRuntimeStatus(deps: RuntimeStatusDeps): string[] {
  const stateRead = deps.readJson(deps.statePath);
  const lockRead = deps.lockPath
    ? deps.readJson(deps.lockPath)
    : ({ present: false } as JsonReadResult);
  const missionsRead = deps.readJson(deps.missionsPath);

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
  });

  const context = stateField(stateRead, stateLabel, (s) => {
    const rs = (s.runtime_stats ?? {}) as Record<string, unknown>;
    return asString(rs.context_band);
  });

  // Ground-truth agent count — from worktrees, never the state file.
  const lanes = countActiveLanes(deps.canonicalRepo, deps.runCmd, deps.laneOpts);
  const agentsLine = lanes.verified
    ? `agents_active: ${lanes.count} (verified)`
    : `agents_active: unknown (${lanes.reason})`;

  const providers = stateField(stateRead, stateLabel, (s) => {
    const rs = (s.runtime_stats ?? {}) as Record<string, unknown>;
    const pa = rs.providers_active;
    if (!pa || typeof pa !== 'object') return null;
    const o = pa as Record<string, unknown>;
    return ['codex', 'opus', 'gemini']
      .map((k) => `${k}:${typeof o[k] === 'number' ? o[k] : 0}`)
      .join(', ');
  });

  const quota = (() => {
    if (!stateRead.present) return `n/a (no ${stateLabel})`;
    const s =
      stateRead.value && typeof stateRead.value === 'object'
        ? (stateRead.value as Record<string, unknown>)
        : {};
    const vq = (s.vendor_quota ?? {}) as Record<string, unknown>;
    const g = (k: string) => asString(vq[k]) ?? 'n/a';
    return `anthropic=${g('anthropic')}, openai=${g('openai')}, gemini=${g('gemini')}`;
  })();

  const override = stateField(stateRead, stateLabel, (s) => {
    const o = s.current_vendor_override;
    if (o && typeof o === 'object') {
      return asString((o as Record<string, unknown>).vendor);
    }
    return null;
  });

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
    return `instance: ${pid ? 'running' : 'stopped'}, pid=${pid ?? 'n/a'}, started_at=${started}`;
  })();

  const bindingLabel = deps.binding
    ? `${deps.binding.provider}/${deps.binding.session_id || 'unknown'}`
    : 'idle/unbound';

  const mission = (() => {
    if (!missionsRead.present) return 'n/a (no orchestrator-missions.json)';
    const m = deps.parseMission(missionsRead.value);
    return m ? `${m.status}: ${m.desc}` : 'none';
  })();

  return [
    `plan: ${plan.text}`,
    `context: ${context.text}`,
    agentsLine,
    `providers_active: ${providers.text}`,
    `vendor_quota: ${quota}`,
    `vendor_override: ${override.kind === 'value' ? override.text : 'auto (no override recorded)'}`,
    instanceLine,
    `binding: ${bindingLabel}`,
    `mission: ${mission}`,
    `last_relay: ${deps.lastRelayResult}`,
    `last_progress: pane=${deps.lastPaneProgressAt ? new Date(deps.lastPaneProgressAt).toISOString() : 'n/a'}, git=${deps.lastGitProgressAt ? new Date(deps.lastGitProgressAt).toISOString() : 'n/a'}`,
  ];
}
