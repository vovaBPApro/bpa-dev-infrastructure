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
//     text, branch names, model label) crosses one redacting sanitizer:
//     paths, assignments and token-shaped values are visibly replaced before
//     control/charset filtering and length-capping.
//   - the production builder returns one already-prefixed, total-capped
//     Telegram message; callers do not join or prefix renderer output.
//
// All shell access goes through the injected ShRunner, which the caller
// (daemon/server.ts) builds with a hard timeout — the W-13 git-timeout
// pattern. This module never spawns anything on its own.

import { readFileSync } from 'node:fs';
import { ageFromObservedTimestamp } from './observed-time';
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
  missionTimeInvalid: 'невідомо (час оновлення місії невалідний)',
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
  blockersPresentTruncated: 'є (деталі скорочено)',
  summaryTruncated: '… (частину деталей приховано)',
  blockerOrchDead: 'оркестратор не запущений',
  blockerOrchUnknown: 'стан оркестратора невідомий',
  blockerStaleHb: (hb: string) => `серцебиття оркестратора застаріле (${hb})`,
  blockerNoHb: 'серцебиття оркестратора відсутнє',
  blockerBadHb: 'серцебиття оркестратора невалідне',
  blockerMissionUnknown: 'стан місії невідомий (джерело недоступне)',
  blockerMissionTimeInvalid: 'стан місії невідомий (час оновлення невалідний)',
  blockerLanesUnknown: 'стан лейнів невідомий (git-перевірка не вдалася)',
  blockerLaneAheadUnknown: 'стан частини лейнів невідомий',
  blockerLandedUnknown: 'останні приземлені невідомі (git-перевірка не вдалася)',
  justNow: 'щойно',
  minAgo: (n: number) => `${n} хв тому`,
  hourAgo: (n: number) => `${n} год тому`,
  dayAgo: (n: number) => `${n} дн тому`,
  updated: (age: string) => ` (оновлено ${age})`,
};

// Ukrainian relative age for humans. Coarse on purpose. This formats an age
// that an observation parser already validated; it never accepts or subtracts
// an absolute timestamp. The defensive clamp therefore cannot hide a future
// clock reading.
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
// labels) is rendered into a chat message a human reads. Every such value
// crosses this one boundary. Redaction precedes truncation so no partial secret
// can be left at the length boundary. It is repeated after character filtering
// so a transformation cannot accidentally re-form a sensitive value.
//
// Failure REASONS are never passed through here — they simply are not rendered
// in the human summary at all.
export const MAX_HUMAN_TEXT = 96;

const REDACTED = '<redacted>';
const PATH_REDACTED = '<path redacted>';

