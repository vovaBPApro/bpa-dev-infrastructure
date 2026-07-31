#!/usr/bin/env bun
// State-contract checker: every durable state artifact this repository touches
// must have a declared writer IN this repository.
//
// The bug class this exists for: a reader migrates into the repo and its writer
// does not. Each half looks healthy on its own — the reader parses fine, the
// writer's absence is invisible — and no test covers the seam, so the feature
// is dead on arrival. It killed the operator's dead-orchestrator alarm, which
// read its mission from `~/.claude/orchestrator-missions.json`, a file nothing
// in this repository ever wrote. Two independent inputs, both dead, for months.
//
// How it works:
//   1. Sweep every non-test source file for durable state-artifact names.
//   2. Every artifact found must appear in the registry below — an undeclared
//      artifact is a FAIL, so a new consumer cannot be added without stating
//      where the data comes from.
//   3. Every registry entry must have at least one writer, and every declared
//      reader/writer file must still reference the artifact. A writer that
//      stops writing (deleted, migrated to another host) turns red here.
//
// What it deliberately does not do: infer read-versus-write direction from the
// source. Proximity heuristics are wrong often enough to be worse than the
// declaration, and the declaration is still verified for existence and for
// continued reference, which is what catches a writer leaving.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ArtifactKind =
  // Runtime state this repository both owns and writes.
  | 'internal'
  // A file owned by another program. `owner` names it; this repo may read it.
  | 'external'
  // A file tracked in git. The repository itself is the writer, which the
  // checker verifies with `git ls-files`.
  | 'repo-file';

export type Artifact = {
  id: string;
  kind: ArtifactKind;
  readers: string[];
  writers: string[];
  owner?: string;
  trackedPath?: string;
  note: string;
};

// Artifacts that are READ here with no writer anywhere in this repository, i.e.
// live instances of the exact defect this checker exists to prevent.
//
// This list is CLOSED. It is asserted verbatim by
// tools/state-contract/check.test.ts, so a new broken contract cannot be
// parked here without that test failing — the only way in is a deliberate edit
// to both files, which is a review event. Entries must be removed as they are
// fixed; the checker fails on a stale entry whose artifact now has a writer.
export const KNOWN_GAPS: Record<string, string> = {
  'orchestrator-state.json':
    'Read by daemon/server.ts (/status plan, context, vendor quota, and the ' +
    'state_restore message) and daemon/status.ts. No writer migrated with the ' +
    'readers, so every one of those /status fields reports "n/a (no ' +
    'orchestrator-state.json)" forever. Same defect as orchestrator-missions.json, ' +
    'not fixed here: it needs an owner for what orchestrator state should now be ' +
    'derived from, which is a separate decision from the mission path.',
  'quota-latest.jsonl':
    'Read by daemon/vendor-login.ts, the restored vendor re-login detector. The ' +
    'writer was headless-Playwright vendor dashboard scraping, deliberately NOT ' +
    'migrated: it needs a logged-in browser profile, and the operator\'s standing ' +
    'rule is subscriptions-only with no API keys. Declared rather than hidden, and ' +
    'the reader is built for it — with no producer every verdict degrades to ' +
    '"unknown" with a reason, never to a confident "logged in". Closing it needs a ' +
    'credential decision about a browser profile, which is the Human\'s call.',
  'triage.jsonl':
    'Read by tools/instructions/ledger.ts (triage-verdict lookup for inbox aging) ' +
    'and tools/instructions/session-load.ts, written by nothing in this repository ' +
    '— triage verdicts are appended by hand during orchestrator triage. Surfaced ' +
    'by widening the sweep to .jsonl for quota-latest.jsonl; it was invisible ' +
    'before, not absent. Not fixed here because it belongs to the instructions ' +
    'ledger, not to this lane: it needs a triage-writing path or an explicit ' +
    'decision that hand-appended rows are the contract. THE MISSING WRITER IS A ' +
    'HUMAN — triage verdicts are appended by the orchestrator during triage, so ' +
    'unlike the missions ledger and orchestrator-state.json this is very likely ' +
    'hand-maintained BY DESIGN rather than a writer that failed to migrate. Do ' +
    'not spend an hour hunting for the lost writer; the open question is only ' +
    'whether hand-appending should stay the contract or be given a tool.',
};

