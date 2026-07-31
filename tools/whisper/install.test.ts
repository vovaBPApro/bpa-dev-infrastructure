import { afterEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const INSTALLER = join(import.meta.dir, 'install.sh');
const PINNED_COMMIT = '0000000000000000000000000000000000000000';
const VERSION = 'v1.9.1';
const scratchDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

function movedTagFixture(installed: boolean): {
  prefix: string;
  run: ReturnType<typeof Bun.spawnSync>;
  scratch: string;
} {
  const scratch = mkdtempSync(join(tmpdir(), 'whisper-install-test-'));
  scratchDirs.push(scratch);
  const upstream = join(scratch, 'upstream');
  const prefix = join(scratch, 'prefix');
  const stubBin = join(scratch, 'stub-bin');
  const smokeMarker = join(scratch, 'smoke-started');

  mkdirSync(upstream);
  mkdirSync(stubBin);
  git(upstream, ['init', '-q']);
  git(upstream, ['config', 'user.name', 'Whisper Installer Test']);
  git(upstream, ['config', 'user.email', 'whisper-installer@test.invalid']);
  writeFileSync(join(upstream, 'README'), 'moved release tag\n');
  git(upstream, ['add', 'README']);
  git(upstream, ['commit', '-qm', 'moved tag target']);
  const movedCommit = git(upstream, ['rev-parse', 'HEAD']);
  expect(movedCommit).not.toBe(PINNED_COMMIT);
  git(upstream, ['tag', VERSION]);

  // A PATH-level /bin/false curl proves no model download is attempted.
  symlinkSync('/bin/false', join(stubBin, 'curl'));
  writeFileSync(
    join(stubBin, 'espeak-ng'),
    `#!/usr/bin/env bash
touch ${JSON.stringify(smokeMarker)}
exit 99
`,
  );
  chmodSync(join(stubBin, 'espeak-ng'), 0o755);

  if (installed) {
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    const installMarker = Bun.spawnSync([
      'install',
      '-m',
      '0755',
      '/bin/true',
      join(prefix, 'bin', 'whisper-cli'),
    ]);
    expect(installMarker.exitCode).toBe(0);
    writeFileSync(join(prefix, '.version'), `${VERSION}@${PINNED_COMMIT}\n`);
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    PATH: `${stubBin}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${upstream}.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/ggml-org/whisper.cpp',
    WHISPER_PREFIX: prefix,
    WHISPER_NO_APT: '1',
    WHISPER_SKIP_MEDIUM: '1',
    WHISPER_COMMIT: PINNED_COMMIT,
  });

  const run = Bun.spawnSync(['bash', '-x', INSTALLER], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const output = `${run.stdout}${run.stderr}`;
  expect(run.exitCode).not.toBe(0);
  expect(output).toContain(
    `[whisper-install] FAIL: tag ${VERSION} moved: remote says ${movedCommit}, pinned ${PINNED_COMMIT} — refusing to build`,
  );
  expect(output).not.toContain('+ curl ');
  expect(output).not.toContain(`+ ${join(prefix, 'bin', 'whisper-cli')} `);
  expect(existsSync(join(prefix, 'models', 'ggml-large-v3-turbo.bin.part'))).toBe(
    false,
  );
  expect(existsSync(smokeMarker)).toBe(false);

  return { prefix, run, scratch };
}

test('refuses a moved release tag before a fresh build or download', () => {
  const { prefix } = movedTagFixture(false);
  expect(existsSync(join(prefix, 'bin', 'whisper-cli'))).toBe(false);
});

test('refuses a moved release tag on the idempotent installed path', () => {
  const { prefix } = movedTagFixture(true);
  expect(readFileSync(join(prefix, '.version'), 'utf8')).toBe(
    `${VERSION}@${PINNED_COMMIT}\n`,
  );
});
