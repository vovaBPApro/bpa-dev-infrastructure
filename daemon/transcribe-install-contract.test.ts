// The cross-file contract that makes voice transcription survive a rebuild.
//
// daemon/transcribe.ts resolves a binary and a model from HOST paths it does
// not create; tools/whisper/install.sh creates them; bootstrap/install.sh is
// what causes the installer to run on a clean server. Those three files are
// edited independently, and each one is individually correct while pointing
// somewhere the other two do not. That is the failure this file locks: not
// "does whisper work here", which is a live-host question the meteorite's
// `whisper` stage answers, but "does the tree still describe ONE layout".
//
// Deliberately derived, never restated: the expected paths below are PARSED
// out of the installer rather than typed here. A fourth copy of
// /opt/whisper.cpp would be one more thing to drift, and a test carrying its
// own copy of both sides of a contract cannot detect either side moving.
// Every parse fails loudly when its shape is gone, so a rewritten installer
// makes this file red rather than quietly unenforced.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveWhisperConfig } from './transcribe';

const REPO = join(import.meta.dir, '..');
const INSTALLER = 'tools/whisper/install.sh';
const BOOTSTRAP = 'bootstrap/install.sh';
const METEORITE = 'meteorite/run.sh';

function read(relative: string): string {
  return readFileSync(join(REPO, relative), 'utf8');
}

/** Lines with comments and blank lines removed — code, not prose about code. */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

/** One capture from one file, or a named failure — never a silent skip. */
function extract(relative: string, pattern: RegExp, what: string): string {
  const match = read(relative).match(pattern);
  if (!match?.[1]) {
    throw new Error(
      `${relative} no longer states ${what} in a shape this lock can read (${pattern}); ` +
        'the whisper layout contract is unenforced until this parse is repaired',
    );
  }
  return match[1];
}

// The installer's own description of where it puts things.
const installedPrefix = () =>
  extract(INSTALLER, /^PREFIX="\$\{WHISPER_PREFIX:-([^}"]+)\}"/m, 'its default install prefix');
const installedBinary = () =>
  extract(
    INSTALLER,
    /install -m 0755 [^\n]*"\$PREFIX\/bin\/([A-Za-z0-9._-]+)"/,
    'where it installs the whisper CLI',
  );
const modelDirectory = () =>
  extract(INSTALLER, /dest="\$PREFIX\/([A-Za-z0-9._-]+)\/\$1"/, 'where it installs models');
const primaryModel = () =>
  extract(INSTALLER, /fetch_model "([A-Za-z0-9._-]+)" "\$LARGE_V3_TURBO_SHA256"/, 'its primary model');

test('the daemon resolves exactly what the tracked installer installs', () => {
  const prefix = installedPrefix();
  const cfg = resolveWhisperConfig({});

  expect(cfg.bin).toBe(`${prefix}/bin/${installedBinary()}`);
  expect(cfg.model).toBe(`${prefix}/${modelDirectory()}/${primaryModel()}`);
});

test('an ORCH_WHISPER_PREFIX override moves both resolved paths together', () => {
  // The runtime family (ORCH_WHISPER_*) and the installer family (WHISPER_*)
  // are independent on purpose, so the only thing a test can hold them to is
  // that each side keeps its own shape. Here: the daemon's prefix override
  // must still compose the same layout, or a host installed under a
  // non-default prefix resolves half of it.
  const cfg = resolveWhisperConfig({ ORCH_WHISPER_PREFIX: '/srv/stt' });
  expect(cfg.bin).toBe(`/srv/stt/bin/${installedBinary()}`);
  expect(cfg.model).toBe(`/srv/stt/${modelDirectory()}/${primaryModel()}`);
});

test('bootstrap runs the tracked installer, so a clean server produces that layout', () => {
  const code = codeLines(read(BOOTSTRAP));

  // The path bootstrap trusts, stated once and pointing at the tracked file.
  expect(code).toContain(`WHISPER_INSTALLER="$INSTALL_ROOT/${INSTALLER}"`);
  // It is EXECUTED, not merely mentioned.
  expect(code).toContain('if ! bash "$WHISPER_INSTALLER"; then');
  // And the step is wired into the sequence a real install runs, not just
  // defined where only a test can reach it.
  expect(code).toContain('install_whisper() {');
  expect(code.filter((line) => line === 'install_whisper')).toHaveLength(1);
});

test('bootstrap fails closed when the installer cannot be run', () => {
  // Both refusals name the file, so an operator reading a failed rebuild is
  // told which mechanism is missing rather than that "bootstrap failed".
  const bootstrap = read(BOOTSTRAP);
  expect(bootstrap).toContain('ERROR: whisper installer is missing or unreadable: $WHISPER_INSTALLER');
  expect(bootstrap).toContain('ERROR: whisper installation failed: $WHISPER_INSTALLER');
});

test('the meteorite measures the rebuilt layout through the daemon resolver', () => {
  const stage = codeLines(read(METEORITE)).find((line) => line.startsWith('"whisper|'));
  if (!stage) {
    throw new Error(
      `${METEORITE} has no \`whisper\` stage — a rebuild proof that never checks transcription ` +
        'reports clean on a host that comes up mute',
    );
  }
  // It asks daemon/transcribe.ts rather than restating the paths, which is
  // what makes the two defaults drifting apart a meteorite failure.
  expect(stage).toContain('./daemon/transcribe.ts');
  expect(stage).toContain('resolveWhisperConfig');
  expect(stage).toContain('whisperAvailable');
  expect(stage).toContain(INSTALLER);
});
