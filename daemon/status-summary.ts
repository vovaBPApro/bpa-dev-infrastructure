// Human-facing /status summary (HR-150).
//
// Vova's verbatim complaint: «І доречі команда статус мені не дає жодноі
// корисноі інфо». The raw daemon JSON answers a machine's questions; this
// module answers his: what is being worked on, how many lanes and their
// states, what landed last, is anything blocked.
//
// HONESTY RULES (binding, from W-13 and Hard Rule 10):
//   - every source is optional; a missing/failed source renders as an honest
//     «невідомо» with the reason, never as a crash and never as an OK;
//   - anything derived from a state file is labeled with its age when stale;
//   - «Блокери: немає» is only ever printed when every probe actually
//     succeeded and observed no problem — a failed probe IS a listed blocker,
//     so absence of evidence can never render as "all good".
//
// All shell access goes through the injected ShRunner, which the caller
// (daemon/server.ts) builds with a hard timeout — the W-13 git-timeout
// pattern. This module never spawns anything on its own.

import { readFileSync } from 'node:fs';
import { countActiveLanes, type ActiveLanes, type ShRunner } from './status';

// ── Wording ──────────────────────────────────────────────────────────────────
// Every human-visible phrase lives in this one block so the wording can be
// edited in a single place without touching logic. Ukrainian by contract
// (operator language); do not translate to English.
export const UA = {
  orchLabel: 'Оркестратор',
  orchAlive: (hb: string) => `живий (серцебиття ${hb}`,
  orchStaleHb: (hb: string) =>
    `tmux активний, але серцебиття застаріле (${hb}) — стан невідомий`,
  orchNoHb: 'tmux активний, серцебиття відсутнє — стан невідомий',
  orchBadHb: 'tmux активний, серцебиття нечитабельне — стан невідомий',
  orchDead: 'не запущений (tmux-сесії немає)',
  orchNoTmuxConfig: 'невідомо (tmux-сесію не налаштовано)',
  orchTmuxProbeFailed: 'невідомо (не вдалося перевірити tmux)',
  model: (m: string) => `, модель: ${m})`,
  modelUnknown: ', модель: невідома)',
  missionLabel: 'Місія',
  missionNone: 'не задана',
  missionUnknown: (reason: string) => `невідомо (${reason})`,
  workLabel: 'Зараз в роботі',
  workNone: 'лейнів немає',
  workUnknown: (reason: string) => `невідомо (git: ${reason})`,
  laneNoCommits: 'ще без комітів',
  laneStateUnknown: 'стан невідомий',
  laneMore: (n: number) => `  • … і ще ${n}`,
  landedLabel: 'Останнє приземлене',
  landedNone: 'нічого не знайдено',
  landedUnknown: (reason: string) => `невідомо (git: ${reason})`,
  blockersLabel: 'Блокери',
  blockersNone: 'немає',
  blockerOrchDead: 'оркестратор не запущений',
  blockerOrchUnknown: 'стан оркестратора невідомий',
  blockerStaleHb: (hb: string) => `серцебиття оркестратора застаріле (${hb})`,
  blockerNoHb: 'серцебиття оркестратора відсутнє',
  blockerGit: (reason: string) => `git недоступний (${reason}) — стан лейнів невідомий`,
  justNow: 'щойно',
  minAgo: (n: number) => `${n} хв тому`,
  hourAgo: (n: number) => `${n} год тому`,
  dayAgo: (n: number) => `${n} дн тому`,
  updated: (age: string) => ` (оновлено ${age})`,
};

// Ukrainian relative age for humans. Coarse on purpose.
export function uaAge(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return UA.justNow;
  const min = Math.floor(clamped / 60_000);
  if (min < 60) return UA.minAgo(min);
  const hours = Math.floor(min / 60);
  if (hours < 48) return UA.hourAgo(hours);
  return UA.dayAgo(Math.floor(hours / 24));
}

// Ukrainian plural picker: one/few(2-4)/many.
export function uaPlural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = Math.abs(n) % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
// orchestrator/runtime/orchestrator.heartbeat holds one unix-seconds line,
// written by launch.sh and the turn-end relay. Stale means "the orchestrator
// has not finished a turn recently", which with a live tmux pane is exactly
// the "looks alive, actually wedged" state the Human must see.
export const HEARTBEAT_FRESH_MS = 10 * 60 * 1000;

