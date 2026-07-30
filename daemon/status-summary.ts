// Human-facing /status summary (HR-150).
//
// Vova's verbatim complaint: «І доречі команда статус мені не дає жодноі
// корисноі інфо». The raw daemon JSON answers a machine's questions; this
// module answers his: what is being worked on, how many lanes and their
// states, what landed last, is anything blocked.
//
// HONESTY RULES (binding, from W-13 and Hard Rule 10):
//   - every source is optional; a missing/failed/empty/invalid source renders
//     as an honest «невідомо» AND appends an observability blocker — never a
//     crash, never an OK, never a silent skip;
//   - «Блокери: немає» therefore requires explicit verified evidence from
//     EVERY source above it; absence of evidence can never render as "all
//     good";
//   - any heartbeat or commit timestamp in the future is INVALID evidence
//     (broken clock), with no grace window and no clamping to "fresh";
//   - anything derived from a state file is labeled with its age when stale;
//   - a throwing runner degrades to «невідомо», it does not crash /status.
//
// LEAK RULES (human summary only; /status raw keeps full detail):
//   - source-derived failure reasons are NOT interpolated into the summary —
//     the UA template uses short generic reasons; the detail (paths, repo
//     locations, git stderr) stays in the raw view;
//   - source-derived free text that must be shown (commit subjects, mission
//     text, branch names, model label) is sanitized: control/ANSI/bidi chars
//     stripped, unexpected charsets replaced with '?', length-capped.
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
  // Generic on purpose: the source-derived reason (paths etc.) stays in raw.
  missionUnknown: 'невідомо (джерело місії недоступне)',
  workLabel: 'Зараз в роботі',
  workNone: 'лейнів немає',
  workUnknown: 'невідомо (немає перевірених даних git)',
  laneNoCommits: 'ще без комітів',
  laneStateUnknown: 'стан невідомий',
  laneMore: (n: number) => `  • … і ще ${n}`,
  landedLabel: 'Останнє приземлене',
  landedUnknown: 'невідомо (немає перевірених даних git)',
  blockersLabel: 'Блокери',
  blockersNone: 'немає',
  blockerOrchDead: 'оркестратор не запущений',
  blockerOrchUnknown: 'стан оркестратора невідомий',
  blockerStaleHb: (hb: string) => `серцебиття оркестратора застаріле (${hb})`,
  blockerNoHb: 'серцебиття оркестратора відсутнє',
  blockerBadHb: 'серцебиття оркестратора невалідне',
  blockerMissionUnknown: 'стан місії невідомий (джерело недоступне)',
  blockerLanesUnknown: 'стан лейнів невідомий (git-перевірка не вдалася)',
  blockerLaneAheadUnknown: 'стан частини лейнів невідомий',
  blockerLandedUnknown: 'останні приземлені невідомі (git-перевірка не вдалася)',
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

// ── Sanitization ─────────────────────────────────────────────────────────────
// Source-derived free text (commit subjects, mission text, branch names, model
// labels) is rendered into a chat message a human reads. Bound it: strip
// control chars (incl. ANSI ESC), C1, zero-width and bidi-override characters;
// replace anything outside the expected charset (Latin/Cyrillic letters,
// digits, common punctuation) with '?' so hostile payloads are visible but
// inert; collapse whitespace; cap the length. Failure REASONS are never passed
// through here — they simply are not rendered in the human summary at all.
export const MAX_HUMAN_TEXT = 96;