export const REGISTRY: Artifact[] = [
  {
    id: 'state.db',
    kind: 'internal',
    writers: ['core/mission-cli.ts'],
    readers: [
      'bootstrap/install.sh',
      'daemon/mission-source.ts',
      'orchestrator/launch.sh',
      'orchestrator/morning.sh',
      'orchestrator/status.sh',
      'orchestrator/watchdog.sh',
      'tools/instructions/session-load.ts',
    ],
    note:
      'Durable mission/lane/lease state. Sole mission writer in this repo, and ' +
      'therefore the daemon liveness watchdog\'s only mission source.',
  },
  {
    id: 'orchestrator.lease',
    kind: 'internal',
    writers: ['orchestrator/launch.sh', 'orchestrator/watchdog.sh'],
    readers: ['orchestrator/watchdog.sh'],
    note:
      'Singleton lease mirror. launch.sh publishes it at start; the watchdog ' +
      'both reads it (lease_state) and rewrites it on renew (write_lease_state, ' +
      'via a .orchestrator.lease.XXXXXX temp sibling).',
  },
  {
    id: 'orchestrator.heartbeat',
    kind: 'internal',
    writers: [
      'orchestrator/launch.sh',
      'orchestrator/orchestrator-turnend-relay.sh',
    ],
    readers: ['orchestrator/watchdog.sh'],
    note: 'Turn-end liveness signal. A forged write here hides a dead session.',
  },
  {
    id: 'inbox.jsonl',
    kind: 'internal',
    writers: ['daemon/inbox-mirror.ts', 'tools/instructions/memory-sweep.ts'],
    readers: ['tools/instructions/ledger.ts', 'tools/instructions/session-load.ts'],
    note:
      'Append-only capture of inbound Human directives (the B276 fix) plus filed ' +
      'memory-sweep defects. Contract is closed: the daemon writes it, the ' +
      'instructions ledger ages it.',
  },
  {
    id: 'orchestrator.liveness',
    kind: 'internal',
    writers: [
      'orchestrator/launch.sh',
      'orchestrator/orchestrator-liveness-pulse.sh',
    ],
    readers: ['orchestrator/watchdog.sh'],
    note:
      'Positive in-turn liveness stamp. launch.sh seeds it at start; the ' +
      'in-pane pulse loop re-stamps it while the provider PID exists and ' +
      'stops when it dies. The watchdog kills on a stale heartbeat ONLY when ' +
      'this stamp is present AND stale AND the provider recorded in the ' +
      'VAR.identity sidecar is verifiably gone; fresh means alive, absent ' +
      'means ambiguity (alert, never kill). A forged writer here would hide ' +
      'a dead session exactly like a forged heartbeat.',
  },
  {
    // Entirely-derived basename, same normalization as VAR.lock below: every
    // reference is spelled `"$LIVENESS_FILE.identity"` (never a second knob),
    // so the sweep sees `VAR.identity`.
    id: 'VAR.identity',
    kind: 'internal',
    writers: [
      'orchestrator/launch.sh',
      'orchestrator/orchestrator-liveness-pulse.sh',
    ],
    readers: ['orchestrator/watchdog.sh'],
    note:
      'Provider-identity sidecar of orchestrator.liveness: pid= plus the ' +
      'reuse-safe starttime= (/proc/<pid>/stat field 22) of the provider the ' +
      'stamp vouches for, written by launch.sh at start and by the pulse ' +
      'loop at its startup. The stale-pulse kill fires ONLY when this ' +
      'identity is verifiably gone (pid absent, or occupied by a different ' +
      'starttime); a live match means the pulse helper died alone — degraded ' +
      'liveness, alert-only; unrecorded or unverifiable is ambiguity, never ' +
      'a kill.',
  },
  {
    id: 'orchestrator.singleton.lock',
    kind: 'internal',
    writers: ['orchestrator/launch.sh'],
    readers: ['orchestrator/launch.sh'],
    note: 'Launch-time singleton guard.',
  },
  {
    id: 'launch.lock',
    kind: 'internal',
    writers: ['orchestrator/launch.sh'],
    readers: ['orchestrator/launch.sh'],
    note: 'Serializes concurrent launch.sh invocations.',
  },
  {
    id: 'orchestrator-chat-VAR.lock',
    kind: 'internal',
    writers: ['orchestrator/launch.sh'],
    readers: ['daemon/server.ts', 'orchestrator/launch.sh'],
    note:
      'Per-chat instance lock. The daemon reads it for /status; launch.sh ' +
      'writes and removes it.',
  },
  {
    id: 'orchestrator-binding.json',
    kind: 'internal',
    writers: ['daemon/server.ts'],
    readers: ['daemon/server.ts'],
    note: 'Which provider/session/chat the daemon is bound to.',
  },
  {
    id: 'turn-deliveries.json',
    kind: 'internal',
    writers: ['daemon/server.ts'],
    readers: ['daemon/server.ts'],
    note: 'Turn-end delivery ledger for relay dedupe.',
  },
  {
    id: 'access.json',
    kind: 'internal',
    writers: ['daemon/server.ts'],
    readers: ['daemon/server.ts'],
    note: 'Telegram allowlist.',
  },
  {
    id: 'daemon.pid',
    kind: 'internal',
    writers: ['daemon/server.ts'],
    readers: [],
    note: 'Daemon pid file, for operators and for the systemd unit.',
  },
  {
    id: 'orchestrator-done',
    kind: 'internal',
    writers: ['daemon/server.ts'],
    readers: [],
    note:
      'Completion flag written and cleared by the daemon. Currently write-only ' +
      'in this repo — the mirror image of the defect this checker locks. The ' +
      'reader-needs-a-writer rule below does not catch it; enabling the reverse ' +
      'direction is the natural next step once its consumer lands.',
  },
  {
    id: 'nudges.outbox',
    kind: 'internal',
    writers: ['orchestrator/full-suite.sh', 'orchestrator/watchdog.sh'],
    readers: ['daemon/server.ts', 'orchestrator/status.sh'],
    note: 'Mission-pressure nudges drained by the daemon.',
  },
  {
    // A basename that is entirely interpolated normalizes to `VAR.<ext>`; this
    // one is `${NUDGE_OUTBOX_FILE}.lock`, the flock guard both atomic writers
    // of the nudge outbox take.
    id: 'VAR.lock',
    kind: 'internal',
    writers: ['orchestrator/full-suite.sh', 'orchestrator/watchdog.sh'],
    readers: ['orchestrator/full-suite.sh', 'orchestrator/watchdog.sh'],
    note: 'flock guard serializing writes to nudges.outbox.',
  },
  {
    id: 'morning.outbox',
    kind: 'internal',
    writers: ['orchestrator/morning.sh'],
    readers: ['daemon/server.ts'],
    note: 'Morning readiness digest drained by the daemon.',
  },
  {
    id: 'morning.watermark',
    kind: 'internal',
    writers: ['orchestrator/morning.sh'],
    readers: ['orchestrator/morning.sh'],
    note: 'Once-per-day guard for the morning digest.',
  },
  {
    id: 'nudge-rate.tsv',
    kind: 'internal',
    writers: ['orchestrator/watchdog.sh'],
    readers: ['orchestrator/watchdog.sh'],
    note: 'Nudge rate limiter.',
  },
  {
    id: 'full-suite-nudge-rate.tsv',
    kind: 'internal',
    writers: ['orchestrator/full-suite.sh'],
    readers: ['orchestrator/full-suite.sh'],
    note: 'Full-suite nudge rate limiter.',
  },
  {
    id: 'claude-mcp-config.json',
    kind: 'internal',
    writers: ['orchestrator/launch.sh'],
    readers: [],
    note: 'Generated per launch and handed to the provider via --mcp-config.',
  },
  {
    id: 'claude-relay-settings.json',
    kind: 'internal',
    writers: ['orchestrator/launch.sh'],
    readers: [],
    note: 'Generated per launch; carries the Stop-hook relay settings.',
  },
  {
    id: 'bpa-land.lock',
    kind: 'internal',
    writers: ['gate/land-batch.sh', 'gate/land.sh'],
    readers: ['gate/land-batch.sh', 'gate/land.sh'],
    note: 'Serializes landings against one git dir.',
  },
  {
    id: 'manifest.json',
    kind: 'internal',
    writers: ['tools/instructions/compose.ts'],
    readers: [],
    note: 'Composed instruction-context manifest.',
  },
  {
    id: 'L1_PIN.json',
    kind: 'internal',
    writers: ['tools/instructions/scaffold.ts'],
    readers: ['tools/instructions/scaffold.ts'],
    note: 'Scaffolded L1 pin for a downstream repo.',
  },
  {
    id: '.claude.json',
    kind: 'external',
    owner: 'Claude Code CLI',
    writers: [],
    readers: ['orchestrator/launch.sh'],
    note:
      'Claude Code\'s own config. launch.sh reads it to prove the work dir is ' +
      'trusted before starting a pane nobody can answer a trust prompt in.',
  },
  {
    id: 'auth.json',
    kind: 'external',
    owner: 'Codex CLI',
    writers: [],
    readers: ['orchestrator/preflight-cli-auth.sh'],
    note:
      'Codex CLI\'s credential file (~/.codex/auth.json), written by `codex ' +
      'login`. The auth preflight only READS it: it refuses launch when an ' +
      'OPENAI_API_KEY is embedded there (metered billing) and also requires ' +
      'affirmative ChatGPT login tokens — missing or unverifiable is a ' +
      'refusal, never a pass. This repo must never write it.',
  },
  {
    id: '.credentials.json',
    kind: 'external',
    owner: 'Claude Code CLI',
    writers: [],
    readers: ['orchestrator/preflight-cli-auth.sh'],
    note:
      'Claude Code\'s credential file (~/.claude/.credentials.json), written ' +
      'by the CLI\'s /login. The auth preflight only READS it, structurally, ' +
      'for affirmative subscription OAuth evidence (claudeAiOauth.accessToken); ' +
      'missing or unverifiable is a refusal. This repo must never write it, ' +
      'and nothing from it may ever be printed.',
  },
  {
    id: 'package.json',
    kind: 'repo-file',
    trackedPath: 'daemon/package.json',
    writers: [],
    readers: ['stand/run-acceptance.sh'],
    note: 'Tracked repository file, not runtime state.',
  },
];

