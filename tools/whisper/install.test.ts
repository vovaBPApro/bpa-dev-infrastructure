// tools/whisper/install.test.ts — proves tools/whisper/install.sh is
// idempotent and fails closed, WITHOUT touching this host's real
// /opt/whisper.cpp (which is load-bearing for the operator's voice
// messages today) and WITHOUT depending on network access to GitHub or
// Hugging Face:
//
//   - the whisper.cpp SOURCE fetch is redirected to a local git repo via
//     `url.<local>.insteadOf` (git honors this for any URL argument,
//     including the direct `git ls-remote <url>` call, not only named
//     remotes);
//   - the MODEL download is redirected to a local directory via
//     WHISPER_HF_BASE and curl's real file:// support — no HTTP stub
//     needed, curl already fails realistically (exit 37, "Couldn't open
//     file") against a missing path;
//   - the whisper.cpp BUILD is stubbed with a fake `cmake` placed first on
//     PATH (real whisper.cpp source is not fetched — the fixture upstream
//     repo is a one-file placeholder — so a real cmake build cannot and
//     should not run in this suite); the fake `whisper-cli` it produces is
//     a bash script, not a real speech model;
//   - espeak-ng, ffmpeg, git, curl, sha256sum and coreutils `install` are
//     the REAL host binaries — only the parts that would otherwise require
//     network + a multi-minute C++ build + a ~1.5 GB download are faked.
//
// This suite cannot prove the real whisper.cpp source actually builds or
// that a genuine model actually transcribes — that was last verified for
// this installer against a real clean container (see
// reports/meteorite-test.md on v2-deprecated, "I followed the committed
// Whisper installer for real"). What THIS suite proves is the contract
// this row's acceptance test cares about: idempotency, post-install
// binary verification, and fail-closed behavior on every failure path.

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSTALLER = join(import.meta.dir, 'install.sh');
const VERSION = 'v1.9.1';
const REPO_URL = 'https://github.com/ggml-org/whisper.cpp';
const scratchDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-install-test-'));
  scratchDirs.push(dir);
  return dir;
}

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

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A one-file placeholder "upstream" whisper.cpp repo, tagged v1.9.1. */
function makeUpstream(): { dir: string; commit: string } {
  const scratch = scratchDir();
  const dir = join(scratch, 'upstream');
  mkdirSync(dir);
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.name', 'Whisper Installer Test']);
  git(dir, ['config', 'user.email', 'whisper-installer@test.invalid']);
  writeFileSync(join(dir, 'README'), 'placeholder whisper.cpp source\n');
  git(dir, ['add', 'README']);
  git(dir, ['commit', '-qm', 'placeholder release']);
  const commit = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['tag', VERSION]);
  return { dir, commit };
}

// Lines only — deliberately not a template literal, so nothing in the
// generated bash (`${...}`, backticks) is misread as TS interpolation.
const CMAKE_STUB_LINES = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'if [[ "${1:-}" == "--build" ]]; then',
  '  build_dir="$2"',
  '  if [[ "${STUB_CMAKE_FAIL_BUILD:-0}" == "1" ]]; then',
  '    echo "stub cmake: simulated build failure" >&2',
  '    exit 1',
  '  fi',
  '  mkdir -p "$build_dir/bin"',
  '  bin="$build_dir/bin/whisper-cli"',
  '  if [[ "${STUB_CMAKE_BROKEN_BINARY:-0}" == "1" ]]; then',
  '    printf \'#!/usr/bin/env bash\\nexit 1\\n\' > "$bin"',
  '  else',
  '    {',
  '      printf \'#!/usr/bin/env bash\\n\'',
  '      printf \'if [[ "${1:-}" == "--version" ]]; then\\n\'',
  '      printf \'  echo "whisper.cpp fake-stub build (test fixture) 1.9.1"\\n\'',
  '      printf \'  exit 0\\n\'',
  '      printf \'fi\\n\'',
  '      printf \'of=""\\n\'',
  '      printf \'prev=""\\n\'',
  '      printf \'for a in "$@"; do\\n\'',
  '      printf \'  if [[ "$prev" == "-of" ]]; then of="$a"; fi\\n\'',
  '      printf \'  prev="$a"\\n\'',
  '      printf \'done\\n\'',
  '      printf \'[[ -n "$of" ]] && echo "stub transcription output testing one two three" > "${of}.txt"\\n\'',
  '      printf \'exit 0\\n\'',
  '    } > "$bin"',
  '  fi',
  '  chmod +x "$bin"',
  '  exit 0',
  'fi',
  '# configure invocation: cmake -S <src> -B <build> ...',
  'build_dir=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [[ "$prev" == "-B" ]]; then build_dir="$a"; fi',
  '  prev="$a"',
  'done',
  '[[ -n "$build_dir" ]] && mkdir -p "$build_dir"',
  'exit 0',
  '',
].join('\n');