export function sanitizeForHuman(input: string, maxLen = MAX_HUMAN_TEXT): string {
  const cleaned = input
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
      ' ',
    )
    .replace(
      /[^\p{Script=Latin}\p{Script=Cyrillic}\p{Nd} .,:;!?'()\[\]\/+#%&*_@=«»’“”—–-]/gu,
      '?',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
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
  // ANY future value is a broken clock, not liveness evidence — no grace
  // window and no clamping to "fresh" (review finding, HR-150 fixup).
  const ageMs = now - seconds * 1000;
  if (ageMs < 0) return { status: 'invalid' };
  return { status: 'ok', ageMs };
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
  let res: ReturnType<ShRunner>;
  try {
    res = runCmd(
      `git -C '${repo}' log '${ref}' -${limit} --format='%s%x09%ct' 2>/dev/null`,
    );
  } catch {
    // A throwing runner is a failed probe, not a /status crash.
    return { verified: false, reason: 'git runner threw' };
  }
  if (res.timedOut) return { verified: false, reason: 'git timeout' };
  if (!res.ok) return { verified: false, reason: `git log failed on ${repo}` };
  // Fail-closed parsing (review finding, HR-150 fixup): a malformed row means
  // the probe did NOT verify history — no silent skipping. Empty output for an
  // existing ref is equally unverified: `git log` on a real ref always prints
  // at least one commit, so "nothing" is evidence of a broken probe, not of an
  // empty history.
  const entries: LandedEntry[] = [];
  for (const line of res.out.split('\n')) {
    if (line.trim() === '') continue; // trailing newline noise only
    const tab = line.lastIndexOf('\t');
    if (tab < 0) return { verified: false, reason: 'git log output malformed' };
    const subject = line.slice(0, tab).trim();
    const ct = line.slice(tab + 1).trim();
    if (!subject || !/^\d+$/.test(ct)) {
      return { verified: false, reason: 'git log output malformed' };
    }
    const commitMs = parseInt(ct, 10) * 1000;
    // ANY future commit timestamp is invalid evidence — no clamp to "just now".
    if (commitMs > now) {
      return { verified: false, reason: 'commit timestamp in the future' };
    }
    entries.push({ subject, ageMs: now - commitMs });
  }
  if (entries.length === 0) {
    return { verified: false, reason: 'git log returned no commits' };
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
  const modelSuffix = o.model
    ? UA.model(sanitizeForHuman(o.model, 40))
    : UA.modelUnknown;
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
    blockers.push(UA.blockerBadHb);
  }

  // Місія — from the durable state DB, age-labeled when stale. An absent or
  // unreadable mission source is an observability blocker, never a shrug; the
  // raw reason (which may contain paths) stays out of the human summary.
  if (!deps.mission.present) {
    lines.push(`${UA.missionLabel}: ${UA.missionUnknown}`);
    blockers.push(UA.blockerMissionUnknown);
  } else if (!deps.mission.mission) {
    lines.push(`${UA.missionLabel}: ${UA.missionNone}`);
  } else {
    const m = deps.mission.mission;
    const updatedAt = deps.mission.updatedAt;
    const ageMs = updatedAt == null ? null : Math.max(0, now - updatedAt);
    const stale =
      ageMs !== null && ageMs > HEARTBEAT_FRESH_MS ? UA.updated(uaAge(ageMs)) : '';
    lines.push(
      `${UA.missionLabel}: ${sanitizeForHuman(m.desc)} [${sanitizeForHuman(m.status, 24)}]${stale}`,
    );
  }

  // Зараз в роботі — lane worktree census (timeout- and throw-guarded at the
  // source). Unverified census AND unverified per-lane state both block.
  if (!deps.lanes.verified) {
    lines.push(`${UA.workLabel}: ${UA.workUnknown}`);
    blockers.push(UA.blockerLanesUnknown);
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
      lines.push(`  • ${sanitizeForHuman(lane.branch, 48)} — ${state}`);
    }
    if (deps.lanes.lanes.length > MAX_LANES_SHOWN) {
      lines.push(UA.laneMore(deps.lanes.lanes.length - MAX_LANES_SHOWN));
    }
    if (deps.lanes.lanes.some((l) => l.ahead < 0)) {
      blockers.push(UA.blockerLaneAheadUnknown);
    }
  }

  // Останнє приземлене — subjects with relative dates. `verified: true` with
  // zero entries carries no affirmative evidence either (readLastLanded never
  // produces it), so it renders as unknown and blocks — fail-closed.
  if (!deps.lastLanded.verified || deps.lastLanded.entries.length === 0) {
    lines.push(`${UA.landedLabel}: ${UA.landedUnknown}`);
    blockers.push(UA.blockerLandedUnknown);
  } else {
    lines.push(`${UA.landedLabel}:`);
    for (const e of deps.lastLanded.entries.slice(0, MAX_LANDED_SHOWN)) {
      lines.push(`  • ${sanitizeForHuman(e.subject, 80)} (${uaAge(e.ageMs)})`);
    }
  }

  // Блокери — «немає» is itself an observation, printable only when EVERY
  // probe above produced explicit verified evidence (any absent/failed/empty/
  // invalid source pushed a blocker already).
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