export type HeartbeatReading =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'ok'; ageMs: number };

export function parseHeartbeat(raw: string | null, now: number): HeartbeatReading {
  if (raw === null) return { status: 'absent' };
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return { status: 'invalid' };
  const seconds = parseInt(t, 10);
  // A value in the future or absurdly old is a broken clock, not evidence.
  const ageMs = now - seconds * 1000;
  if (ageMs < -60_000) return { status: 'invalid' };
  return { status: 'ok', ageMs: Math.max(0, ageMs) };
}

export function readHeartbeatFile(path: string, now: number): HeartbeatReading {
  let raw: string | null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    raw = null;
  }
  return parseHeartbeat(raw, now);
}

// ── Last landed commits ──────────────────────────────────────────────────────
export type LandedEntry = { subject: string; ageMs: number };
export type LastLanded =
  | { verified: true; entries: LandedEntry[] }
  | { verified: false; reason: string };

// `git log <ref>` subject + committer unix time. Runs through the injected
// timeout runner; a wedged repo degrades to «невідомо», never wedges chat.
export function readLastLanded(
  repo: string,
  runCmd: ShRunner,
  opts: { ref?: string; limit?: number; now?: number } = {},
): LastLanded {
  const ref = opts.ref ?? 'origin/main';
  const limit = opts.limit ?? 3;
  const now = opts.now ?? Date.now();
  const res = runCmd(
    `git -C '${repo}' log '${ref}' -${limit} --format='%s%x09%ct' 2>/dev/null`,
  );
  if (res.timedOut) return { verified: false, reason: 'git timeout' };
  if (!res.ok) return { verified: false, reason: `git log failed on ${repo}` };
  const entries: LandedEntry[] = [];
  for (const line of res.out.split('\n')) {
    const tab = line.lastIndexOf('\t');
    if (tab < 0) continue;
    const subject = line.slice(0, tab).trim();
    const ct = line.slice(tab + 1).trim();
    if (!subject || !/^\d+$/.test(ct)) continue;
    entries.push({ subject, ageMs: Math.max(0, now - parseInt(ct, 10) * 1000) });
  }
  return { verified: true, entries };
}

// ── Summary assembly ─────────────────────────────────────────────────────────
export type MissionInput =
  | { present: false; reason: string }
  | {
      present: true;
      mission: { status: string; desc: string } | null;
      updatedAt?: number | null;
    };

export type OrchestratorProbe = {
  tmuxConfigured: boolean;
  // null = the probe itself failed → honest unknown, not dead.
  tmuxAlive: boolean | null;
  model: string | null;
};

export type StatusSummaryDeps = {
  orchestrator: OrchestratorProbe;
  heartbeat: HeartbeatReading;
  lanes: ActiveLanes;
  lastLanded: LastLanded;
  mission: MissionInput;
  now?: number;
};

const MAX_LANES_SHOWN = 4;
const MAX_LANDED_SHOWN = 3;