// Basenames carrying these extensions are durable state by convention, plus the
// extensionless `orchestrator-*` runtime flags.
// `jsonl` must be listed separately even though `json` is here: the alternation
// is anchored by (?![A-Za-z0-9]), so `quota-latest.jsonl` matched neither arm
// and append-only ledgers were invisible to the sweep entirely. That blind spot
// hid three durable artifacts — inbox.jsonl, triage.jsonl and quota-latest.jsonl
// — one of which (triage.jsonl) is a live instance of the very defect this
// checker exists to catch.
const EXT =
  'jsonl|json|db|lock|lease|heartbeat|liveness|identity|outbox|watermark|tsv|pid';
const WITH_EXT = new RegExp(
  `['"\`/](\\.?[A-Za-z0-9_.-]+\\.(?:${EXT}))(?![A-Za-z0-9])`,
  'g',
);
const EXTENSIONLESS = /['"`](orchestrator-[a-z0-9-]+)['"`]/g;

const SKIP_DIRS = [
  // Frozen reference copies of the pre-migration system.
  'migration-prep/',
  // Fixture generators: they mint throwaway state directories by design.
  'soak/',
  // The registry itself names every artifact by construction.
  'tools/state-contract/',
];

function isTest(path: string): boolean {
  return /\.test\.(ts|sh)$/.test(path) || path.endsWith('.test.js');
}

// Comments are not accesses. Without this a comment explaining a retired file
// would keep that file alive in the sweep forever.
//
// Comment syntax is per-language on purpose: `/*` opens a block comment in
// TypeScript but is a perfectly ordinary case pattern in shell
// (`/*) lock_file="$git_dir/bpa-land.lock" ;;`), and treating it as a comment
// there silently hid a real artifact.
export function stripComments(source: string, path: string): string {
  const shell = path.endsWith('.sh');
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      if (shell) return !t.startsWith('#');
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

// Interpolation is collapsed so an interpolated path is still one stable id:
// `orchestrator-chat-${chatId}.lock` and `orchestrator-chat-$CHAT_ID.lock` both
// become `orchestrator-chat-VAR.lock`.
//
// The shell `${NAME:-default}` form has its prefix removed rather than
// collapsed, because the default IS the path — `${ORCH_LEASE_FILE:-$RUNTIME_DIR/
// orchestrator.lease}` must surface `orchestrator.lease`, not `VAR`.
export function normalizeInterpolation(source: string): string {
  return source
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:[-=]?/g, '')
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'VAR')
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, 'VAR');
}