function makeCmakeStubDir(): string {
  const scratch = scratchDir();
  const dir = join(scratch, 'stub-bin');
  mkdirSync(dir);
  writeFileSync(join(dir, 'cmake'), CMAKE_STUB_LINES);
  chmodSync(join(dir, 'cmake'), 0o755);
  return dir;
}

/** A local model directory served to the installer via WHISPER_HF_BASE. */
function makeModelFixture(): {
  dir: string;
  largeSha: string;
  mediumSha: string;
} {
  const scratch = scratchDir();
  const dir = join(scratch, 'hf');
  mkdirSync(dir);
  const large = new TextEncoder().encode('fixture primary model bytes\n');
  const medium = new TextEncoder().encode('fixture fallback model bytes\n');
  writeFileSync(join(dir, 'ggml-large-v3-turbo.bin'), large);
  writeFileSync(join(dir, 'ggml-medium.bin'), medium);
  return {
    dir,
    largeSha: sha256Hex(large),
    mediumSha: sha256Hex(medium),
  };
}

type EnvOverrides = Record<string, string | undefined>;

function baseEnv(upstreamDir: string, overrides: EnvOverrides): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${upstreamDir}.insteadOf`,
    GIT_CONFIG_VALUE_0: REPO_URL,
    WHISPER_NO_APT: '1',
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(env: Record<string, string>) {
  const result = Bun.spawnSync(['bash', INSTALLER], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    output: `${result.stdout}${result.stderr}`,
  };
}

// ── moved-tag provenance (ported: the pin must be re-checked on every run,
//    both on a first install and on the idempotent skip path) ─────────────

describe('release-tag provenance', () => {
  function movedTagEnv(prefix: string, stubBin: string, installed: boolean) {
    const { dir: upstream, commit: movedCommit } = makeUpstream();
    const pinnedCommit = '0'.repeat(40);
    expect(movedCommit).not.toBe(pinnedCommit);

    mkdirSync(stubBin, { recursive: true });
    // A PATH-level /bin/false curl and a marker-touching espeak-ng prove no
    // download or smoke-transcription is attempted before the provenance
    // check fails.
    Bun.spawnSync(['ln', '-s', '/bin/false', join(stubBin, 'curl')]);
    writeFileSync(
      join(stubBin, 'espeak-ng'),
      '#!/usr/bin/env bash\ntouch "$SMOKE_MARKER"\nexit 99\n',
    );
    chmodSync(join(stubBin, 'espeak-ng'), 0o755);

    if (installed) {
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      const r = Bun.spawnSync([
        'install',
        '-m',
        '0755',
        '/bin/true',
        join(prefix, 'bin', 'whisper-cli'),
      ]);
      expect(r.exitCode).toBe(0);
      writeFileSync(join(prefix, '.version'), `${VERSION}@${pinnedCommit}\n`);
    }

    const smokeMarker = join(prefix, '..', 'smoke-started');
    const env = baseEnv(upstream, {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      WHISPER_PREFIX: prefix,
      WHISPER_SKIP_MEDIUM: '1',
      WHISPER_COMMIT: pinnedCommit,
      SMOKE_MARKER: smokeMarker,
    });
    return { env, movedCommit, pinnedCommit, smokeMarker };
  }

  test('refuses a moved release tag before a fresh build or download', () => {
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');
    const stubBin = join(scratch, 'stub-bin');
    const { env, movedCommit, pinnedCommit, smokeMarker } = movedTagEnv(
      prefix,
      stubBin,
      false,
    );

    const { exitCode, output } = run(env);

    expect(exitCode).not.toBe(0);
    expect(output).toContain(
      `[whisper-install] FAIL: tag ${VERSION} moved: remote says ${movedCommit}, pinned ${pinnedCommit} — refusing to build`,
    );
    expect(existsSync(join(prefix, 'bin', 'whisper-cli'))).toBe(false);
    expect(
      existsSync(join(prefix, 'models', 'ggml-large-v3-turbo.bin.part')),
    ).toBe(false);
    expect(existsSync(smokeMarker)).toBe(false);
  });

  test('refuses a moved release tag on the idempotent installed path', () => {
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');
    const stubBin = join(scratch, 'stub-bin');
    const { env, movedCommit, pinnedCommit, smokeMarker } = movedTagEnv(
      prefix,
      stubBin,
      true,
    );

    const { exitCode, output } = run(env);

    expect(exitCode).not.toBe(0);
    expect(output).toContain(
      `[whisper-install] FAIL: tag ${VERSION} moved: remote says ${movedCommit}, pinned ${pinnedCommit} — refusing to build`,
    );
    // The pre-seeded marker is untouched — the moved-tag check ran and
    // failed BEFORE the installed-binary skip logic ever looked at it.
    expect(readFileSync(join(prefix, '.version'), 'utf8')).toBe(
      `${VERSION}@${pinnedCommit}\n`,
    );
    expect(existsSync(smokeMarker)).toBe(false);
  });
});

// ── idempotency and post-install verification ──────────────────────────────

describe('idempotency and binary verification', () => {
  test('a clean install builds, verifies --version, downloads and verifies the model, and smoke-transcribes', () => {
    const { dir: upstream, commit } = makeUpstream();
    const stubBin = makeCmakeStubDir();
    const { dir: hf, largeSha, mediumSha } = makeModelFixture();
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');

    const env = baseEnv(upstream, {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      WHISPER_PREFIX: prefix,
      WHISPER_COMMIT: commit,
      WHISPER_BUILD_JOBS: '1',
      WHISPER_HF_BASE: `file://${hf}`,
      WHISPER_LARGE_SHA256: largeSha,
      WHISPER_MEDIUM_SHA256: mediumSha,
    });

    const { exitCode, output } = run(env);

    expect(exitCode).toBe(0);
    expect(output).toContain('OK — whisper stack is live at');
    expect(output).toContain('smoke transcription output');
    expect(existsSync(join(prefix, 'bin', 'whisper-cli'))).toBe(true);
    expect(readFileSync(join(prefix, '.version'), 'utf8')).toBe(
      `${VERSION}@${commit}\n`,
    );
    expect(
      readFileSync(join(prefix, 'models', 'ggml-large-v3-turbo.bin')),
    ).toEqual(readFileSync(join(hf, 'ggml-large-v3-turbo.bin')));
  });

  test('a second run skips the build and the download entirely', () => {
    const { dir: upstream, commit } = makeUpstream();
    const stubBin = makeCmakeStubDir();
    const { dir: hf, largeSha, mediumSha } = makeModelFixture();
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');

    const env = baseEnv(upstream, {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      WHISPER_PREFIX: prefix,
      WHISPER_COMMIT: commit,
      WHISPER_BUILD_JOBS: '1',
      WHISPER_HF_BASE: `file://${hf}`,
      WHISPER_LARGE_SHA256: largeSha,
      WHISPER_MEDIUM_SHA256: mediumSha,
    });

    const first = run(env);
    expect(first.exitCode).toBe(0);

    // Poison the expensive steps before the second run: if the installer
    // re-invokes cmake or re-downloads the model despite the matching
    // marker and checksums, the second run must fail loudly rather than
    // silently redoing work.
    writeFileSync(join(stubBin, 'cmake'), '#!/usr/bin/env bash\nexit 97\n');
    chmodSync(join(stubBin, 'cmake'), 0o755);
    const poisonedEnv = { ...env, WHISPER_HF_BASE: 'file:///nonexistent-hf-mirror' };

    const second = run(poisonedEnv);

    expect(second.exitCode).toBe(0);
    expect(second.output).toContain(
      `whisper-cli ${VERSION}@${commit} already installed and verified`,
    );
    expect(second.output).toContain(
      'model ggml-large-v3-turbo.bin already present and verified',
    );
    expect(second.output).toContain(
      'model ggml-medium.bin already present and verified',
    );
    expect(second.output).not.toContain('stub cmake');
    expect(second.output).toContain('OK — whisper stack is live at');
  });

  test('rebuilds when the marker matches but the installed binary fails --version', () => {
    const { dir: upstream, commit } = makeUpstream();
    const stubBin = makeCmakeStubDir();
    const { dir: hf, largeSha, mediumSha } = makeModelFixture();
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeFileSync(
      join(prefix, 'bin', 'whisper-cli'),
      '#!/usr/bin/env bash\nexit 1\n',
    );
    chmodSync(join(prefix, 'bin', 'whisper-cli'), 0o755);
    writeFileSync(join(prefix, '.version'), `${VERSION}@${commit}\n`);

    const env = baseEnv(upstream, {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      WHISPER_PREFIX: prefix,
      WHISPER_COMMIT: commit,
      WHISPER_BUILD_JOBS: '1',
      WHISPER_HF_BASE: `file://${hf}`,
      WHISPER_LARGE_SHA256: largeSha,
      WHISPER_MEDIUM_SHA256: mediumSha,
    });

    const { exitCode, output } = run(env);

    expect(output).toContain(
      `marker present but the installed binary failed --version — rebuilding`,
    );
    expect(exitCode).toBe(0);
    // The rebuilt binary now genuinely passes --version.
    const check = Bun.spawnSync([join(prefix, 'bin', 'whisper-cli'), '--version']);
    expect(check.exitCode).toBe(0);
  });
});

