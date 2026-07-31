// Does the state-contract checker actually catch the bug it was written for?
//
// Test 1 rebuilds the defect exactly as it shipped — a daemon reading
// `orchestrator-missions.json` that nothing writes — and requires a FAIL. If
// that assertion ever passes trivially the checker is decoration.

import { expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isolatedTestEnv } from '../../daemon/test-env';
import {
  type Artifact,
  KNOWN_GAPS,
  REGISTRY,
  checkStateContract,
  checkFleetIdle,
  collapseAtomicTempSiblings,
  normalizeInterpolation,
  stripComments,
  sweepArtifacts,
} from './check';

function fixture(files: Record<string, string>): {
  root: string;
  names: string[];
} {
  const root = mkdtempSync(join(tmpdir(), 'state-contract-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return { root, names: Object.keys(files) };
}

const trackedAlways = () => true;

test('FLEET-IDLE locks open work against the measured system lane fleet', () => {
  const openWorkboard = `# Workboard

## Open

- <!-- status: open --> **W-01 — first open row**: pending.
- <!-- status: done --> **W-02 — closed row**: landed at \`deadbee\`.
- <!-- status: open --> **W-03 — second open row**: pending.

## Parked

- <!-- status: blocked --> **P-01 — not active**: parked.
`;
  const emptyWorkboard = `# Workboard

## Open

- <!-- status: done --> **W-02 — closed row**: landed at \`deadbee\`.
`;

  expect(checkFleetIdle(openWorkboard, { running: 0 })).toEqual({
    level: 'FAIL',
    id: 'FLEET-IDLE',
    detail: '2 open workboard row(s), 0 running lane unit(s)',
  });
  expect(checkFleetIdle(openWorkboard, { running: 3 })).toBeUndefined();
  expect(checkFleetIdle(emptyWorkboard, { running: 0 })).toBeUndefined();
  expect(
    checkFleetIdle(openWorkboard, {
      running: null,
      reason: 'systemctl exited 1: system bus unavailable',
    }),
  ).toEqual({
    level: 'FAIL',
    id: 'FLEET-IDLE',
    detail:
      '2 open workboard row(s), running lane unit(s) unknown/degraded: ' +
      'systemctl exited 1: system bus unavailable',
  });
});

test('CLI reports FLEET-IDLE not applicable without positive orchestrator runtime evidence', () => {
  const ciPath = mkdtempSync(join(tmpdir(), 'state-contract-ci-path-'));
  try {
    symlinkSync(process.execPath, join(ciPath, 'bun'));
    symlinkSync('/usr/bin/git', join(ciPath, 'git'));
    const proc = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, 'check.ts'),
      join(import.meta.dir, '../..'),
    ], {
      env: isolatedTestEnv({ PATH: ciPath, HOME: tmpdir() }),
    });
    const output =
      new TextDecoder().decode(proc.stdout) +
      new TextDecoder().decode(proc.stderr);
    expect(proc.exitCode).toBe(0);
    expect(output).toContain(
      'NOT-APPLICABLE FLEET-IDLE: live bpa-orchestrator tmux session ' +
        'is not observable (tmux unavailable)',
    );
  } finally {
    rmSync(ciPath, { recursive: true, force: true });
  }
});

test('FLEET-IDLE fails closed when an applicable host workboard is empty', () => {
  expect(checkFleetIdle('', { running: 0 })).toEqual({
    level: 'FAIL',
    id: 'FLEET-IDLE',
    detail:
      'open workboard row count unknown/degraded: ' +
      'instance/workboard.md has no parseable rows',
  });
});

test('FLEET-IDLE rejects missing statuses and duplicate row ids', () => {
  expect(checkFleetIdle('- **W-01 — missing status**', { running: 0 })).toEqual({
    level: 'FAIL',
    id: 'FLEET-IDLE',
    detail: 'open workboard row count unknown/degraded: malformed workboard row at line 1',
  });
  expect(
    checkFleetIdle(
      '- <!-- status: open --> **W-01 — first**\n' +
        '- <!-- status: done --> **W-01 — duplicate**',
      { running: 0 },
    ),
  ).toEqual({
    level: 'FAIL',
    id: 'FLEET-IDLE',
    detail: 'open workboard row count unknown/degraded: duplicate workboard id: W-01',
  });
});