// An atomic write stages into a hidden sibling and renames over the target:
//
//   tmp="$(mktemp "$(dirname "$LEASE_FILE")/.orchestrator.lease.XXXXXX")"
//   ... > "$tmp"; mv -f "$tmp" "$LEASE_FILE"
//
// The staging path is created, written and renamed away inside one function. It
// is never read, never durable, and never outlives the call — it is part of how
// the parent artifact is written, not a second artifact. Left alone, the sweep
// reports it as an undeclared `.orchestrator.lease`, and the error message's
// advice (declare it, name its writer) would put a transient in the registry
// asserting a reader/writer contract that does not exist — blunting the one
// tool this repository has against the reader-with-no-writer defect.
//
// So a temp sibling is rewritten to the artifact it stages for, and the parent
// still has to be declared. This is deliberately keyed on the mktemp template
// (three or more trailing X, dot-prefixed, sibling of the parent) rather than
// on the leading dot: `'.claude.json'` or a genuinely new `.ledger.json` has no
// X-template and is still swept, still undeclared, still a FAIL. Widening this
// to "ignore dot-prefixed names" would be an escape hatch, not a fix.
const ATOMIC_TEMP_SIBLING = /\/\.([A-Za-z0-9_.-]+)\.X{3,}(?![A-Za-z0-9])/g;