function redactSensitiveText(input: string): string {
  return input
    // URLs with embedded credentials are sensitive as a whole.
    .replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi, REDACTED)
    // All conventional environment assignments, plus case-insensitive
    // credential-looking key/value pairs.
    .replace(
      /\b[A-Z_][A-Z0-9_]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g,
      REDACTED,
    )
    .replace(
      /\b(?:token|secret|password|passwd|pass|credential|key|api|auth|bearer|session|cookie|private)(?:[-_][A-Za-z0-9]+)*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      REDACTED,
    )
    // Absolute paths require multiple segments, deliberately preserving the
    // ordinary command name `/status`. Home-relative and Windows paths are
    // handled separately.
    .replace(
      /(^|[\s("'=:\[])\/(?:[A-Za-z0-9._~-]+\/)+[A-Za-z0-9._~-]+/g,
      `$1${PATH_REDACTED}`,
    )
    .replace(
      /(^|[\s("'=:\[])~\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+/g,
      `$1${PATH_REDACTED}`,
    )
    .replace(
      /(^|[\s("'=:\[])[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]+/g,
      `$1${PATH_REDACTED}`,
    )
    // Known vendor token prefixes. Character classes keep synthetic token
    // signatures out of the repository while exercising the same runtime
    // values.
    .replace(
      /\b(?:gh[pousr]_|github[_]pat_)[A-Za-z0-9_]{10,}\b/g,
      REDACTED,
    )
    .replace(
      /\b(?:sk-|xox[abprs]-|hf_|glpat-|npm_|dop_v1_)[A-Za-z0-9._-]{12,}\b/g,
      REDACTED,
    )
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED)
    .replace(/\bSG\.[A-Za-z0-9._-]{16,}\b/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, REDACTED)
    // JWTs and mixed-case-plus-digit opaque runs are credential-shaped even
    // without a known vendor prefix.
    .replace(
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      REDACTED,
    )
    .replace(
      /\b(?=[A-Za-z0-9]{24,}\b)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]+\b/g,
      REDACTED,
    );
}

export function sanitizeForHuman(input: string, maxLen = MAX_HUMAN_TEXT): string {
  const controlsRemoved = input
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
      ' ',
    );
  const cleaned = redactSensitiveText(controlsRemoved)
    .replace(
      /[^\p{Script=Latin}\p{Script=Cyrillic}\p{Nd} .,:;!?'()<>\[\]\/+#%&*_@=«»’“”—–-]/gu,
      '?',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const redacted = redactSensitiveText(cleaned);
  return redacted.length > maxLen
    ? `${redacted.slice(0, maxLen - 1)}…`
    : redacted;
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
  const age = ageFromObservedTimestamp(seconds * 1000, now);
  if (!age.ok) return { status: 'invalid' };
  return { status: 'ok', ageMs: age.ageMs };
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
    const age = ageFromObservedTimestamp(commitMs, now);
    if (!age.ok) {
      return {
        verified: false,
        reason:
          age.reason === 'future'
            ? 'commit timestamp in the future'
            : 'commit timestamp malformed',
      };
    }
    entries.push({ subject, ageMs: age.ageMs });
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

export const HUMAN_STATUS_PREFIX = '📊 ';
// Includes the prefix and truncation marker. 900 is intentionally far below
// Telegram's 4096-code-unit single-message limit and exercises the cap even
// when every currently rendered field reaches its individual maximum.
export const MAX_HUMAN_STATUS_LENGTH = 900;

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
    const age =
      updatedAt == null
        ? ({ ok: false, reason: 'non-finite' } as const)
        : ageFromObservedTimestamp(updatedAt, now);
    if (!age.ok) {
      lines.push(`${UA.missionLabel}: ${UA.missionTimeInvalid}`);
      blockers.push(UA.blockerMissionTimeInvalid);
    } else {
      const stale =
        age.ageMs > HEARTBEAT_FRESH_MS
          ? UA.updated(uaAge(age.ageMs))
          : '';
      lines.push(
        `${UA.missionLabel}: ${sanitizeForHuman(m.desc)} [${sanitizeForHuman(m.status, 24)}]${stale}`,
      );
    }
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

type CappedLine = {
  text: string;
  kind: 'fixed' | 'lane-detail' | 'landed-detail';
};

function prefixedStatusLength(lines: CappedLine[]): number {
  return `${HUMAN_STATUS_PREFIX}${lines.map((line) => line.text).join('\n')}`
    .length;
}

// Final human /status boundary. The blocker line is always kept last. When the
// total cap is exceeded, extra lane details go first, then extra landed commit
// details, then remaining list details, then the longest remaining field text.
// The visible truncation marker is inserted immediately before blockers. If
// even that cannot fit, the blocker line is replaced with a truthful fixed
// "blockers exist" form rather than being dropped or softened.
export function renderHumanStatusMessage(deps: StatusSummaryDeps): string {
  const rendered = renderHumanStatus(deps);
  const blockerText = rendered.at(-1) ?? `${UA.blockersLabel}: ${UA.blockerOrchUnknown}`;
  const content = rendered.slice(0, -1);
  const landedHeader = content.findIndex((line) =>
    line.startsWith(`${UA.landedLabel}:`),
  );
  const workHeader = content.findIndex((line) =>
    line.startsWith(`${UA.workLabel}:`),
  );
  const lines: CappedLine[] = content.map((text, index) => ({
    text,
    kind:
      workHeader >= 0 &&
      index > workHeader &&
      (landedHeader < 0 || index < landedHeader)
        ? 'lane-detail'
        : landedHeader >= 0 && index > landedHeader
          ? 'landed-detail'
          : 'fixed',
  }));
  lines.push({ text: blockerText, kind: 'fixed' });
  if (prefixedStatusLength(lines) <= MAX_HUMAN_STATUS_LENGTH) {
    return `${HUMAN_STATUS_PREFIX}${lines.map((line) => line.text).join('\n')}`;
  }

  lines.splice(lines.length - 1, 0, {
    text: UA.summaryTruncated,
    kind: 'fixed',
  });
  const fits = () => prefixedStatusLength(lines) <= MAX_HUMAN_STATUS_LENGTH;
  const dropFromEnd = (
    kind: CappedLine['kind'],
    minimumRemaining: number,
  ): void => {
    while (!fits()) {
      const matching = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.kind === kind);
      if (matching.length <= minimumRemaining) return;
      lines.splice(matching.at(-1)!.index, 1);
    }
  };

  dropFromEnd('lane-detail', 1);
  dropFromEnd('landed-detail', 1);
  dropFromEnd('lane-detail', 0);
  dropFromEnd('landed-detail', 0);

  while (!fits()) {
    const candidates = lines
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line, index }) =>
          index < lines.length - 2 &&
          line.kind === 'fixed' &&
          line.text.length > 24,
      )
      .sort((a, b) => b.line.text.length - a.line.text.length);
    const candidate = candidates[0];
    if (!candidate) break;
    const excess = prefixedStatusLength(lines) - MAX_HUMAN_STATUS_LENGTH;
    const nextLength = Math.max(24, candidate.line.text.length - excess);
    candidate.line.text = `${candidate.line.text
      .slice(0, nextLength - 1)
      .trimEnd()}…`;
  }

  if (!fits()) {
    const blockerIndex = lines.length - 1;
    const blockersExist =
      lines[blockerIndex].text !== `${UA.blockersLabel}: ${UA.blockersNone}`;
    lines.splice(
      0,
      lines.length,
      { text: UA.summaryTruncated, kind: 'fixed' },
      {
        text: blockersExist
          ? `${UA.blockersLabel}: ${UA.blockersPresentTruncated}`
          : `${UA.blockersLabel}: ${UA.blockersNone}`,
        kind: 'fixed',
      },
    );
  }

  return `${HUMAN_STATUS_PREFIX}${lines.map((line) => line.text).join('\n')}`;
}

// Convenience gatherer for the daemon: one final, prefixed, capped message.
export function buildHumanStatus(args: {
  canonicalRepo: string;
  runCmd: ShRunner;
  heartbeatPath: string;
  orchestrator: OrchestratorProbe;
  mission: MissionInput;
  baseRef?: string;
  laneOpts?: { root?: string; branchPrefix?: string };
  now?: number;
}): string {
  const now = args.now ?? Date.now();
  const baseRef = args.baseRef ?? 'origin/main';
  return renderHumanStatusMessage({
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