test('HISTORICAL: a reader whose writer never migrated is a FAIL', () => {
  const { root, names } = fixture({
    'daemon/server.ts': `
const MISSIONS_FILE = join(homedir(), '.claude', 'orchestrator-missions.json');
const mission = loadMissionRecord(maybeReadJson(MISSIONS_FILE));
`,
  });
  try {
    const findings = checkStateContract(
      root,
      names,
      [
        {
          id: 'orchestrator-missions.json',
          kind: 'internal',
          readers: ['daemon/server.ts'],
          writers: [],
          note: 'the shipped defect',
        },
      ],
      {},
      trackedAlways,
    );
    const fails = findings.filter((f) => f.level === 'FAIL');
    expect(fails).toHaveLength(1);
    expect(fails[0].id).toBe('orchestrator-missions.json');
    expect(fails[0].detail).toContain('written by nothing in it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an artifact nobody declared is a FAIL, naming the files that touch it', () => {
  const { root, names } = fixture({
    'daemon/server.ts': `const F = join(dir, 'brand-new-ledger.json');`,
  });
  try {
    const fails = checkStateContract(root, names, [], {}, trackedAlways);
    expect(fails).toHaveLength(1);
    expect(fails[0].id).toBe('brand-new-ledger.json');
    expect(fails[0].detail).toContain('daemon/server.ts');
    expect(fails[0].detail).toContain('name its writer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a writer that stops writing turns red — the migration this locks', () => {
  const { root, names } = fixture({
    'daemon/server.ts': `const F = join(dir, 'ledger.json');`,
    // The writer still exists as a file but no longer touches the artifact,
    // which is precisely what "the writer stayed on the old host" looks like.
    'orchestrator/writer.sh': `echo unrelated`,
  });
  try {
    const registry: Artifact[] = [
      {
        id: 'ledger.json',
        kind: 'internal',
        readers: ['daemon/server.ts'],
        writers: ['orchestrator/writer.sh'],
        note: 'fixture',
      },
    ];
    const fails = checkStateContract(root, names, registry, {}, trackedAlways);
    expect(fails).toHaveLength(1);
    expect(fails[0].detail).toContain('no longer references it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a new consumer of a declared artifact must be declared too', () => {
  const { root, names } = fixture({
    'orchestrator/writer.sh': `printf x > "$dir/ledger.json"`,
    'daemon/newcomer.ts': `readFileSync(join(dir, 'ledger.json'));`,
  });
  try {
    const registry: Artifact[] = [
      {
        id: 'ledger.json',
        kind: 'internal',
        readers: [],
        writers: ['orchestrator/writer.sh'],
        note: 'fixture',
      },
    ];
    const fails = checkStateContract(root, names, registry, {}, trackedAlways);
    expect(fails).toHaveLength(1);
    expect(fails[0].detail).toContain('daemon/newcomer.ts references it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('external artifacts must name their owner and must not be written here', () => {
  const { root, names } = fixture({
    'orchestrator/launch.sh': `config="$HOME/.claude.json"`,
  });
  try {
    const anonymous = checkStateContract(
      root,
      names,
      [
        {
          id: '.claude.json',
          kind: 'external',
          readers: ['orchestrator/launch.sh'],
          writers: [],
          note: 'fixture',
        },
      ],
      {},
      trackedAlways,
    );
    expect(anonymous.map((f) => f.detail).join()).toContain(
      'must name the program that owns them',
    );

    const contradiction = checkStateContract(
      root,
      names,
      [
        {
          id: '.claude.json',
          kind: 'external',
          owner: 'Claude Code CLI',
          readers: [],
          writers: ['orchestrator/launch.sh'],
          note: 'fixture',
        },
      ],
      {},
      trackedAlways,
    );
    expect(contradiction.map((f) => f.detail).join()).toContain(
      'reclassify it as internal',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo-file that is not tracked in git is not a repo file', () => {
  const { root, names } = fixture({
    'stand/run-acceptance.sh': `grep -q x "$REPO/daemon/package.json"`,
  });
  try {
    const fails = checkStateContract(
      root,
      names,
      [
        {
          id: 'package.json',
          kind: 'repo-file',
          trackedPath: 'daemon/package.json',
          readers: ['stand/run-acceptance.sh'],
          writers: [],
          note: 'fixture',
        },
      ],
      {},
      () => false,
    );
    expect(fails.map((f) => f.detail).join()).toContain('not tracked in git');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a known gap that has been fixed must be removed, not left to rot', () => {
  const { root, names } = fixture({
    'daemon/server.ts': `const F = join(dir, 'ledger.json');`,
  });
  try {
    // Gap entry for an artifact that is also declared: contract closed.
    const closed = checkStateContract(
      root,
      names,
      [
        {
          id: 'ledger.json',
          kind: 'internal',
          readers: ['daemon/server.ts'],
          writers: ['daemon/server.ts'],
          note: 'fixture',
        },
      ],
      { 'ledger.json': 'stale' },
      trackedAlways,
    );
    expect(closed.map((f) => f.detail).join()).toContain('remove the gap entry');

    // Gap entry for an artifact nothing references any more.
    const vanished = checkStateContract(
      root,
      names,
      [],
      { 'gone.json': 'stale' },
      trackedAlways,
    );
    expect(vanished.map((f) => f.detail).join()).toContain('delete the entry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The gap list is a closed set, not an escape hatch. Parking a NEW broken
// contract in KNOWN_GAPS requires editing this assertion too, which is a
// review event rather than a silent waiver.
test('KNOWN_GAPS is exactly the frozen set', () => {
  // quota-latest.jsonl and triage.jsonl were added when the sweep was widened
  // to .jsonl (see the EXT note in check.ts). Neither is a new breakage: both
  // readers already existed and the extension was simply invisible to the
  // regex. quota-latest.jsonl is declared by the lane that restored its reader
  // (daemon/vendor-login.ts); triage.jsonl was uncovered by the same widening.
  expect(Object.keys(KNOWN_GAPS).sort()).toEqual([
    'orchestrator-state.json',
    'quota-latest.jsonl',
    'triage.jsonl',
  ]);
  for (const reason of Object.values(KNOWN_GAPS)) {
    expect(reason.length).toBeGreaterThan(80);
  }
});

test('comments are not accesses, and shell case patterns are not comments', () => {
  expect(stripComments("// join(d, 'retired.json')\nconst x = 1;", 'a.ts')).not.toContain(
    'retired.json',
  );
  // `/*)` opens a block comment in TS but is a case pattern in shell.
  const shell = `  /*) lock_file="$git_dir/bpa-land.lock" ;;`;
  expect(stripComments(shell, 'gate/land.sh')).toContain('bpa-land.lock');
  expect(stripComments(shell, 'gate/land.ts')).not.toContain('bpa-land.lock');
});

test('shell defaults expose the real path; bare interpolation collapses to VAR', () => {
  expect(
    normalizeInterpolation('"${ORCH_LEASE_FILE:-$RUNTIME_DIR/orchestrator.lease}"'),
  ).toContain('/orchestrator.lease');
  expect(normalizeInterpolation('`orchestrator-chat-${chatId}.lock`')).toContain(
    'orchestrator-chat-VAR.lock',
  );
  expect(
    normalizeInterpolation('"$HOME/.claude/orchestrator-chat-$CHAT_ID.lock"'),
  ).toContain('orchestrator-chat-VAR.lock');
});

// An mktemp staging sibling belongs to the artifact it stages for. The point of
// these three is that absorbing it must not blunt the checker: the parent is
// still required to be declared, and a dot-prefixed name WITHOUT the mktemp
// template is still an undeclared artifact.
test('an mktemp temp sibling is the parent artifact, not a new one', () => {
  const { root, names } = fixture({
    // Verbatim shape of orchestrator/watchdog.sh write_lease_state().
    'orchestrator/watchdog.sh': `LEASE_FILE="\${ORCH_LEASE_FILE:-$RUNTIME_DIR/orchestrator.lease}"
write_lease_state() {
  local owner="$1" token="$2" tmp
  tmp="$(mktemp "$(dirname "$LEASE_FILE")/.orchestrator.lease.XXXXXX")"
  printf 'owner=%s\\n' "$owner" > "$tmp"
  mv -f "$tmp" "$LEASE_FILE"
}`,
  });
  try {
    const found = sweepArtifacts(root, names);
    expect([...found.keys()]).toEqual(['orchestrator.lease']);

    const fails = checkStateContract(
      root,
      names,
      [
        {
          id: 'orchestrator.lease',
          kind: 'internal',
          readers: ['orchestrator/watchdog.sh'],
          writers: ['orchestrator/watchdog.sh'],
          note: 'fixture',
        },
      ],
      {},
      trackedAlways,
    );
    expect(fails).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the temp sibling does NOT excuse an undeclared parent', () => {
  const { root, names } = fixture({
    'orchestrator/writer.sh': `tmp="$(mktemp "$(dirname "$F")/.brand-new-ledger.json.XXXXXX")"
mv -f "$tmp" "$F"`,
  });
  try {
    const fails = checkStateContract(root, names, [], {}, trackedAlways);
    expect(fails).toHaveLength(1);
    // Reported as the real artifact, so the registry entry that closes it is
    // the durable one — not the transient.
    expect(fails[0].id).toBe('brand-new-ledger.json');
    expect(fails[0].detail).toContain('name its writer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dot-prefixed artifact with no mktemp template is still a FAIL', () => {
  // The escape-hatch guard: "starts with a dot" must never be enough.
  expect(collapseAtomicTempSiblings('"$dir/.hidden-ledger.json"')).toContain(
    '.hidden-ledger.json',
  );
  // Fewer than three X is not an mktemp template either.
  expect(collapseAtomicTempSiblings('"$dir/.hidden-ledger.json.XX"')).toContain(
    '.hidden-ledger.json',
  );

  const { root, names } = fixture({
    'daemon/server.ts': `const F = join(dir, '.hidden-ledger.json');`,
  });
  try {
    const fails = checkStateContract(root, names, [], {}, trackedAlways);
    expect(fails).toHaveLength(1);
    expect(fails[0].id).toBe('.hidden-ledger.json');
    expect(fails[0].detail).toContain('undeclared durable state artifact');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the sweep ignores test files and frozen migration references', () => {
  const { root, names } = fixture({
    'daemon/thing.test.ts': `join(d, 'fixture-only.json')`,
    'migration-prep/old.sh': `cat "$d/legacy.json"`,
    'soak/chaos.sh': `db="$fixture/throwaway.db"`,
    'daemon/real.ts': `join(d, 'real.json')`,
  });
  try {
    const found = sweepArtifacts(root, names);
    expect([...found.keys()]).toEqual(['real.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Integration: the live repository must satisfy its own contract.
test('this repository passes its own state contract', () => {
  const root = join(import.meta.dir, '..', '..');
  const ls = Bun.spawnSync(['git', '-C', root, 'ls-files', '*.ts', '*.sh']);
  const files = new TextDecoder()
    .decode(ls.stdout)
    .split('\n')
    .filter(Boolean);
  expect(files.length).toBeGreaterThan(20);
  const trackedOut = Bun.spawnSync(['git', '-C', root, 'ls-files']);
  const tracked = new Set(
    new TextDecoder().decode(trackedOut.stdout).split('\n').filter(Boolean),
  );
  const findings = checkStateContract(root, files, REGISTRY, KNOWN_GAPS, (p) =>
    tracked.has(p),
  );
  const fails = findings.filter((f) => f.level === 'FAIL');
  expect(fails.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);

  // And the retired ledger must be gone from the source entirely: if it comes
  // back as a live reference, it is undeclared and rule 1 turns this red.
  const found = sweepArtifacts(root, files);
  expect(found.has('orchestrator-missions.json')).toBe(false);

  // state.db must have a writer, or the mission input is disarmed again.
  const stateDb = REGISTRY.find((a) => a.id === 'state.db');
  expect(stateDb?.writers).toContain('core/mission-cli.ts');
  expect(stateDb?.readers).toContain('daemon/mission-source.ts');
});