export function collapseAtomicTempSiblings(source: string): string {
  return source.replace(ATOMIC_TEMP_SIBLING, '/$1');
}

export function sweepArtifacts(
  root: string,
  files: string[],
): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const rel of files) {
    if (SKIP_DIRS.some((d) => rel.startsWith(d))) continue;
    if (isTest(rel)) continue;
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const source = collapseAtomicTempSiblings(
      normalizeInterpolation(stripComments(readFileSync(abs, 'utf8'), rel)),
    );
    for (const re of [WITH_EXT, EXTENSIONLESS]) {
      re.lastIndex = 0;
      for (const m of source.matchAll(re)) {
        const id = m[1];
        if (!found.has(id)) found.set(id, new Set());
        found.get(id)!.add(rel);
      }
    }
  }
  return found;
}

export type Finding = { level: 'FAIL' | 'GAP'; id: string; detail: string };

export type RunningLaneState =
  | { running: number; reason?: never }
  | { running: null; reason: string };

export type OrchestratorHostState =
  | { applicable: true }
  | { applicable: false; reason: string };

// FLEET-IDLE has a subject only while this machine is actively hosting the
// orchestrator. The named tmux session is runtime evidence created and probed
// by orchestrator/launch.sh; checkout location and CI environment variables are
// not evidence about host role.
export function queryOrchestratorHost(root: string): OrchestratorHostState {
  let session = 'orchestrator';
  try {
    const configured = readFileSync(join(root, 'bootstrap/env.template'), 'utf8')
      .match(/^ORCH_SESSION=([^\s#]+)$/m)?.[1];
    if (configured) session = configured;
  } catch {
    // launch.sh's portable default remains authoritative without a template.
  }
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(['tmux', 'has-session', '-t', session], {
      env: process.env,
    });
  } catch {
    return {
      applicable: false,
      reason: `live ${session} tmux session is not observable (tmux unavailable)`,
    };
  }
  if (proc.exitCode !== 0) {
    return {
      applicable: false,
      reason: `live ${session} tmux session does not exist`,
    };
  }
  return { applicable: true };
}

export function countOpenWorkboardRows(source: string): number {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^## Open(?:\s|$)/.test(line));
  if (start < 0) {
    throw new Error('instance/workboard.md has no ## Open section');
  }
  const nextSection = lines.findIndex(
    (line, index) => index > start && /^##(?:\s|$)/.test(line),
  );
  return lines
    .slice(start + 1, nextSection < 0 ? undefined : nextSection)
    .filter(
      (line) =>
        /^- \*\*/.test(line) &&
        !/^- \*\*[^*]*\bCLOSED\b/.test(line),
    ).length;
}

export function checkFleetIdle(
  workboardSource: string,
  lanes: RunningLaneState,
): Finding | undefined {
  let openRows: number;
  try {
    openRows = countOpenWorkboardRows(workboardSource);
  } catch (error) {
    return {
      level: 'FAIL',
      id: 'FLEET-IDLE',
      detail:
        'open workboard row count unknown/degraded: ' +
        (error instanceof Error ? error.message : String(error)),
    };
  }

  if (lanes.running === null) {
    return {
      level: 'FAIL',
      id: 'FLEET-IDLE',
      detail:
        `${openRows} open workboard row(s), running lane unit(s) ` +
        `unknown/degraded: ${lanes.reason}`,
    };
  }
  if (openRows > 0 && lanes.running === 0) {
    return {
      level: 'FAIL',
      id: 'FLEET-IDLE',
      detail:
        `${openRows} open workboard row(s), ` +
        `${lanes.running} running lane unit(s)`,
    };
  }
  return undefined;
}

export function queryRunningSystemLanes(): RunningLaneState {
  const command = [
    'systemctl',
    'list-units',
    'lane-*.service',
    '--type=service',
    '--state=running',
    '--no-legend',
    '--no-pager',
    '--plain',
  ];
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync(command);
  } catch (error) {
    return {
      running: null,
      reason:
        `could not execute system systemctl: ` +
        (error instanceof Error ? error.message : String(error)),
    };
  }
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  if (proc.exitCode !== 0) {
    return {
      running: null,
      reason:
        `system systemctl exited ${proc.exitCode}` +
        (stderr ? `: ${stderr}` : ''),
    };
  }

  const output = new TextDecoder().decode(proc.stdout);
  const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const unexpected = lines.find(
    (line) => !/^lane-[^\s]+\.service(?:\s|$)/.test(line),
  );
  if (unexpected) {
    return {
      running: null,
      reason: `unexpected systemctl output: ${unexpected}`,
    };
  }
  return { running: lines.length };
}

export function checkStateContract(
  root: string,
  files: string[],
  registry: Artifact[],
  knownGaps: Record<string, string>,
  isTracked: (path: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  const found = sweepArtifacts(root, files);
  const byId = new Map(registry.map((a) => [a.id, a]));

  if (registry.length !== byId.size) {
    findings.push({
      level: 'FAIL',
      id: '(registry)',
      detail: 'duplicate artifact ids in the registry',
    });
  }

  // 1. Nothing undeclared. A new consumer must say where its data comes from.
  for (const [id, refs] of found) {
    if (byId.has(id) || knownGaps[id]) continue;
    findings.push({
      level: 'FAIL',
      id,
      detail:
        `undeclared durable state artifact, referenced by ${[...refs].sort().join(', ')} — ` +
        'add it to tools/state-contract/check.ts REGISTRY and name its writer',
    });
  }

  // 2. Every declared artifact must still be referenced, or the entry is dead.
  for (const artifact of registry) {
    const refs = found.get(artifact.id);
    if (!refs) {
      findings.push({
        level: 'FAIL',
        id: artifact.id,
        detail: 'declared in the registry but referenced by no source file',
      });
      continue;
    }
    for (const file of [...artifact.readers, ...artifact.writers]) {
      if (!refs.has(file)) {
        findings.push({
          level: 'FAIL',
          id: artifact.id,
          detail:
            `declared reader/writer ${file} no longer references it — either the ` +
            'access moved out of this repo (the defect this checker locks) or the ' +
            'registry is stale',
        });
      }
    }
    for (const file of refs) {
      if (artifact.readers.includes(file) || artifact.writers.includes(file)) {
        continue;
      }
      findings.push({
        level: 'FAIL',
        id: artifact.id,
        detail: `${file} references it but is declared neither reader nor writer`,
      });
    }

    // 3. The rule itself: something in this repo must write what it reads.
    if (artifact.kind === 'internal' && artifact.writers.length === 0) {
      findings.push({
        level: 'FAIL',
        id: artifact.id,
        detail:
          'read by this repository but written by nothing in it — the reader ' +
          'migrated and the writer did not',
      });
    }
    if (artifact.kind === 'external' && !artifact.owner) {
      findings.push({
        level: 'FAIL',
        id: artifact.id,
        detail: 'external artifacts must name the program that owns them',
      });
    }
    if (artifact.kind === 'external' && artifact.writers.length > 0) {
      findings.push({
        level: 'FAIL',
        id: artifact.id,
        detail:
          'declared external yet written here — reclassify it as internal',
      });
    }
    if (artifact.kind === 'repo-file') {
      if (!artifact.trackedPath) {
        findings.push({
          level: 'FAIL',
          id: artifact.id,
          detail: 'repo-file artifacts must name their tracked path',
        });
      } else if (!isTracked(artifact.trackedPath)) {
        findings.push({
          level: 'FAIL',
          id: artifact.id,
          detail: `${artifact.trackedPath} is not tracked in git, so it is not a repo file`,
        });
      }
    }
  }

  // 4. Known gaps are reported every run, and must not go stale.
  for (const [id, reason] of Object.entries(knownGaps)) {
    if (byId.has(id)) {
      findings.push({
        level: 'FAIL',
        id,
        detail:
          'listed as a known gap and also declared in the registry — remove ' +
          'the gap entry now that the contract is closed',
      });
      continue;
    }
    if (!found.has(id)) {
      findings.push({
        level: 'FAIL',
        id,
        detail:
          'listed as a known gap but referenced by nothing — the reader is ' +
          'gone, so delete the entry',
      });
      continue;
    }
    findings.push({ level: 'GAP', id, detail: reason });
  }

  return findings;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const proc = Bun.spawnSync(['git', '-C', root, 'ls-files', '*.ts', '*.sh']);
  const files = new TextDecoder().decode(proc.stdout).split('\n').filter(Boolean);
  const trackedProc = Bun.spawnSync(['git', '-C', root, 'ls-files']);
  const tracked = new Set(
    new TextDecoder().decode(trackedProc.stdout).split('\n').filter(Boolean),
  );
  const findings = checkStateContract(
    root,
    files,
    REGISTRY,
    KNOWN_GAPS,
    (p) => tracked.has(p),
  );
  const orchestratorHost = queryOrchestratorHost(root);
  if (!orchestratorHost.applicable) {
    console.log(`NOT-APPLICABLE FLEET-IDLE: ${orchestratorHost.reason}`);
  } else {
    let workboardSource: string | undefined;
    try {
      workboardSource = readFileSync(join(root, 'instance/workboard.md'), 'utf8');
    } catch (error) {
      findings.push({
        level: 'FAIL',
        id: 'FLEET-IDLE',
        detail:
          'open workboard row count unknown/degraded: cannot read ' +
          `instance/workboard.md: ` +
          (error instanceof Error ? error.message : String(error)),
      });
    }
    if (workboardSource !== undefined) {
      const fleetFinding = checkFleetIdle(
        workboardSource,
        queryRunningSystemLanes(),
      );
      if (fleetFinding) findings.push(fleetFinding);
    }
  }
  const fails = findings.filter((f) => f.level === 'FAIL');
  for (const f of findings) {
    console.log(`${f.level} ${f.id}: ${f.detail}`);
  }
  console.log(
    `\n${REGISTRY.length} artifacts declared, ${fails.length} FAIL, ` +
      `${findings.length - fails.length} known gap(s)`,
  );
  process.exit(fails.length === 0 ? 0 : 1);
}