// ── fail-closed on every failure path ───────────────────────────────────────

describe('fail-closed behavior', () => {
  test('a build failure is reported clearly and installs nothing', () => {
    const { dir: upstream, commit } = makeUpstream();
    const stubBin = makeCmakeStubDir();
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');

    const env = baseEnv(upstream, {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      WHISPER_PREFIX: prefix,
      WHISPER_COMMIT: commit,
      WHISPER_BUILD_JOBS: '1',
      WHISPER_SKIP_MEDIUM: '1',
      STUB_CMAKE_FAIL_BUILD: '1',
    });

    const { exitCode, output } = run(env);

    expect(exitCode).not.toBe(0);
    expect(output).toContain('[whisper-install] FAIL: build failed');
    expect(existsSync(join(prefix, 'bin', 'whisper-cli'))).toBe(false);
    expect(existsSync(join(prefix, '.version'))).toBe(false);
  });

  test('a freshly built binary that cannot execute is reported clearly, and the marker is withheld', () => {
    const { dir: upstream, commit } = makeUpstream();
    const stubBin = makeCmakeStubDir();
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');

    const env = baseEnv(upstream, {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      WHISPER_PREFIX: prefix,
      WHISPER_COMMIT: commit,
      WHISPER_BUILD_JOBS: '1',
      WHISPER_SKIP_MEDIUM: '1',
      STUB_CMAKE_BROKEN_BINARY: '1',
    });

    const { exitCode, output } = run(env);

    expect(exitCode).not.toBe(0);
    expect(output).toContain(
      'installed binary failed to execute: ' +
        join(prefix, 'bin', 'whisper-cli') +
        ' --version (build produced a broken binary)',
    );
    // Never trust the marker for a binary that failed verification: the
    // next run must retry the build, not silently skip it.
    expect(existsSync(join(prefix, '.version'))).toBe(false);
  });

  test('a model download failure is reported clearly and leaves no partial file', () => {
    const { dir: upstream, commit } = makeUpstream();
    const stubBin = makeCmakeStubDir();
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');

    const env = baseEnv(upstream, {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      WHISPER_PREFIX: prefix,
      WHISPER_COMMIT: commit,
      WHISPER_BUILD_JOBS: '1',
      WHISPER_SKIP_MEDIUM: '1',
      WHISPER_HF_BASE: 'file:///nonexistent-hf-mirror',
    });

    const { exitCode, output } = run(env);

    expect(exitCode).not.toBe(0);
    expect(output).toContain(
      '[whisper-install] FAIL: download of ggml-large-v3-turbo.bin failed',
    );
    expect(existsSync(join(prefix, 'models', 'ggml-large-v3-turbo.bin'))).toBe(
      false,
    );
    expect(
      existsSync(join(prefix, 'models', 'ggml-large-v3-turbo.bin.part')),
    ).toBe(false);
    // The binary itself installed fine — only the model step failed.
    expect(existsSync(join(prefix, 'bin', 'whisper-cli'))).toBe(true);
  });

  test('a model checksum mismatch is reported clearly and never installs the file', () => {
    const { dir: upstream, commit } = makeUpstream();
    const stubBin = makeCmakeStubDir();
    const { dir: hf } = makeModelFixture();
    const scratch = scratchDir();
    const prefix = join(scratch, 'prefix');

    const env = baseEnv(upstream, {
      PATH: `${stubBin}:${process.env.PATH ?? ''}`,
      WHISPER_PREFIX: prefix,
      WHISPER_COMMIT: commit,
      WHISPER_BUILD_JOBS: '1',
      WHISPER_SKIP_MEDIUM: '1',
      WHISPER_HF_BASE: `file://${hf}`,
      // No WHISPER_LARGE_SHA256 override: the fixture bytes are checked
      // against the real pinned production hash, which they cannot match.
    });

    const { exitCode, output } = run(env);

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(
      /\[whisper-install\] FAIL: ggml-large-v3-turbo\.bin sha256 mismatch: got [0-9a-f]{64} want [0-9a-f]{64} \(refusing to install\)/,
    );
    expect(existsSync(join(prefix, 'models', 'ggml-large-v3-turbo.bin'))).toBe(
      false,
    );
    expect(
      existsSync(join(prefix, 'models', 'ggml-large-v3-turbo.bin.part')),
    ).toBe(false);
  });
});