export function renderHumanStatus(deps: StatusSummaryDeps): string[] {
  const now = deps.now ?? Date.now();
  const lines: string[] = [];
  const blockers: string[] = [];

  // Оркестратор — only from live probes (tmux + heartbeat file age).
  const o = deps.orchestrator;
  const hb = deps.heartbeat;
  const modelSuffix = o.model ? UA.model(o.model) : UA.modelUnknown;
  if (!o.tmuxConfigured) {
    lines.push(`${UA.orchLabel}: ${UA.orchNoTmuxConfig}`);
    blockers.push(UA.blockerOrchUnknown);
  } else if (o.tmuxAlive === null) {
    lines.push(`${UA.orchLabel}: ${UA.orchTmuxProbeFailed}`);
    blockers.push(UA.blockerOrchUnknown);
  } else if (!o.tmuxAlive) {
    lines.push(`${UA.orchLabel}: ${UA.orchDead}`);
    blockers.push(UA.blockerOrchDead);
  } else if (hb.status === 'ok' && hb.ageMs <= HEARTBEAT_FRESH_MS) {
    lines.push(`${UA.orchLabel}: ${UA.orchAlive(uaAge(hb.ageMs))}${modelSuffix}`);
  } else if (hb.status === 'ok') {
    lines.push(`${UA.orchLabel}: ${UA.orchStaleHb(uaAge(hb.ageMs))}`);
    blockers.push(UA.blockerStaleHb(uaAge(hb.ageMs)));
  } else if (hb.status === 'absent') {
    lines.push(`${UA.orchLabel}: ${UA.orchNoHb}`);
    blockers.push(UA.blockerNoHb);
  } else {
    lines.push(`${UA.orchLabel}: ${UA.orchBadHb}`);
    blockers.push(UA.blockerNoHb);
  }

  // Місія — from the durable state DB, age-labeled when stale.
  if (!deps.mission.present) {
    lines.push(`${UA.missionLabel}: ${UA.missionUnknown(deps.mission.reason)}`);
  } else if (!deps.mission.mission) {
    lines.push(`${UA.missionLabel}: ${UA.missionNone}`);
  } else {
    const m = deps.mission.mission;
    const updatedAt = deps.mission.updatedAt;
    const ageMs = updatedAt == null ? null : Math.max(0, now - updatedAt);
    const stale =
      ageMs !== null && ageMs > HEARTBEAT_FRESH_MS ? UA.updated(uaAge(ageMs)) : '';
    lines.push(`${UA.missionLabel}: ${m.desc} [${m.status}]${stale}`);
  }

  // Зараз в роботі — lane worktree census (already timeout-guarded).
  if (!deps.lanes.verified) {
    lines.push(`${UA.workLabel}: ${UA.workUnknown(deps.lanes.reason)}`);
    blockers.push(UA.blockerGit(deps.lanes.reason));
  } else if (deps.lanes.count === 0) {
    lines.push(`${UA.workLabel}: ${UA.workNone}`);
  } else {
    const n = deps.lanes.count;
    lines.push(`${UA.workLabel}: ${n} ${uaPlural(n, 'лейн', 'лейни', 'лейнів')}:`);
    for (const lane of deps.lanes.lanes.slice(0, MAX_LANES_SHOWN)) {
      const state =
        lane.ahead > 0
          ? `${lane.ahead} ${uaPlural(lane.ahead, 'коміт', 'коміти', 'комітів')}`
          : lane.ahead === 0
            ? UA.laneNoCommits
            : UA.laneStateUnknown;
      lines.push(`  • ${lane.branch} — ${state}`);
    }
    if (deps.lanes.lanes.length > MAX_LANES_SHOWN) {
      lines.push(UA.laneMore(deps.lanes.lanes.length - MAX_LANES_SHOWN));
    }
  }

  // Останнє приземлене — subjects with relative dates.
  if (!deps.lastLanded.verified) {
    lines.push(`${UA.landedLabel}: ${UA.landedUnknown(deps.lastLanded.reason)}`);
    if (deps.lanes.verified) {
      // git failed only here; still a real observability blocker.
      blockers.push(UA.blockerGit(deps.lastLanded.reason));
    }
  } else if (deps.lastLanded.entries.length === 0) {
    lines.push(`${UA.landedLabel}: ${UA.landedNone}`);
  } else {
    lines.push(`${UA.landedLabel}:`);
    for (const e of deps.lastLanded.entries.slice(0, MAX_LANDED_SHOWN)) {
      lines.push(`  • ${e.subject} (${uaAge(e.ageMs)})`);
    }
  }

  // Блокери — «немає» is itself an observation, printable only when every
  // probe above succeeded (any failed probe pushed a blocker already).
  lines.push(
    blockers.length === 0
      ? `${UA.blockersLabel}: ${UA.blockersNone}`
      : `${UA.blockersLabel}: ${blockers.join('; ')}`,
  );

  return lines;
}

// Convenience gatherer for the daemon: one call site, everything injected.
export function buildHumanStatus(args: {
  canonicalRepo: string;
  runCmd: ShRunner;
  heartbeatPath: string;
  orchestrator: OrchestratorProbe;
  mission: MissionInput;
  baseRef?: string;
  laneOpts?: { root?: string; branchPrefix?: string };
  now?: number;
}): string[] {
  const now = args.now ?? Date.now();
  const baseRef = args.baseRef ?? 'origin/main';
  return renderHumanStatus({
    orchestrator: args.orchestrator,
    heartbeat: readHeartbeatFile(args.heartbeatPath, now),
    lanes: countActiveLanes(args.canonicalRepo, args.runCmd, {
      ...args.laneOpts,
      baseRef,
    }),
    lastLanded: readLastLanded(args.canonicalRepo, args.runCmd, {
      ref: baseRef,
      now,
    }),
    mission: args.mission,
    now,
  });
}
